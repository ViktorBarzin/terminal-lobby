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
import { WorkGroupRowView } from "../src/components/rows";
import { deriveRows, type WorkGroupRow } from "../src/components/timeline.logic";
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

function groupOf(events: Event[]): WorkGroupRow {
  const g = deriveRows(events).find((r): r is WorkGroupRow => r.kind === "work-group");
  if (!g) throw new Error("no work group derived");
  return g;
}

function mount(
  row: WorkGroupRow,
  more: { onLoadFull?: (id: string) => Promise<string | null> } = {},
) {
  const { container } = render(() => (
    <WorkGroupRowView row={row} session="s" me="wizard" onLoadFull={more.onLoadFull} />
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
      "Edited 1 file, ran 1 command, read 1 file",
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

  it("names the call in flight and counts the ones done, with a spinner", () => {
    const { container } = mount(groupOf(RUNNING));
    expect(container.querySelector(".tl-group-box")!.hasAttribute("data-live")).toBe(true);
    expect(container.querySelector(".tl-group-spin")).not.toBeNull();
    expect(container.querySelector(".tl-group-sum")!.textContent).toBe("Running sleep 6 && echo b");
    expect(container.querySelector(".tl-group-sum code")!.textContent).toBe("sleep 6 && echo b");
    expect(container.querySelector(".tl-group-meta")!.textContent).toMatch(/^1 done/);
  });

  it("spins on the open call row that has not come back", () => {
    const { container, head, calls } = mount(groupOf(RUNNING));
    fireEvent.click(head());
    expect(calls()[1]!.getAttribute("data-status")).toBe("running");
    expect(calls()[1]!.querySelector(".tl-group-spin")).not.toBeNull();
    expect(container.querySelectorAll(".tl-group-call .tl-group-spin")).toHaveLength(1);
  });
});
