// Visual inspection loop for UI-touching runs. Detects pixel-level regressions
// in component changes via Playwright + pixelmatch. On revision round, feeds
// findings back to Claude with form/button interaction suggestions.
//
// Spec: detect-only mode default, threshold 5% (pixelmatch tolerance 0.1),
// routes inferred from file imports + fallback list, mobile viewport 390x844
// (iPhone 14), max 2 revision rounds.
// Stores results in oceanBotRun.metadata.visualStatus (no schema migration).
//
// Baselines: ~/.ocean-bot/visual-inspect/baselines/<slug>/<route-slug>/<viewport>.png
// First run with no baseline captures and returns allGreen (nothing to diff yet).
// Dev server crash after route N: remaining routes marked 'inspect-skipped',
// run proceeds to preflight with a warning badge rather than blocking.

import { chromium, type Page, type BrowserContext } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import * as fs from "fs";
import * as path from "path";
import { log } from "./util/log.js";
import type { VisualInspectConfig } from "./adapters/types.js";

export type { VisualInspectConfig };

export interface VisualInspectResult {
  ranAt: string;
  detectOnly: boolean;
  routes: VisualInspectRouteResult[];
  allGreen: boolean;
  regressions: VisualInspectRouteResult[]; // for quick access
  skipped: number; // routes skipped due to server crash
}

export interface VisualInspectRouteResult {
  route: string;
  status: "green" | "regressed" | "error" | "inspect-skipped";
  viewports: Record<string, ViewportResult>;
  lastError?: string;
}

export interface ViewportResult {
  name: string; // "mobile" | "desktop"
  width: number;
  height: number;
  pixelDiffPercent?: number; // when status !== 'error'
  hasFormFields?: boolean;
  buttonCount?: number;
  screenshotPath?: string; // for operator review on regression
}

export interface VisualInspectFeedback {
  runId: string;
  round: number; // 1 or 2
  findings: {
    route: string;
    viewport: string;
    pixelDiffPercent: number;
    formFields: { name?: string; type: string }[];
    buttons: string[];
    suggestion?: string;
  }[];
  screenshotPaths: string[];
}

const DEFAULT_PIXEL_DIFF_THRESHOLD = 0.05; // 5%
const MOBILE_VIEWPORT = { width: 390, height: 844 }; // iPhone 14
const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };
const PAGE_LOAD_TIMEOUT_MS = 30000;
const STATE_CONSISTENCY_WAIT_MS = 15000;

const VIEWPORTS = [MOBILE_VIEWPORT, DESKTOP_VIEWPORT] as const;

function vpName(vp: { width: number }): string {
  return vp.width === 390 ? "mobile" : "desktop";
}

