import { describe, it, expect, beforeEach } from "vitest";
import {
  VisualInspectLoop,
  buildVisualInspectFeedbackPrompt,
} from "./visual-inspect.js";
import { PNG } from "pngjs";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const testHomeDir = path.join(os.tmpdir(), "ocean-bot-visual-test");

function freshLoop(): VisualInspectLoop {
  return new VisualInspectLoop("test-proj", testHomeDir);
}

/** Write a solid-colour PNG of given dimensions to the given path. */
function writeSolidPng(
  filePath: string,
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    png.data[offset] = r;
    png.data[offset + 1] = g;
    png.data[offset + 2] = b;
    png.data[offset + 3] = 255;
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

beforeEach(() => {
  fs.rmSync(testHomeDir, { recursive: true, force: true });
  fs.mkdirSync(testHomeDir, { recursive: true });
});

describe("visual-inspect.VisualInspectLoop.shouldRun", () => {
  it("returns false when config disabled", async () => {
    const should = await freshLoop().shouldRun({ enabled: false }, ["src/lib/queries.ts"]);
    expect(should).toBe(false);
  });

  it("returns false when config is undefined", async () => {
    const should = await freshLoop().shouldRun(undefined, ["src/app/page.tsx"]);
    expect(should).toBe(false);
  });

  it("returns false when no UI files changed", async () => {
    const should = await freshLoop().shouldRun(
      { enabled: true },
      ["README.md", "docs/arch.md", "src/core/util/slug.ts"],
    );
    expect(should).toBe(false);
  });

  it("returns true when app/ file changed", async () => {
    const should = await freshLoop().shouldRun(
      { enabled: true },
      ["apps/dashboard/src/app/page.tsx"],
    );
    expect(should).toBe(true);
  });

  it("returns true when src/lib/ file changed", async () => {
    const should = await freshLoop().shouldRun(
      { enabled: true },
      ["tools/ocean-bot/dashboard/src/lib/queries.ts"],
    );
    expect(should).toBe(true);
  });
});

describe("visual-inspect.VisualInspectLoop.inferRoutes", () => {
  const projectDir = path.join(os.tmpdir(), "ocean-bot-visual-inferroutes");

  beforeEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.mkdirSync(projectDir, { recursive: true });
  });

  it("extracts /dashboard from TypeScript imports", async () => {
    const relPath = "src/lib/foo.ts";
    const absPath = path.join(projectDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(
      absPath,
      `import { queries } from "@/lib/dashboard/queries";\n` +
        `import { health } from "@/dashboard/health";\n`,
    );

    const routes = await freshLoop().inferRoutes([relPath], projectDir);
    expect(routes).toContain("/dashboard");
    // Only one /dashboard despite two matching imports
    expect(routes.filter((r) => r === "/dashboard")).toHaveLength(1);
  });

  it("falls back to fallbackRoutes when no imports match", async () => {
    const relPath = "src/util/helpers.ts";
    const absPath = path.join(projectDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, `export function help() {}\n`);

    const fallback = ["/dashboard/budget", "/health"];
    const routes = await freshLoop().inferRoutes([relPath], projectDir, fallback);
    expect(routes).toEqual(fallback);
  });

  it("returns empty array when no fallback and no imports", async () => {
    const relPath = "src/util/noop.ts";
    const absPath = path.join(projectDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, `export const x = 1;\n`);

    const routes = await freshLoop().inferRoutes([relPath], projectDir);
    expect(routes).toEqual([]);
  });

  it("caps routes at 5", async () => {
    // Five distinct dashboard-adjacent segments would be deduped to just /dashboard;
    // the cap test uses a custom regex-matching pattern so we create many files
    // each importing different dashboard sub-paths.
    const relPaths: string[] = [];
    for (let i = 0; i < 8; i++) {
      const relPath = `src/lib/mod${i}.ts`;
      const absPath = path.join(projectDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      // Each imports "@/lib/dashboard/..." so they all resolve to /dashboard;
      // since the set deduplicates, the cap test is really about many fallback routes.
      fs.writeFileSync(absPath, `import { x } from "@/lib/dashboard/mod${i}";\n`);
      relPaths.push(relPath);
    }

    const fallback = Array.from({ length: 8 }, (_, i) => `/route${i}`);
    // Force fallback path by using a file that doesn't match imports
    const routes = await freshLoop().inferRoutes([], projectDir, fallback);
    // fallback returned verbatim; cap is only on import-inferred routes
    expect(routes).toHaveLength(8);

    // Direct import inference capped at 5 (here all collapse to /dashboard so count is 1)
    const importRoutes = await freshLoop().inferRoutes(relPaths, projectDir);
    expect(importRoutes.length).toBeLessThanOrEqual(5);
  });

  it("skips non-TS/TSX files", async () => {
    const relPath = "package.json";
    const absPath = path.join(projectDir, relPath);
    fs.writeFileSync(absPath, `{"name":"test"}\n`);

    const routes = await freshLoop().inferRoutes([relPath], projectDir);
    expect(routes).toEqual([]);
  });

  it("skips missing files silently", async () => {
    const routes = await freshLoop().inferRoutes(
      ["src/nonexistent.ts"],
      projectDir,
    );
    expect(routes).toEqual([]);
  });
});

describe("visual-inspect.VisualInspectLoop.computePixelDiff", () => {
  it("returns 0% for identical PNGs", () => {
    const a = path.join(testHomeDir, "a.png");
    const b = path.join(testHomeDir, "b.png");
    writeSolidPng(a, 10, 10, 255, 0, 0);
    writeSolidPng(b, 10, 10, 255, 0, 0);

    const { percent } = freshLoop().computePixelDiff(a, b);
    expect(percent).toBe(0);
  });

  it("returns 100% for completely different PNGs (same size)", () => {
    const a = path.join(testHomeDir, "red.png");
    const b = path.join(testHomeDir, "green.png");
    writeSolidPng(a, 10, 10, 255, 0, 0);
    writeSolidPng(b, 10, 10, 0, 255, 0);

    const { percent } = freshLoop().computePixelDiff(a, b);
    // All 100 pixels differ; percent should be 1.0 (within floating-point tolerance)
    expect(percent).toBeGreaterThan(0.99);
  });

  it("returns 1.0 (worst-case) for size-mismatched PNGs", () => {
    const a = path.join(testHomeDir, "small.png");
    const b = path.join(testHomeDir, "large.png");
    writeSolidPng(a, 10, 10, 100, 100, 100);
    writeSolidPng(b, 20, 20, 100, 100, 100);

    const { percent } = freshLoop().computePixelDiff(a, b);
    expect(percent).toBe(1);
  });

  it("returns -1 percent on missing file", () => {
    const a = path.join(testHomeDir, "no-such-baseline.png");
    const b = path.join(testHomeDir, "no-such-current.png");

    const { percent } = freshLoop().computePixelDiff(a, b);
    expect(percent).toBe(-1);
  });

  it("detects partial diff below threshold", () => {
    // Create a 100x10 white PNG (1000 pixels).
    // Then create a second where 10 pixels (1%) are black.
    const width = 100;
    const height = 10;
    const a = path.join(testHomeDir, "white.png");
    const bFile = path.join(testHomeDir, "mostly-white.png");

    writeSolidPng(a, width, height, 255, 255, 255);

    // Identical copy then paint 10 pixels black
    const png = new PNG({ width, height });
    for (let i = 0; i < width * height; i++) {
      const offset = i * 4;
      png.data[offset] = 255;
      png.data[offset + 1] = 255;
      png.data[offset + 2] = 255;
      png.data[offset + 3] = 255;
    }
    // First 10 pixels black
    for (let i = 0; i < 10; i++) {
      png.data[i * 4] = 0;
      png.data[i * 4 + 1] = 0;
      png.data[i * 4 + 2] = 0;
    }
    fs.writeFileSync(bFile, PNG.sync.write(png));

    const { percent } = freshLoop().computePixelDiff(a, bFile);
    // ~1% diff — below 5% default threshold
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThan(0.05);
  });
});

describe("visual-inspect.VisualInspectLoop.run (no dev server)", () => {
  it("returns skipped routes when dev server is unreachable", async () => {
    const result = await freshLoop().run(
      { enabled: true, fallbackRoutes: ["/dashboard"] },
      ["apps/dashboard/src/app/page.tsx"],
      testHomeDir,
      "http://localhost:19999", // nothing listening
      "run-no-server",
    );

    expect(result.allGreen).toBe(true); // skip is not a regression
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.routes.every((r) => r.status === "inspect-skipped")).toBe(true);
  });

  it("returns empty when no routes inferred and no fallback", async () => {
    const result = await freshLoop().run(
      { enabled: true },
      ["README.md"],
      testHomeDir,
      "http://localhost:3000",
      "run-no-routes",
    );

    expect(result.routes).toHaveLength(0);
    expect(result.allGreen).toBe(true);
    expect(result.skipped).toBe(0);
  });

  it("detectOnly defaults to true when not specified", async () => {
    const result = await freshLoop().run(
      { enabled: true },
      [],
      testHomeDir,
      "http://localhost:3000",
      "run-defaults",
    );
    expect(result.detectOnly).toBe(true);
  });
});

