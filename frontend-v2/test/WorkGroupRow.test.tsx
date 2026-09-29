/**
 * The work group row: every run of tool calls between two replies drawn as one
 * bordered row, "Ran 3 commands, edited 2 files · 28s ›", that opens into one
 * compact row per call (docs/plans/2026-09-27-text-view-t3-pass.md, the
 * prototype's `.wg`).
 *
 * Nothing a tool row showed before may be lost behind it: a call row opens the
 * same detail ToolRowView draws (output, the diff, "Show full output", the raw
 * input), and a group's pictures stay in view under it while it is folded.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import type { Event } from "../src/types/events";
import { TurnFoldRowView, WorkGroupRowView } from "../src/components/rows";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import {
  deriveRows,
  liveGroupState,
  liveRow,
  type LiveGroupState,
  type TurnFoldRow,
  type WorkGroupRow,
} from "../src/components/timeline.logic";
import { closePicture, picture } from "../src/store/picture";
import { track } from "../src/telemetry/track";

vi.mock("../src/telemetry/track", () => ({ track: vi.fn() }));

afterEach(() => {
  closePicture();
  cleanup();
  vi.mocked(track).mockClear();
});

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const bash = (id: number, toolId: string, command: string, at?: number): Event =>
  ev({
    id,
    kind: "tool_use",
    tool: "Bash",
    toolId,
    body: JSON.stringify({ command }),
    ...(at !== undefined ? { at } : {}),
  });
const result = (id: number, toolId: string, body: string, more: Partial<Event> = {}): Event =>
  ev({ id, kind: "tool_result", toolId, body, ...more });

const SHOT = "toolu_01EaDF17CdmXP8Wc3ctiXaL2";

/** A running turn, so the group stays a row of its own rather than folding. */
const WORK: Event[] = [
  ev({ id: 1, kind: "user", body: "fix it", at: 1_000 }),
  ev({
    id: 2,
    kind: "tool_use",
    tool: "Edit",
    toolId: "e1",
    body: JSON.stringify({ file_path: "/r/QuestionCard.tsx" }),
    at: 2_000,
  }),
  result(3, "e1", "ok", {
    at: 3_000,
    result: {
      structuredPatch: [{ oldStart: 1, newStart: 1, lines: ["-old", "+new", "+more", " same"] }],
    },
  }),
  bash(4, "b1", "npx vitest run QuestionCard", 4_000),
  result(5, "b1", "Tests 12 passed", { at: 20_000 }),
  ev({
    id: 6,
    kind: "tool_use",
    tool: "Read",
    toolId: SHOT,
    body: JSON.stringify({ file_path: "/tmp/claude-1000/x/card-two-ticks.png" }),
    at: 21_000,
  }),
  result(7, SHOT, "", { at: 30_000, images: [{ n: 0, mediaType: "image/png", bytes: 139874 }] }),
  ev({ id: 8, kind: "text", body: "Fixed.", at: 30_500 }),
];

/** What CLI 2.1.283 writes for a call a Stop interrupted, or a plain No. */
const STOPPED_RESULT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
/** …and for a No with words, which the words follow. */
const DECLINED_WITH_WORDS =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";

const kindWord = (row: Element): string =>
  row.querySelector(".tl-group-call-kind")?.textContent ?? "";

function groupOf(events: Event[]): WorkGroupRow {
  const g = deriveRows(events).find((r): r is WorkGroupRow => r.kind === "work-group");
  if (!g) throw new Error("no work group derived");
  return g;
}

function mount(
  row: WorkGroupRow,
  more: {
    onLoadFull?: (id: string) => Promise<string | null>;
    live?: LiveGroupState;
    now?: number;
  } = {},
) {
  const { container } = render(() => (
    <WorkGroupRowView
      row={row}
      session="s"
      me="wizard"
      onLoadFull={more.onLoadFull}
      live={more.live}
      now={more.now}
    />
  ));
  const head = () => container.querySelector<HTMLButtonElement>(".tl-group-head")!;
  const calls = () => [...container.querySelectorAll<HTMLElement>(".tl-group-call")];
  return { container, head, calls };
}