/** Sanitize a route path like "/dashboard/runs/123" to "dashboard-runs-123" for use in filenames. */
function routeToSlug(route: string): string {
  return route.replace(/^\//, "").replace(/\//g, "-") || "root";
}

export class VisualInspectLoop {
  private baselineDir: string;

  constructor(
    private projectSlug: string,
    private homeDir: string = process.env["HOME"] ?? "",
  ) {
    this.baselineDir = path.join(
      homeDir,
      ".ocean-bot/visual-inspect/baselines",
      projectSlug,
    );
  }

  async shouldRun(
    config: VisualInspectConfig | undefined,
    fileChanges: string[],
  ): Promise<boolean> {
    if (!config?.enabled) return false;
    return fileChanges.some(
      (f) => f.includes("/app/") || f.includes("/src/lib/"),
    );
  }

  /**
   * Infer routes from TypeScript imports in changed files.
   * Looks for patterns like: from "@/lib/dashboard/..."
   * Falls back to adapter's fallbackRoutes if grep finds nothing.
   */
  async inferRoutes(
    changedFiles: string[],
    projectDir: string,
    fallbackRoutes?: string[],
  ): Promise<string[]> {
    const routes = new Set<string>();

    for (const file of changedFiles) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const fullPath = path.join(projectDir, file);
      if (!fs.existsSync(fullPath)) continue;

      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const importRegex = /from\s+["']([@./]*dashboard[^"']*)/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          const importPath = match[1];
          if (!importPath) continue;
          const segment = importPath.split("/").find((p) => p === "dashboard");
          if (segment) routes.add(`/${segment}`);
        }
      } catch (e) {
        log.warn("visual_inspect.inferRoutes failed on file", {
          file,
          err: String(e),
        });
      }
    }

    if (routes.size === 0 && fallbackRoutes) return fallbackRoutes;
    return Array.from(routes).slice(0, 5);
  }

  /** Returns false when the dev server isn't up so we skip gracefully. */
  private async isDevServerReachable(url: string): Promise<boolean> {
    try {
      const resp = await fetch(`${url}/`, {
        method: "HEAD",
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok || resp.status < 500;
    } catch {
      return false;
    }
  }

  /** Baseline path for a route/viewport pair. */
  private baselinePath(route: string, viewport: string): string {
    return path.join(this.baselineDir, routeToSlug(route), `${viewport}.png`);
  }

  /** Current-capture path (overwritten each run). */
  private currentPath(route: string, viewport: string): string {
    return path.join(this.baselineDir, routeToSlug(route), `current-${viewport}.png`);
  }

  /**
   * Capture a full-page screenshot and save it.
   * Returns the saved path, throws on navigation or capture failure.
   */
  private async capture(
    page: Page,
    url: string,
    vp: { width: number; height: number },
    savePath: string,
  ): Promise<void> {
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });
    await page.waitForTimeout(500); // settle animations
    await page.screenshot({ path: savePath, fullPage: true });
  }

  /**
   * Pixel-diff two PNG files using pixelmatch (tolerance 0.1).
   * Returns -1 percent on read/size error so caller marks as 'error'.
   */
  computePixelDiff(
    baselinePng: string,
    currentPng: string,
  ): { pixels: number; percent: number } {
    let baseline: PNG;
    let current: PNG;
    try {
      baseline = PNG.sync.read(fs.readFileSync(baselinePng));
      current = PNG.sync.read(fs.readFileSync(currentPng));
    } catch (e) {
      log.error("visual_inspect.computePixelDiff read failed", { err: String(e) });
      return { pixels: -1, percent: -1 };
    }

    if (baseline.width !== current.width || baseline.height !== current.height) {
      // Size mismatch = worst-case regression signal
      log.warn("visual_inspect.computePixelDiff size_mismatch", {
        baseline: `${baseline.width}x${baseline.height}`,
        current: `${current.width}x${current.height}`,
      });
      return { pixels: -1, percent: 1 };
    }

    const diff = Buffer.alloc(baseline.width * baseline.height * 4);
    const pixels = pixelmatch(
      baseline.data,
      current.data,
      diff,
      baseline.width,
      baseline.height,
      { threshold: 0.1 }, // per-pixel sensitivity
    );
    const percent = pixels / (baseline.width * baseline.height);
    return { pixels, percent };
  }

  /**
   * Detect forms and buttons in the loaded page via Playwright locators.
   * Probing is skipped when neither form elements nor buttons are found.
   */
  async detectFormFields(
    page: Page,
  ): Promise<{ hasFormFields: boolean; buttons: string[] }> {
    try {
      const formCount =
        (await page.locator("form").count()) +
        (await page.locator('[role="form"]').count());
      const hasFormFields = formCount > 0;

      // Cap at 5 buttons to keep the feedback prompt concise.
      const btns = await page.locator('button, [role="button"]').all();
      const labels = await Promise.all(
        btns.slice(0, 5).map((b) => b.textContent().catch(() => null)),
      );
      const buttons = labels
        .filter((l): l is string => typeof l === "string")
        .map((l) => l.trim())
        .filter(Boolean);

      return { hasFormFields, buttons };
    } catch (e) {
      log.warn("visual_inspect.detectFormFields failed", { err: String(e) });
      return { hasFormFields: false, buttons: [] };
    }
  }

  /**
   * Main orchestrator: infer routes, take screenshots, pixel-diff vs baselines.
   * On dev server crash mid-run: remaining routes are 'inspect-skipped'.
   * First run (no baselines): saves baselines, returns allGreen (nothing to diff).
   */
  async run(
    config: VisualInspectConfig,
    fileChanges: string[],
    projectDir: string,
    devServerUrl: string,
    runId: string,
  ): Promise<VisualInspectResult> {
    const detectOnly = config.detectOnly ?? true;
    const threshold = config.pixelDiffThreshold ?? DEFAULT_PIXEL_DIFF_THRESHOLD;

    const routes = await this.inferRoutes(
      fileChanges,
      projectDir,
      config.fallbackRoutes,
    );
    if (routes.length === 0) {
      log.info("visual_inspect.no_routes_inferred", { runId });
      return {
        ranAt: new Date().toISOString(),
        detectOnly,
        routes: [],
        allGreen: true,
        regressions: [],
        skipped: 0,
      };
    }

    const reachable = await this.isDevServerReachable(devServerUrl);
    if (!reachable) {
      log.warn("visual_inspect.dev_server_unreachable", { runId, devServerUrl });
      return {
        ranAt: new Date().toISOString(),
        detectOnly,
        routes: routes.map((route) => ({
          route,
          status: "inspect-skipped",
          viewports: {},
          lastError: "dev server unreachable",
        })),
        allGreen: true, // skip doesn't count as regression
        regressions: [],
        skipped: routes.length,
      };
    }

    const routeResults: VisualInspectRouteResult[] = [];
    let serverCrashed = false;
    let skipped = 0;

    let browser;
    let context: BrowserContext | undefined;
    try {
      browser = await chromium.launch();
      context = await browser.newContext();
    } catch (e) {
      log.error("visual_inspect.browser_launch_failed", { runId, err: String(e) });
      return {
        ranAt: new Date().toISOString(),
        detectOnly,
        routes: routes.map((route) => ({
          route,
          status: "inspect-skipped",
          viewports: {},
          lastError: "browser launch failed",
        })),
        allGreen: true,
        regressions: [],
        skipped: routes.length,
      };
    }

    try {
      for (const route of routes) {
        if (serverCrashed) {
          routeResults.push({ route, status: "inspect-skipped", viewports: {} });
          skipped++;
          continue;
        }

        const routeResult: VisualInspectRouteResult = {
          route,
          status: "green",
          viewports: {},
        };

        for (const vp of VIEWPORTS) {
          const name = vpName(vp);
          const url = `${devServerUrl}${route}`;
          const bPath = this.baselinePath(route, name);
          const cPath = this.currentPath(route, name);
          const page = await context.newPage();

          try {
            const hasBaseline = fs.existsSync(bPath);

            if (!hasBaseline) {
              // First run: capture as baseline, no diff to report.
              await this.capture(page, url, vp, bPath);
              routeResult.viewports[name] = {
                name,
                width: vp.width,
                height: vp.height,
                pixelDiffPercent: 0,
                hasFormFields: false,
                buttonCount: 0,
              };
            } else {
              // Subsequent run: capture current, diff vs baseline.
              await this.capture(page, url, vp, cPath);

              const { percent } = this.computePixelDiff(bPath, cPath);
              const isRegression = percent > threshold;

              log.info("visual_inspect.pixel_diff", {
                runId,
                route,
                viewport: name,
                percentDiff: percent,
                threshold,
                regressed: isRegression,
              });

              const { hasFormFields, buttons } = await this.detectFormFields(page);

              routeResult.viewports[name] = {
                name,
                width: vp.width,
                height: vp.height,
                pixelDiffPercent: percent,
                hasFormFields,
                buttonCount: buttons.length,
                screenshotPath: isRegression ? cPath : undefined,
              };

              if (isRegression && routeResult.status === "green") {
                routeResult.status = "regressed";
              }
            }
          } catch (e) {
            const msg = String(e);
            // Treat connection-refused / navigation errors as server crash.
            const isCrash =
              msg.includes("net::ERR_CONNECTION_REFUSED") ||
              msg.includes("ECONNREFUSED") ||
              msg.includes("ERR_EMPTY_RESPONSE");
            if (isCrash) {
              log.warn("visual_inspect.server_crash_detected", {
                runId,
                route,
                viewport: name,
              });
              serverCrashed = true;
              if (routeResult.status === "green") {
                routeResult.status = "inspect-skipped";
                routeResult.lastError = "server crashed";
              }
            } else {
              log.warn("visual_inspect.capture_error", {
                runId,
                route,
                viewport: name,
                err: msg,
              });
              if (routeResult.status === "green") {
                routeResult.status = "error";
                routeResult.lastError = msg;
              }
            }
            routeResult.viewports[name] = {
              name,
              width: vp.width,
              height: vp.height,
            };
          } finally {
            await page.close().catch(() => undefined);
          }
        }

        routeResults.push(routeResult);
      }
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }

    const regressions = routeResults.filter((r) => r.status === "regressed");
    log.info("visual_inspect.complete", {
      runId,
      routeCount: routes.length,
      regressionCount: regressions.length,
      skippedCount: skipped,
      threshold,
      detectOnly,
    });

    return {
      ranAt: new Date().toISOString(),
      detectOnly,
      routes: routeResults,
      allGreen: regressions.length === 0,
      regressions,
      skipped,
    };
  }
}

