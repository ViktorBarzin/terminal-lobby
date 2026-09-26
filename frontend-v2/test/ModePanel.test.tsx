/**
 * The mode dial's list: every permission mode, each with one line on what it
 * does, and the one in force ticked.
 *
 * A click on the mode chip used to step the mode, the way Shift+Tab does, so a
 * reader who wanted plan clicked until it showed. The dial opens this list
 * instead (Quiet line composer, 2026-09-24), and a pick asks the server to walk
 * Shift+Tab to the mode (wire contract 1).
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { ModePanel } from "../src/components/ModePanel";

const rows = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>(".tl-pick-row"));
const row = (c: HTMLElement, name: string) =>
  rows(c).find((r) => r.querySelector(".tl-pick-name")?.textContent === name)!;

describe("the mode list", () => {
  it("lists all six modes, each with its line", () => {
    const { container } = render(() => <ModePanel current="manual" onPick={() => {}} />);
    expect(rows(container).map((r) => r.querySelector(".tl-pick-name")?.textContent)).toEqual([
      "Manual",
      "Plan",
      "Edits",
      "Auto",
      "Bypass",
      "No ask",
    ]);
    expect(row(container, "Plan").querySelector(".tl-pick-sub")?.textContent).toBe(
      "Reads and plans. Changes nothing",
    );
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe(
      "Permission mode",
    );
  });

  it("ticks the mode in force, and only that one", () => {
    const { container } = render(() => <ModePanel current="acceptEdits" onPick={() => {}} />);
    const ticked = rows(container).filter((r) => r.getAttribute("aria-checked") === "true");
    expect(ticked.map((r) => r.querySelector(".tl-pick-name")?.textContent)).toEqual(["Edits"]);
    expect(ticked[0]!.querySelector(".tl-pick-tick svg")).not.toBeNull();
  });

  it("reads an old transcript's `default` as Manual", () => {
    const { container } = render(() => <ModePanel current="default" onPick={() => {}} />);
    expect(row(container, "Manual").getAttribute("aria-checked")).toBe("true");
  });

  it("hands a pick to the caller by the CLI's identifier", () => {
    const onPick = vi.fn();
    const { container } = render(() => <ModePanel current="manual" onPick={onPick} />);
    fireEvent.click(row(container, "Plan"));
    fireEvent.click(row(container, "Bypass"));
    expect(onPick.mock.calls).toEqual([["plan"], ["bypassPermissions"]]);
  });

  it("sets the two modes that ask nothing apart, under a rule and in the danger tone", () => {
    const { container } = render(() => <ModePanel current="manual" onPick={() => {}} />);
    const list = container.querySelector('[role="radiogroup"]')!;
    const kids = Array.from(list.children);
    const gap = kids.findIndex((k) => k.classList.contains("tl-pick-gap"));
    expect(gap).toBe(4);
    expect(kids.slice(gap + 1).map((k) => k.getAttribute("data-tone"))).toEqual([
      "danger",
      "danger",
    ]);
  });

  // No ask is not a stop on Shift+Tab: a session can start in it, and the
  // first press leaves it for good (memory #13911). No walk can reach it.
  it("offers No ask only to a session that is already in it", () => {
    const onPick = vi.fn();
    const off = render(() => <ModePanel current="manual" onPick={onPick} />);
    const noAsk = row(off.container, "No ask");
    expect(noAsk.getAttribute("aria-disabled")).toBe("true");
    expect(noAsk.querySelector(".tl-pick-sub")?.textContent).toMatch(
      /set when the session starts/i,
    );
    fireEvent.click(noAsk);
    expect(onPick).not.toHaveBeenCalled();
    off.unmount();

    const on = render(() => <ModePanel current="dontAsk" onPick={onPick} />);
    const current = row(on.container, "No ask");
    expect(current.getAttribute("aria-disabled")).toBeNull();
    expect(current.getAttribute("aria-checked")).toBe("true");
  });

  it("disables a mode the server said this session does not offer, and says so", () => {
    const onPick = vi.fn();
    const { container } = render(() => (
      <ModePanel current="manual" unavailable={new Set(["auto"])} onPick={onPick} />
    ));
    const auto = row(container, "Auto");
    expect(auto.getAttribute("aria-disabled")).toBe("true");
    expect(auto.querySelector(".tl-pick-sub")?.textContent).toBe("Not offered in this session");
    fireEvent.click(auto);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("holds every row, with the reason, while a change would type into a dialog", () => {
    const onPick = vi.fn();
    const { container } = render(() => (
      <ModePanel current="manual" held="Answer Claude first" onPick={onPick} />
    ));
    expect(rows(container).every((r) => r.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(container.querySelector(".tl-pick-note")?.textContent).toBe("Answer Claude first");
    fireEvent.click(row(container, "Plan"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("says how Shift+Tab fits in when nothing holds it", () => {
    const { container } = render(() => <ModePanel current="manual" onPick={() => {}} />);
    expect(container.querySelector(".tl-pick-note")?.textContent).toBe(
      "Shift+Tab in the message steps to the next mode.",
    );
  });
});
