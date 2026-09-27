/**
 * A tool permission prompt, as the pane reports it.
 *
 * In manual mode, and in auto mode for a read outside the working
 * directories, Claude asks before it runs a tool, and the turn waits on a
 * person. The transcript holds the call and nothing more, so until 2026-09-27
 * the status line read "Working" with a live Stop for minutes over a waiting
 * session (measured twice that day), and nothing in the Text view could answer
 * it. The server now reads the prompt off the pane (sessionio permdialog.go)
 * and sends it as an `asking` reading of kind "permission".
 */
import { describe, it, expect } from "vitest";
import {
  deriveRows,
  permissionFromPane,
  planFromPane,
  type WorkingRow,
} from "../src/components/timeline.logic";
import type { Event } from "../src/types/events";

let id = 0;
const ev = (e: Partial<Event> & Pick<Event, "kind">): Event =>
  ({ id: ++id, session: "qa", ...e }) as Event;
const asking = (body: string): Event => ev({ kind: "meta", meta: "asking", body });

const reading = JSON.stringify({
  kind: "permission",
  title: "Bash command",
  detail: ["printf 'hi\\n' > a.txt", 'Write "hi" to a.txt'],
  prompt: "Do you want to proceed?",
  options: [
    { number: 1, label: "Yes" },
    { number: 2, label: "Yes, and always allow access to /tmp/x from this project" },
    { number: 3, label: "No" },
  ],
});

const call = (): Event[] => [
  ev({ kind: "user", body: "write the file", at: 1000 }),
  ev({
    kind: "tool_use",
    tool: "Bash",
    toolId: "b1",
    body: '{"command":"printf hi > a.txt"}',
    at: 2000,
  }),
];

describe("permissionFromPane", () => {
  it("reads the prompt the pane is showing", () => {
    const p = permissionFromPane([...call(), asking(reading)]);
    expect(p?.title).toBe("Bash command");
    expect(p?.prompt).toBe("Do you want to proceed?");
    expect(p?.detail).toEqual(["printf 'hi\\n' > a.txt", 'Write "hi" to a.txt']);
    expect(p?.options.map((o) => o.number)).toEqual([1, 2, 3]);
    expect(p?.options[2]?.label).toBe("No");
  });

  it("lets go when the prompt goes, or anything happens after it", () => {
    expect(permissionFromPane([...call(), asking(reading), asking("")])).toBeNull();
    expect(
      permissionFromPane([
        ...call(),
        asking(reading),
        ev({ kind: "tool_result", toolId: "b1", body: "" }),
      ]),
    ).toBeNull();
  });

  // The pane watcher and the transcript tail tick apart, so the reading can
  // be published before the transcript's own record of the call that raised
  // it (seen live on 2026-09-27, 1 prompt in 6: asking, then model, then the
  // tool_use). That record was written before the prompt was drawn; it is not
  // something happening after it.
  it("keeps the prompt when the call that raised it arrives after the reading", () => {
    const early = { ...ev({ kind: "meta", meta: "asking", body: reading }), at: 2500 };
    const p = permissionFromPane([
      ev({ kind: "user", body: "write the file", at: 1000 }),
      early,
      ev({ kind: "meta", meta: "model", at: 1900 }),
      ev({ kind: "tool_use", tool: "Bash", toolId: "b1", body: "{}", at: 2000 }),
    ]);
    expect(p?.title).toBe("Bash command");
    expect(p?.id).toBe(early.id);
  });

  it("still lets go for anything written after the reading, or with no time on it", () => {
    const early = (): Event => ({ ...asking(reading), at: 2500 });
    expect(
      permissionFromPane([
        ...call(),
        early(),
        ev({ kind: "tool_result", toolId: "b1", body: "", at: 2600 }),
      ]),
    ).toBeNull();
    expect(
      permissionFromPane([...call(), early(), ev({ kind: "tool_result", toolId: "b1", body: "" })]),
    ).toBeNull();
  });

  it("refuses a reading whose rows do not count up from 1", () => {
    const skipped = JSON.stringify({
      kind: "permission",
      prompt: "Do you want to proceed?",
      options: [
        { number: 1, label: "Yes" },
        { number: 3, label: "No" },
      ],
    });
    expect(permissionFromPane([asking(skipped)])).toBeNull();
  });

  it("is not the plan", () => {
    expect(planFromPane(reading)).toBeNull();
  });
});

describe("the live row while a permission prompt is up", () => {
  it("says Claude is waiting, not working", () => {
    const rows = deriveRows([...call(), asking(reading)]);
    const live = rows.at(-1) as WorkingRow;
    expect(live.kind).toBe("working");
    expect(live.waiting).toBe(true);
  });

  it("goes back to working once it is answered", () => {
    const rows = deriveRows([...call(), asking(reading), asking("")]);
    const live = rows.at(-1) as WorkingRow;
    expect(live.waiting).toBeUndefined();
  });
});