/**
 * Build feedback block for re-spawn: structured context to prepend to the
 * next claude invocation as a system-level context block.
 */
export function buildVisualInspectFeedbackPrompt(
  feedback: VisualInspectFeedback,
): string {
  const lines = [
    `VISUAL INSPECTION FEEDBACK for run ${feedback.runId}, round ${feedback.round}:`,
    ``,
  ];

  for (const finding of feedback.findings) {
    lines.push(`Route: ${finding.route}, Viewport: ${finding.viewport}`);
    lines.push(`  Pixel diff: ${(finding.pixelDiffPercent * 100).toFixed(1)}%`);
    if (finding.formFields.length > 0) {
      lines.push(`  Form fields: ${finding.formFields.map((f) => f.type).join(", ")}`);
    }
    if (finding.buttons.length > 0) {
      lines.push(`  Buttons: ${finding.buttons.join(", ")}`);
    }
    if (finding.suggestion) {
      lines.push(`  Suggestion: ${finding.suggestion}`);
    }
    lines.push(``);
  }

  if (feedback.screenshotPaths.length > 0) {
    lines.push(`Screenshots for review:`);
    feedback.screenshotPaths.forEach((p) => lines.push(`  ${p}`));
    lines.push(``);
  }

  return lines.join("\n");
}
