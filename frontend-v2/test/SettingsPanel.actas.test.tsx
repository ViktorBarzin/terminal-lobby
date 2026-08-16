import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SettingsPanel, type ActAsControl } from "../src/components/SettingsPanel";
import { PREF_DEFAULTS, type Prefs, type PrefsStore } from "../src/store/prefs";

afterEach(cleanup);

function fakePrefs(): PrefsStore {
  const [prefs] = createSignal<Prefs>(structuredClone(PREF_DEFAULTS));
  return {
    prefs,
    setPref() {},
    setFontSize() {},
    async bootSync() {},
    dispose() {},
  };
}

function panel(actAs?: ActAsControl) {
  return render(() => (
    <SettingsPanel prefs={fakePrefs()} onClose={() => {}} actAs={actAs} />
  ));
}

const picker = (c: HTMLElement) =>
  c.querySelector<HTMLSelectElement>('select[aria-label="Act as another user"]');

describe("Settings — the act-as picker", () => {
  // The server refuses a non-admin's ?as= regardless; this is about not
  // offering a control that could only ever fail.
  it("is absent for a non-admin", () => {
    const { container } = panel(undefined);
    expect(picker(container)).toBeNull();
    expect(container.textContent).not.toContain("Act as user");
  });

  it("lists the users an admin may act as, plus a way back to yourself", () => {
    const { container } = panel({
      users: () => ["ancamilea", "emo"],
      current: () => "",
      switchTo: () => {},
    });
    const sel = picker(container);
    expect(sel).not.toBeNull();
    const options = Array.from(sel!.options).map((o) => o.value);
    expect(options).toEqual(["", "ancamilea", "emo"]);
    expect(sel!.options[0].textContent).toContain("myself");
  });

  it("shows who the tab is currently acting as", () => {
    const { container } = panel({
      users: () => ["ancamilea", "emo"],
      current: () => "emo",
      switchTo: () => {},
    });
    expect(picker(container)!.value).toBe("emo");
  });

  it("switches on change", () => {
    const switchTo = vi.fn();
    const { container } = panel({
      users: () => ["ancamilea", "emo"],
      current: () => "",
      switchTo,
    });
    const sel = picker(container)!;
    sel.value = "emo";
    fireEvent.change(sel);
    expect(switchTo).toHaveBeenCalledWith("emo");
  });

  it("returns to your own lobby by selecting the empty option", () => {
    const switchTo = vi.fn();
    const { container } = panel({
      users: () => ["emo"],
      current: () => "emo",
      switchTo,
    });
    const sel = picker(container)!;
    sel.value = "";
    fireEvent.change(sel);
    expect(switchTo).toHaveBeenCalledWith("");
  });

  // Full read-write is the whole point and also the risk; the panel is where
  // it gets said in words, once, before the switch happens.
  it("says what the switch actually grants", () => {
    const { container } = panel({
      users: () => ["emo"],
      current: () => "",
      switchTo: () => {},
    });
    const group = Array.from(container.querySelectorAll(".tl-settings-group")).find(
      (g) => (g.textContent ?? "").includes("Act as user"),
    );
    const text = (group?.textContent ?? "").toLowerCase();
    expect(text).toContain("read-write");
    expect(text).toContain("recorded");
    expect(text).toContain("tab");
  });
});