describe("<WorkGroupRowView> folded", () => {
  it("says what the group did and how long it took, on one bordered row", () => {
    const { container, head, calls } = mount(groupOf(WORK));
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".tl-group-sum")!.textContent).toBe(
      "Edited 1 file, ran 1 command, viewed 1 picture",
    );
    // 2s to 30s: the first call's start to the last result.
    expect(container.querySelector(".tl-group-meta")!.textContent).toBe("✓ · 28s");
    expect(container.querySelector(".tl-group-dot")!.getAttribute("data-status")).toBe("ok");
    expect(calls(), "a folded group lists no calls").toHaveLength(0);
  });

  it("shows the group's pictures under it while it is folded, and opens one in the lightbox", () => {
    const { container } = mount(groupOf(WORK));
    const img = container.querySelector(".tl-group-pics .tl-tool-thumb img");
    expect(img?.getAttribute("src")).toBe(`/result/s/${SHOT}/image/0`);
    expect(img?.getAttribute("alt")).toBe("card-two-ticks.png");

    fireEvent.click(container.querySelector(".tl-group-pics .tl-tool-thumb")!);
    expect(picture()?.src).toBe(`/result/s/${SHOT}/image/0`);
    expect(vi.mocked(track)).toHaveBeenCalledWith("text.picture_opened", {
      "tl.kind": "block",
      "tl.source": "tool",
    });
  });

  it("says a failure in words, not by colour alone", () => {
    const failed = groupOf([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "b1", "false", 1_000),
      result(3, "b1", "exit 1", { isError: true, at: 5_000 }),
      ev({ id: 4, kind: "turn_end", at: 5_000 }),
    ]);
    const { container } = mount(failed);
    expect(container.querySelector(".tl-group-dot")!.getAttribute("data-status")).toBe("error");
    expect(container.querySelector(".tl-group-meta")!.textContent).toBe("failed · 4s");
  });

  it("says a group was stopped", () => {
    const stopped = groupOf([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "b1", "sleep 60", 1_000),
      ev({ id: 3, kind: "turn_end", at: 9_000 }),
    ]);
    // The settled turn has one work row, so it does not fold.
    const { container } = mount(stopped);
    expect(container.querySelector(".tl-group-dot")!.getAttribute("data-status")).toBe("stopped");
    expect(container.querySelector(".tl-group-meta")!.textContent).toContain("stopped");
  });

  it("does not read a call that waits for permission as done", () => {
    // Found live on 2026-09-27: "Edited 1 file ✓" sat over the card asking
    // whether to create that file, and the file did not exist yet.
    const waiting = groupOf([
      ev({ id: 1, kind: "user", body: "go", at: 500 }),
      bash(2, "b1", "ls", 1_000),
      result(3, "b1", "a.txt", { at: 2_000 }),
      ev({
        id: 4,
        kind: "tool_use",
        tool: "Write",
        toolId: "w1",
        body: JSON.stringify({ file_path: "/r/hello.txt", content: "hi" }),
        at: 3_000,
      }),
    ]);
    const { container } = mount(waiting);
    expect(container.querySelector(".tl-group-sum")!.textContent).toBe(
      "Ran 1 command, waiting to edit 1 file",
    );
    expect(container.querySelector(".tl-group-meta")!.textContent).not.toContain("✓");
    expect(container.querySelector(".tl-group-meta")!.textContent).toContain("waiting");
    expect(container.querySelector(".tl-group-dot")!.getAttribute("data-status")).toBe("waiting");
  });

  it("does not count an edit that failed as a file edited", () => {
    // Seen live on 2026-09-27: an Edit refused with "File has not been read
    // yet" read as "Edited 1 file" beside "failed".
    const g = groupOf([
      ev({ id: 1, kind: "user", body: "go" }),
      ev({
        id: 2,
        kind: "tool_use",
        tool: "Edit",
        toolId: "e1",
        body: JSON.stringify({ file_path: "/r/calc.py", old_string: "a", new_string: "b" }),
        at: 1_000,
      }),
      result(3, "e1", "File has not been read yet. Read it first before writing to it.", {
        isError: true,
        at: 2_000,
      }),
      ev({ id: 4, kind: "turn_end", at: 3_000 }),
    ]);
    const { container } = mount(g);
    expect(container.querySelector(".tl-group-sum")!.textContent).toBe("1 edit failed");
    expect(container.querySelector(".tl-group-meta")!.textContent).toContain("failed");
  });

  it("says a call the reader declined was declined, not that it failed", () => {
    const declined = groupOf([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "b1", "ls", 1_000),
      result(3, "b1", "a.txt", { at: 2_000 }),
      ev({
        id: 4,
        kind: "tool_use",
        tool: "Edit",
        toolId: "e1",
        body: JSON.stringify({ file_path: "/r/calc.py", old_string: "a", new_string: "b" }),
        at: 3_000,
      }),
      result(
        5,
        "e1",
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said: use a docstring",
        { isError: true, at: 4_000 },
      ),
      ev({ id: 6, kind: "turn_end", at: 5_000 }),
    ]);
    expect(declined.hasError).toBe(false);
    const { container } = mount(declined);
    expect(container.querySelector(".tl-group-sum")!.textContent).toBe(
      "Ran 1 command, declined 1 edit",
    );
    expect(container.querySelector(".tl-group-dot")!.getAttribute("data-status")).toBe("ok");
    expect(container.querySelector(".tl-group-meta")!.textContent).not.toContain("failed");
  });

  // Round 7 (2026-09-28): a command interrupted by Stop read "Declined 1
  // command · stopped". The CLI writes the same rejection for it as for a
  // plain No, with "STOP what you are doing" and its interrupt notice after;
  // a No with words carries "the user said:" and Claude carries on. The first
  // stopped the turn, and says so once.
  it("says a call a Stop interrupted was stopped, once", () => {
    const g = groupOf([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "b1", "ping -c 20 127.0.0.1", 1_000),
      result(3, "b1", STOPPED_RESULT, { isError: true, at: 2_000 }),
      ev({ id: 4, kind: "state", body: "[Request interrupted by user for tool use]", at: 2_000 }),
      ev({ id: 5, kind: "turn_end", at: 2_000 }),
    ]);
    const { container, head, calls } = mount(g);
    expect(container.querySelector(".tl-group-sum")!.textContent).toBe("Stopped 1 command");
    const meta = container.querySelector(".tl-group-meta")!.textContent ?? "";
    expect(meta).not.toContain("stopped");
    expect(container.querySelector(".tl-group-dot")!.getAttribute("data-status")).toBe("stopped");
    fireEvent.click(head());
    const row = calls()[0]!;
    expect(row.getAttribute("data-status")).toBe("stopped");
    expect(kindWord(row)).toBe("Run");
    expect(row.textContent).toContain("stopped");
    expect(row.textContent).not.toContain("declined");
  });

  it("names a declined call by what it asked to do, not by what it did", () => {
    const [asked, done] = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "b1", "echo bye > hi.txt", 1_000),
      result(3, "b1", `${DECLINED_WITH_WORDS}write ciao instead`, { isError: true, at: 2_000 }),
      bash(4, "b2", "echo ciao > hi.txt", 3_000),
      result(5, "b2", "", { at: 4_000 }),
    ]).filter((r): r is WorkGroupRow => r.kind === "work-group");
    const first = mount(asked!);
    fireEvent.click(first.head());
    const [declined] = first.calls();
    expect(declined!.getAttribute("data-status")).toBe("declined");
    expect(kindWord(declined!)).toBe("Run");
    cleanup();
    const second = mount(done!);
    fireEvent.click(second.head());
    expect(kindWord(second.calls()[0]!)).toBe("Ran");
  });

  // Deployed review round 2 of the T3 pass (2026-09-29): "Type your own
  // answer" on a permission card reached Claude, which did what it said, and
  // the words showed nowhere; the group read "Ran 1 command, declined 1
  // command" and Claude's "as you asked" pointed at nothing. The words are the
  // reader's own message, so they sit in the conversation where they were
  // said, between the work before them and the work they asked for, and stay
  // in view when the turn folds.
  it("puts a No's own words in the conversation, where they were said", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "b1", "echo bye > hi.txt", 1_000),
      result(3, "b1", `${DECLINED_WITH_WORDS}write ciao instead`, { isError: true, at: 2_000 }),
      bash(4, "b2", "echo ciao > hi.txt", 3_000),
      result(5, "b2", "", { at: 4_000 }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual([
      "user",
      "work-group",
      "permission",
      "work-group",
      "working",
    ]);
    const [first, second] = rows.filter((r): r is WorkGroupRow => r.kind === "work-group");
    expect(first!.calls).toHaveLength(1);
    expect(second!.calls).toHaveLength(1);
    const { container } = render(() => (
      <MessagesTimeline
        events={[
          ev({ id: 1, kind: "user", body: "go", at: 500 }),
          bash(2, "b1", "echo bye > hi.txt", 1_000),
          result(3, "b1", `${DECLINED_WITH_WORDS}write ciao instead`, {
            isError: true,
            at: 2_000,
          }),
          bash(4, "b2", "echo ciao > hi.txt", 3_000),
          result(5, "b2", "", { at: 4_000 }),
          ev({ id: 6, kind: "text", body: "I wrote ciao, as you asked.", at: 5_000 }),
          ev({ id: 7, kind: "turn_end", at: 5_000 }),
        ]}
      />
    ));
    // Folded: the note stays out of the fold, between it and the reply.
    const note = container.querySelector(".tl-row-permission");
    expect(note?.textContent).toBe("Declined: write ciao instead");
    expect(note?.querySelector("b")?.textContent).toBe("write ciao instead");
  });

  it("leaves a plain No, which has no words, as the declined call alone", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "b1", "echo bye > hi.txt", 1_000),
      result(3, "b1", `${DECLINED_WITH_WORDS}`, { isError: true, at: 2_000 }),
      bash(4, "b2", "echo ciao > hi.txt", 3_000),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "work-group", "working"]);
  });

  it("answers for its calls' events, so a search hit inside it can find it", () => {
    const { container } = mount(groupOf(WORK));
    const eids = container.querySelector(".tl-row-group")!.getAttribute("data-eids");
    expect(eids?.split(" ")).toEqual(["2", "4", "6"]);
  });
});

