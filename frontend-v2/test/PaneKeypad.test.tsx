/**
 * The screen we could not read, shown as itself.
 *
 * ADR-0010 used to say: treat a failure to parse as an unknown prompt and show
 * the honest fallback to the terminal. That was 22.4% of the calls in this
 * box's corpus handed to a view the reader had left on purpose. The design
 * agreed 2026-09-10 replaces it — show the capture, and make the lines that
 * look like numbered rows tappable — and this file is the contract for the
 * second half of that sentence.
 *
 * Every fixture here is a REAL capture from sessionio/testdata, read off disk
 * rather than retyped, because the whole feature is a guess about what a CLI
 * screen looks like and a guess checked against a paraphrase proves nothing.
 * picker-claude-model.txt is the important one: it is a screen the dialog
 * parser deliberately refuses (a menu, not a question), so it is exactly the
 * shape that reaches this component in the field.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PaneKeypad } from "../src/components/PaneKeypad";

/** A capture from the Go side's fixture set, which both halves read. */
const capture = (name: string) =>
  readFileSync(resolve(process.cwd(), "../sessionio/testdata", name), "utf8");

/**
 * A real capture with conversation spliced in immediately above the dialog's
 * top edge, which is where a terminal puts it.
 *
 * Written as an insertion into a real file rather than a hand-typed pane: the
 * dialog half has to be exactly what the CLI draws, and only the scrollback is
 * the variable under test.
 */
const withScrollbackAbove = (name: string, extra: string[]) => {
  const lines = capture(name).split("\n");
  const top = lines.findIndex((l) => /[☐☒]/.test(l));
  expect(top, `${name} has a dialog top edge to splice above`).toBeGreaterThan(0);
  return [...lines.slice(0, top), ...extra, ...lines.slice(top)].join("\n");
};

const mount = (
  pane: string,
  over: { busy?: boolean; onKeys?: (k: string[]) => Promise<void> } = {},
) =>
  render(() => (
    <PaneKeypad pane={pane} busy={over.busy ?? false} onKeys={over.onKeys ?? (async () => {})} />
  ));

const rows = (c: HTMLElement) => Array.from(c.querySelectorAll(".tl-qcard-option"));
const labels = (c: HTMLElement) =>
  rows(c).map((r) => r.querySelector(".tl-qcard-label")?.textContent ?? "");
const keys = (c: HTMLElement) =>
  rows(c).map((r) => r.querySelector(".tl-qcard-key")?.textContent ?? "");

describe("<PaneKeypad> — the pane itself", () => {
  it("shows the capture as monospaced text", () => {
    const { container } = mount(capture("picker-claude-model.txt"));
    const pre = container.querySelector("pre");
    expect(pre, "the capture, rendered as itself").not.toBeNull();
    expect(pre!.textContent).toContain("Select model");
    expect(pre!.textContent).toContain("Haiku 4.5 · Fastest for quick answers");
  });

  it("shows the end of the capture, where the dialog is", () => {
    // A capture carries the whole conversation above the dialog. The reader
    // needs the bottom, so the top is what gets dropped.
    const { container } = mount(capture("dialog-single.txt"));
    const text = container.querySelector("pre")!.textContent ?? "";
    expect(text).toContain("Which font should the badge use?");
    expect(text).not.toContain("Claude Code v2.1.250");
  });
});

