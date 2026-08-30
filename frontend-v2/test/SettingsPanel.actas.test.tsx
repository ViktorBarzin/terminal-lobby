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

/**
 * The picker is its own rail page now, below a rule, and the page exists only
 * for a caller who administers the box. `initialPage` asks for it directly;
 * for a non-admin the rail has no such entry and the panel falls back to the
 * first page, which is exactly the behaviour worth asserting.
 */
function panel(actAs?: ActAsControl) {
  return render(() => (
    <SettingsPanel
      prefs={fakePrefs()}
      onClose={() => {}}
      initialPage="actas"
      actAs={actAs}
    />
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
      users: () => ["carol", "bob"],
      current: () => "",
      switchTo: () => {},
    });
    const sel = picker(container);
    if (!sel) throw new Error("expected the act-as picker to render");
    const options = Array.from(sel.options);
    expect(options.map((o) => o.value)).toEqual(["", "carol", "bob"]);
    expect(options.map((o) => o.textContent ?? "")[0]).toContain("myself");
  });

  it("shows who the tab is currently acting as", () => {
    const { container } = panel({
      users: () => ["carol", "bob"],
      current: () => "bob",
      switchTo: () => {},
    });
    expect(picker(container)!.value).toBe("bob");
  });

  it("switches on change", () => {
    const switchTo = vi.fn();
    const { container } = panel({
      users: () => ["carol", "bob"],
      current: () => "",
      switchTo,
    });
    const sel = picker(container)!;
    sel.value = "bob";
    fireEvent.change(sel);
    expect(switchTo).toHaveBeenCalledWith("bob");
  });

  it("returns to your own lobby by selecting the empty option", () => {
    const switchTo = vi.fn();
    const { container } = panel({
      users: () => ["bob"],
      current: () => "bob",
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
      users: () => ["bob"],
      current: () => "",
      switchTo: () => {},
    });
    // A note, not a hint: it describes what the switch DOES rather than
    // explaining the control, so it stays in the page instead of going behind
    // the ⓘ with the explanatory ones.
    const note = container.querySelector(".tl-set-note");
    const text = (note?.textContent ?? "").toLowerCase();
    expect(text).toContain("read-write");
    expect(text).toContain("recorded");
    expect(text).toContain("tab");
  });
});