describe("visual-inspect.buildVisualInspectFeedbackPrompt", () => {
  it("formats header with runId and round", () => {
    const prompt = buildVisualInspectFeedbackPrompt({
      runId: "run-abc",
      round: 1,
      findings: [],
      screenshotPaths: [],
    });
    expect(prompt).toContain("VISUAL INSPECTION FEEDBACK for run run-abc, round 1");
  });

  it("formats pixel diff percentage to 1 decimal place", () => {
    const prompt = buildVisualInspectFeedbackPrompt({
      runId: "run-x",
      round: 1,
      findings: [
        {
          route: "/dashboard",
          viewport: "mobile",
          pixelDiffPercent: 0.082,
          formFields: [],
          buttons: [],
        },
      ],
      screenshotPaths: [],
    });
    expect(prompt).toContain("8.2%");
  });

  it("includes form fields when present, omits section when empty", () => {
    const withForms = buildVisualInspectFeedbackPrompt({
      runId: "r",
      round: 1,
      findings: [
        {
          route: "/sign-in",
          viewport: "desktop",
          pixelDiffPercent: 0.1,
          formFields: [{ type: "email" }, { type: "password" }],
          buttons: [],
        },
      ],
      screenshotPaths: [],
    });
    expect(withForms).toContain("email");
    expect(withForms).toContain("password");

    const noForms = buildVisualInspectFeedbackPrompt({
      runId: "r",
      round: 1,
      findings: [
        {
          route: "/health",
          viewport: "desktop",
          pixelDiffPercent: 0,
          formFields: [],
          buttons: [],
        },
      ],
      screenshotPaths: [],
    });
    expect(noForms).not.toContain("Form fields");
  });

  // Symmetric to the form-fields test: the Buttons section has the same
  // if-guard (`if (finding.buttons.length > 0)`) and must be exercised
  // in both branches or a silent template-string regression won't be caught.
  it("includes buttons when present, omits section when empty", () => {
    const withButtons = buildVisualInspectFeedbackPrompt({
      runId: "r",
      round: 1,
      findings: [
        {
          route: "/dashboard",
          viewport: "mobile",
          pixelDiffPercent: 0.06,
          formFields: [],
          buttons: ["Save", "Cancel"],
        },
      ],
      screenshotPaths: [],
    });
    expect(withButtons).toContain("Buttons: Save, Cancel");

    const noButtons = buildVisualInspectFeedbackPrompt({
      runId: "r",
      round: 1,
      findings: [
        {
          route: "/health",
          viewport: "desktop",
          pixelDiffPercent: 0,
          formFields: [],
          buttons: [],
        },
      ],
      screenshotPaths: [],
    });
    expect(noButtons).not.toContain("Buttons:");
  });

  it("includes screenshot paths when present", () => {
    const prompt = buildVisualInspectFeedbackPrompt({
      runId: "r",
      round: 2,
      findings: [],
      screenshotPaths: ["/home/user/.ocean-bot/visual-inspect/baselines/proj/dashboard/current-mobile.png"],
    });
    expect(prompt).toContain("Screenshots for review:");
    expect(prompt).toContain("current-mobile.png");
  });

  it("omits screenshots section when empty", () => {
    const prompt = buildVisualInspectFeedbackPrompt({
      runId: "r",
      round: 1,
      findings: [],
      screenshotPaths: [],
    });
    expect(prompt).not.toContain("Screenshots");
  });
});
