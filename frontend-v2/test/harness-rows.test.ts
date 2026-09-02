/**
 * The harness's own bookkeeping must not read as conversation.
 *
 * Viktor's text view on 2026-09-02 showed a user bubble containing
 * `<local-command-stdout>` and its escape bytes, and a caveat addressed to the
 * model rendered as something Claude had said. Most of that is fixed where the
 * transcript is normalized (sessionio/harness.go): those records now arrive as
 * status events and never as prompts.
 *
 * One shape reaches the timeline anyway, and it is the most common of the lot.
 * A background task finishing is delivered THROUGH Claude's queue, so the
 * transcript reports enqueueing a wall of XML — 2,140 of them across 355
 * transcripts on this box, against 616 direct records. queuedPrompts() has kept
 * them out of the queue LIST since 2026-08-18; this covers the row.
 */
import { describe, it, expect } from "vitest";
import { deriveRows } from "../src/components/timeline.logic";
import type { Event, MetaKind } from "../src/types/events";

let next = 1;
const meta = (kind: MetaKind, body = ""): Event =>
  ({ id: next++, kind: "meta", meta: kind, body, session: "s", turnId: "t1" }) as Event;
const user = (body: string): Event =>
  ({ id: next++, kind: "user", body, session: "s", turnId: "t1" }) as Event;
const state = (body: string): Event =>
  ({ id: next++, kind: "state", body, session: "s", turnId: "t1" }) as Event;

/** The real shape, from a transcript on this box. */
const NOTIFICATION =
  "<task-notification>\n<task-id>boe4u3lz5</task-id>\n" +
  "<tool-use-id>toolu_01Diw2cn5Sm1gn6GMUkQLBeM</tool-use-id>\n" +
  "<status>completed</status>\n" +
  '<summary>Background command "Capture live lexical baseline" completed (exit code 0)</summary>\n' +
  "</task-notification>";

describe("a task notification delivered through the queue", () => {
  it("earns no row", () => {
    const rows = deriveRows([user("do the thing"), meta("queued", NOTIFICATION)]);
    expect(rows.filter((r) => r.kind === "meta")).toEqual([]);
    // The prompt itself is untouched.
    expect(rows.map((r) => r.kind)).toContain("user");
  });

  it("still leaves a real queued prompt its row", () => {
    const rows = deriveRows([
      user("do the thing"),
      meta("queued", NOTIFICATION),
      meta("queued", "and then this"),
    ]);
    const metas = rows.filter((r) => r.kind === "meta");
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ meta: "queued", body: "and then this" });
  });

  it("keeps a prompt that merely mentions one", () => {
    const rows = deriveRows([
      user("do the thing"),
      meta("queued", "what is a <task-notification> anyway"),
    ]);
    expect(rows.filter((r) => r.kind === "meta")).toHaveLength(1);
  });

  it("does not swallow the summary the notification's own record carries", () => {
    // sessionio turns the record into this. It is the one line the reader gets,
    // so the timeline must render it — 415 of the 419 measured arrive both ways
    // and dropping both would leave no trace at all.
    const rows = deriveRows([
      user("do the thing"),
      meta("queued", NOTIFICATION),
      state('Background command "Capture live lexical baseline" completed (exit code 0)'),
    ]);
    const statuses = rows.filter((r) => r.kind === "status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      body: 'Background command "Capture live lexical baseline" completed (exit code 0)',
    });
  });
});
