import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadBotSessions } from "./budget.js";

// onEvent is a private function inside runner.ts. To test the event-
// shape contract without exposing it, we use the public side effects:
//   - appendBotSession writes into ~/.ocean-bot/sessions.jsonl when a
//     system/init event with session_file arrives
//   - the journal.appendEvent path is exercised indirectly
//
// Here we test the smaller pure contract: that loadBotSessions can
// roundtrip the records the runner would write, and that the parsing
// is forgiving of evolving claude CLI shapes.

describe("runner, session log roundtrip used by attribution", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ob-rev-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("loads only well-formed session records, drops malformed lines", async () => {
    const f = path.join(tmp, "sessions.jsonl");
    await fs.writeFile(
      f,
      [
        JSON.stringify({
          sessionPath: "/tmp/a.jsonl",
          runId: "r1",
          startedAt: 1700000000000,
        }),
        "this is not json",
        JSON.stringify({ runId: "r2" }), // missing sessionPath
        JSON.stringify({
          sessionPath: "/tmp/b.jsonl",
          runId: "r3",
          startedAt: 1700000001000,
        }),
        "",
      ].join("\n"),
    );
    const out = await loadBotSessions(f);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.runId).sort()).toEqual(["r1", "r3"]);
  });

  it("returns empty array when log doesn't exist (first boot)", async () => {
    const out = await loadBotSessions(path.join(tmp, "never-written.jsonl"));
    expect(out).toEqual([]);
  });
});