describe("<WorkGroupRowView> open", () => {
  it("lists one compact row per call, with the edit's line counts and a tick for the rest", () => {
    const { head, calls } = mount(groupOf(WORK));
    fireEvent.click(head());
    expect(head().getAttribute("aria-expanded")).toBe("true");

    const rows = calls();
    expect(rows).toHaveLength(3);
    const text = (el: HTMLElement, sel: string) => el.querySelector(sel)?.textContent ?? "";
    expect(rows.map((r) => text(r, ".tl-group-call-kind"))).toEqual(["Edited", "Ran", "Read"]);
    expect(text(rows[1]!, ".tl-group-call-label")).toBe("npx vitest run QuestionCard");
    expect(text(rows[0]!, ".tl-group-call-st")).toBe("+2−1");
    expect(text(rows[1]!, ".tl-group-call-st")).toBe("✓");
    // The pictures stay under the group while it is open, too.
    expect(head().closest(".tl-row-group")!.querySelector(".tl-group-pics img")).not.toBeNull();
  });

  it("opens a call into the detail a tool row shows: its output and its raw input", () => {
    const { head, calls } = mount(groupOf(WORK));
    fireEvent.click(head());
    const cmd = calls()[1]!;
    expect(cmd.querySelector(".tl-tool-raw")).toBeNull();

    fireEvent.click(cmd.querySelector(".tl-group-call-head")!);
    expect(cmd.querySelector(".tl-group-call-head")!.getAttribute("aria-expanded")).toBe("true");
    expect(cmd.querySelector(".tl-tool-raw")!.textContent).toContain("Tests 12 passed");
    expect(cmd.querySelector(".tl-tool-input")).not.toBeNull();
    // The group's own thumbnails carry the pictures; the detail does not repeat them.
    expect(cmd.querySelector(".tl-tool-thumb")).toBeNull();
  });

  it("opens an edit into its diff", () => {
    const { head, calls } = mount(groupOf(WORK));
    fireEvent.click(head());
    const edit = calls()[0]!;
    fireEvent.click(edit.querySelector(".tl-group-call-head")!);
    expect(edit.querySelector(".tl-tool-raw")!.textContent).toContain("new");
  });

  it("loads a capped result in full from inside the call", async () => {
    const onLoadFull = vi.fn(async () => "the whole output");
    const capped = groupOf([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "b1", "cat big.log"),
      result(3, "b1", "the first part", { truncated: true }),
    ]);
    const { head, calls } = mount(capped, { onLoadFull });
    fireEvent.click(head());
    fireEvent.click(calls()[0]!.querySelector(".tl-group-call-head")!);
    const load = [...calls()[0]!.querySelectorAll("button")].find(
      (b) => b.textContent === "Show full output",
    )!;
    fireEvent.click(load);
    await vi.waitFor(() => expect(calls()[0]!.textContent).toContain("the whole output"));
    expect(onLoadFull).toHaveBeenCalledWith("b1");
  });

  it("marks a failed call with ✗", () => {
    const failed = groupOf([
      ev({ id: 1, kind: "user", body: "go" }),
      bash(2, "b1", "false"),
      result(3, "b1", "exit 1", { isError: true }),
    ]);
    const { head, calls } = mount(failed);
    fireEvent.click(head());
    expect(calls()[0]!.querySelector(".tl-group-call-st")!.textContent).toBe("✗");
    expect(calls()[0]!.getAttribute("data-status")).toBe("error");
  });
});

