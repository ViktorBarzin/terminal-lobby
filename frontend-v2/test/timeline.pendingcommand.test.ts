/**
 * A slash command waiting to be recorded does not make the session read as
 * working.
 *
 * The composer shows a sent prompt at once, as a pending bubble, and the
 * bubble's turn has no turn_end until the transcript records the prompt. For
 * prose that is under a second away. A command may never be recorded at all:
 * /help and /status write nothing, an unknown command is answered with a
 * system notice, and until 2026-09-27 /context was never let go either
 * (Claude Code 2.1.283 records it as a local_command). Measured that day, the
 * status line read "Working · 1m 35s · Stop" over an idle session until a
 * reload. The live row comes from the transcript instead while only commands
 * are pending.
 */
import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import { deriveRows, liveRowOf, withPendingPrompts } from "../src/components/timeline.logic";
import type { PendingPrompt } from "../src/logic/compose.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const pending = (id: number, text: string, command: boolean): PendingPrompt => ({
  id,
  text,
  at: 5000,
  command,
  afterId: 0,
});

const settled: Event[] = [
  ev({ id: 1, kind: "user", body: "hello", at: 1000 }),
  ev({ id: 2, kind: "text", body: "hi", at: 2000 }),
  ev({ id: 3, kind: "turn_end", at: 2000 }),
];

const running: Event[] = [
  ev({ id: 1, kind: "user", body: "run it", at: 1000, turnId: "t1" }),
  ev({
    id: 2,
    kind: "tool_use",
    tool: "Bash",
    toolId: "b1",
    body: '{"command":"sleep 60"}',
    at: 2000,
    turnId: "t1",
  }),
];

const live = (events: Event[], sent: PendingPrompt[]) =>
  liveRowOf(deriveRows(withPendingPrompts(events, sent)), deriveRows(events), sent);

describe("the live row while a command is pending", () => {
  it("is absent at idle while only a command waits", () => {
    expect(live(settled, [pending(-1, "/context", true)])).toBeUndefined();
  });

  it("keeps the running turn's call while a command waits mid-turn", () => {
    const row = live(running, [pending(-1, "/context", true)]);
    expect(row?.tool).toBe("Bash");
  });

  it("still reads Working the moment prose is sent", () => {
    const row = live(settled, [pending(-1, "deploy the api", false)]);
    expect(row).toBeDefined();
    expect(row?.waiting).toBeUndefined();
  });

  it("reads Working while prose waits beside a command", () => {
    const row = live(settled, [pending(-1, "deploy the api", false), pending(-2, "/help", true)]);
    expect(row).toBeDefined();
  });
});

describe("a command the CLI ran itself", () => {
  it("draws no row", () => {
    const rows = deriveRows(
      [...settled, ev({ id: 4, kind: "meta", meta: "command", body: "/context", at: 3000 })],
      { fold: false },
    );
    expect(rows.some((r) => r.kind === "meta")).toBe(false);
  });
});