describe("<PaneKeypad> — the rows it can find", () => {
  it("finds every numbered row of the model picker", () => {
    // A menu, not an AskUserQuestion: ParseDialog refuses it for want of the
    // two options the CLI appends to a real question, so it lands here.
    const { container } = mount(capture("picker-claude-model.txt"));
    // The picker draws its label and its blurb on one line, columns apart, and
    // the row keeps both: this component shows what is on screen rather than
    // deciding which half of a line is the name. Split on the column gap to
    // name the four rows without pinning the exact run of spaces.
    const names = labels(container)
      .slice(0, 4)
      .map((l) => l.split(/\s{2,}/)[0]);
    // "Opus ✔" keeps its tick: it is mid-line here, and the trailing-tick trim
    // that sessionio.trimLabel does only bites at the end of a label.
    expect(names).toEqual(["Default (recommended)", "Sonnet", "Opus ✔", "Haiku"]);
    expect(keys(container).slice(0, 4)).toEqual(["1", "2", "3", "4"]);
  });

  it("reads a narrow pane, where the footer wraps and a rule splits the list", () => {
    // dialog-narrow-footer.txt is 58 columns: descriptions wrap under their
    // rows, tmux's composer rule cuts between rows 4 and 5, and the footer
    // itself breaks across two lines.
    const { container } = mount(capture("dialog-narrow-footer.txt"));
    expect(keys(container).slice(0, 5)).toEqual(["1", "2", "3", "4", "5"]);
    expect(labels(container)[0]).toBe("Drop all three (Recommended)");
    expect(labels(container)[4]).toBe("Chat about this");
  });

  it("counts only rows the widget itself numbered", () => {
    // The numbering has to be 1, 2, 3 in order, for the reason ParseDialog
    // checks the same thing: prose that happens to open with a digit is not an
    // option, and counting it shifts every digit after it.
    const pane = [
      "  9. Left over from a screen that has scrolled past",
      "",
      "  1. Fix the cache",
      "  3. Fix the timer",
      "  2. Fix both",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    const { container } = mount(pane);
    expect(labels(container).slice(0, 2)).toEqual(["Fix the cache", "Fix both"]);
    expect(keys(container).slice(0, 2)).toEqual(["1", "2"]);
  });

  /**
   * The rows are the DIALOG's, never the conversation's.
   *
   * Claude Code writes numbered lists all the time — a plan, a set of steps,
   * options it is talking about — and one of those directly above a dialog used
   * to eat the 1, 2, 3 the widget's own rows needed. The strict-sequence check
   * then rejected every real row, so the card offered three plan steps as the
   * answers and dropped Sans, Serif and Type something. Tapping the row reading
   * "Move the parser next to the driver" sent digit 1, and the dialog read that
   * as Sans: an answer to a question whose options the reader never saw.
   *
   * sessionio's answerRegion anchors the top of the region on the dialog's own
   * edge for this reason, and paneRegion now does the same.
   */
  it("reads the dialog's rows, not a numbered list in the conversation above it", () => {
    const pane = withScrollbackAbove("dialog-single.txt", [
      "● Here is the plan:",
      "  1. Move the parser next to the driver",
      "  2. Delete the browser walk",
      "  3. Port the fixtures",
      "",
    ]);
    const { container } = mount(pane);
    expect(labels(container).slice(0, 4)).toEqual([
      "Sans",
      "Serif",
      "Type something",
      "Chat about this",
    ]);
    expect(keys(container).slice(0, 4)).toEqual(["1", "2", "3", "4"]);
    expect(
      container.querySelector("pre")!.textContent,
      "and the scrollback is not shown as part of the dialog either",
    ).not.toContain("Move the parser next to the driver");
  });

  it("finds the list even when the pane is too short to show the dialog's header", () => {
    // The case a landmark-only anchor misses, and the reason sessionio derives
    // the top from the option list instead: on a phone-sized pane a long
    // question and its options push the ☐ header off the top, so there is no
    // landmark left to anchor on and the region falls back to a blind window
    // over the conversation. Here the conversation is a numbered list, which
    // is what Claude Code writes all day.
    const lines = capture("dialog-single.txt").split("\n");
    const header = lines.findIndex((l) => /[☐☒]/.test(l));
    const pane = [
      "● Here is the plan:",
      "  1. Move the parser next to the driver",
      "  2. Delete the browser walk",
      "",
      ...lines.slice(header + 1),
    ].join("\n");
    const { container } = mount(pane);
    expect(labels(container).slice(0, 3)).toEqual(["Sans", "Serif", "Type something"]);
    expect(container.querySelector("pre")!.textContent).toContain(
      "Which font should the badge use?",
    );
  });

  it("keeps the same anchor on a multi-question call, where the tab bar is the edge", () => {
    const pane = withScrollbackAbove("dialog-multi.txt", [
      "● Two ways to do this:",
      "  1. Keep the whole-walk plan",
      "  2. One request per choice",
      "",
    ]);
    const { container } = mount(pane);
    expect(labels(container).slice(0, 3)).toEqual(["Apple", "Pear", "Plum"]);
  });

  it("sends the row's own digit, not its place in the list", () => {
    const onKeys = vi.fn(async (_k: string[]) => {});
    const { container } = mount(capture("picker-claude-model.txt"), { onKeys });
    fireEvent.click(rows(container)[2]!);
    expect(onKeys).toHaveBeenCalledWith(["3"]);
  });

  it("does not send while a request is in flight", () => {
    const onKeys = vi.fn(async (_k: string[]) => {});
    const { container } = mount(capture("picker-claude-model.txt"), { onKeys, busy: true });
    fireEvent.click(rows(container)[0]!);
    expect(onKeys).not.toHaveBeenCalled();
  });
});

describe("<PaneKeypad> — Enter and Esc", () => {
  it("offers both under the rows", () => {
    const onKeys = vi.fn(async (_k: string[]) => {});
    const { container } = mount(capture("picker-claude-model.txt"), { onKeys });
    const all = rows(container);
    const enter = all[all.length - 2]!;
    const esc = all[all.length - 1]!;
    expect(enter.textContent).toMatch(/enter/i);
    expect(esc.textContent).toMatch(/esc/i);
    fireEvent.click(enter);
    expect(onKeys).toHaveBeenCalledWith(["Enter"]);
    fireEvent.click(esc);
    expect(onKeys).toHaveBeenCalledWith(["Escape"]);
  });

  it("offers nothing at all when no rows were found", () => {
    // Agreed 2026-09-10: a screen with no detectable rows gets the capture and
    // no controls. Enter on an unknown screen is a keystroke into somebody's
    // session with no idea what it does, and this is the one case where
    // reaching for the Terminal is the honest answer.
    const { container } = mount(capture("dialog-none.txt"));
    expect(rows(container)).toHaveLength(0);
    expect(container.querySelector("pre")).not.toBeNull();
  });
});