describe("<WorkGroupRowView> while it runs", () => {
  const RUNNING: Event[] = [
    ev({ id: 1, kind: "user", body: "go" }),
    bash(2, "b1", "ls", 1_000),
    result(3, "b1", "a", { at: 2_000 }),
    bash(4, "b2", "sleep 6 && echo b", 3_000),
  ];

  // The timeline hands the running group its live state (liveGroupState),
  // and its one clock; the group keeps neither of its own.
  const liveOf = (events: Event[]) => {
    const rows = deriveRows(events);
    return liveGroupState({ live: liveRow(rows), last: groupOf(events) });
  };

  it("names the call in flight and counts the ones done, with a spinner", () => {
    const { container } = mount(groupOf(RUNNING), { live: liveOf(RUNNING), now: 17_000 });
    expect(container.querySelector(".tl-group-box")!.getAttribute("data-live")).toBe("working");
    expect(container.querySelector(".tl-group-spin")).not.toBeNull();
    expect(container.querySelector(".tl-group-sum")!.textContent).toBe("Running sleep 6 && echo b");
    expect(container.querySelector(".tl-group-sum code")!.textContent).toBe("sleep 6 && echo b");
    // 1s to 17s: the group's first call to now.
    expect(container.querySelector(".tl-group-meta")!.textContent).toBe("1 done · 16s");
  });

  it("draws settled without a live state, even while its last call is out", () => {
    const { container } = mount(groupOf(RUNNING));
    expect(container.querySelector(".tl-group-box")!.hasAttribute("data-live")).toBe(false);
    expect(container.querySelector(".tl-group-head > .tl-group-spin")).toBeNull();
  });

  it("spins on the open call row that has not come back", () => {
    const { container, head, calls } = mount(groupOf(RUNNING));
    fireEvent.click(head());
    expect(calls()[1]!.getAttribute("data-status")).toBe("running");
    expect(calls()[1]!.querySelector(".tl-group-spin")).not.toBeNull();
    expect(container.querySelectorAll(".tl-group-call .tl-group-spin")).toHaveLength(1);
  });
});

