// Tiny structured logger. JSON lines to stdout, launchd / journalctl
// reads them; the dashboard fetches structured events from Postgres
// instead. Don't pull in pino / winston, adds deps for no gain at this
// scale.

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), level, msg, ...(ctx ?? {}) };
  const out = JSON.stringify(line);
  if (level === "error" || level === "warn") {
    process.stderr.write(out + "\n");
  } else {
    process.stdout.write(out + "\n");
  }
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit("error", msg, ctx),
};