// Found live on 2026-09-28: a stopped or declined turn folded as a green
// "Worked for Ns" with the CLI's raw "[Request interrupted by user]" under it.
// The prototype draws a stopped group grey with "stopped", then the note
// "Stopped. Claude's turn ended."
describe("a turn the reader stopped", () => {
  const STOPPED: Event[] = [
    ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
    ev({ id: 2, kind: "text", body: "looking", at: 1_500 }),
    bash(3, "b1", "ls", 2_000),
    result(4, "b1", "ok", { at: 3_000 }),
    ev({ id: 5, kind: "text", body: "now the tests", at: 4_000 }),
    ev({ id: 6, kind: "state", body: "[Request interrupted by user]", at: 5_000 }),
    ev({ id: 7, kind: "turn_end", at: 5_000 }),
  ];

  it("draws the fold stopped, in words and not by colour alone", () => {
    const fold = deriveRows(STOPPED).find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    const { container } = render(() => (
      <TurnFoldRowView row={fold} expanded={false} onToggle={() => {}} />
    ));
    expect(container.querySelector(".tl-group-dot")!.getAttribute("data-status")).toBe("stopped");
    expect(container.querySelector(".tl-group-meta")!.textContent).toContain("stopped");
  });

  it("says the turn stopped instead of printing the CLI's notice", () => {
    const { container } = render(() => <MessagesTimeline events={STOPPED} />);
    expect(container.textContent).toContain("Stopped. Claude's turn ended.");
    expect(container.textContent).not.toContain("[Request interrupted");
  });
});

// Deployed review round 1 (2026-09-28): a finished turn's fold read "Worked for
// 31s · 5 steps" with "notes.txt 78 tok" on the right, Quiet line's label. It
// reads like a work group now: what the hidden calls did, the tick and the
// time, and no token count.
describe("a finished turn's fold", () => {
  const FINISHED: Event[] = [
    ev({ id: 1, kind: "user", body: "go", at: 1_000 }),
    ev({ id: 2, kind: "text", body: "looking", at: 1_500 }),
    bash(3, "b1", "ls", 2_000),
    result(4, "b1", "ok", { at: 3_000 }),
    ev({ id: 5, kind: "text", body: "one more", at: 4_000 }),
    bash(6, "b2", "echo c", 5_000),
    result(7, "b2", "c", { at: 6_000 }),
    ev({ id: 8, kind: "text", body: "done", at: 32_000 }),
    ev({ id: 9, kind: "turn_end", at: 32_000 }),
  ];

  it("says what the hidden work did, with the tick and the time", () => {
    const fold = deriveRows(FINISHED).find((r): r is TurnFoldRow => r.kind === "turn-fold")!;
    const { container } = render(() => (
      <TurnFoldRowView
        row={{ ...fold, usage: { input_tokens: 70, output_tokens: 8 } }}
        expanded={false}
        onToggle={() => {}}
      />
    ));
    expect(container.querySelector(".tl-group-sum")!.textContent).toBe(
      "Ran 2 commands, wrote 2 replies",
    );
    const meta = container.querySelector(".tl-group-meta")!.textContent!;
    expect(meta).toContain("✓");
    expect(meta).toContain("31s");
    expect(container.textContent).not.toContain("tok");
    expect(container.textContent).not.toContain("Worked for");
  });
});
