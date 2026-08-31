import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SessionsPage } from "../src/components/settings/pages/SessionsPage";
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
  } as unknown as PrefsStore;
}

const picker = (c: HTMLElement) => c.querySelector<HTMLSelectElement>("#tl-set-newcmd")!;
const option = (c: HTMLElement, v: string) =>
  Array.from(picker(c).options).find((o) => o.value === v)!;

describe("Settings — New session runs", () => {
  // The same pref the sidebar's row writes, so it has to tell the same story.
  // Offering Codex here while the row greys it out would just move the dead
  // option somewhere less visible.
  it("disables a command the box cannot run", () => {
    const { container } = render(() => (
      <SessionsPage prefs={fakePrefs()} availableCommands={() => ({ codex: false })} />
    ));
    expect(option(container, "codex").disabled).toBe(true);
    expect(option(container, "codex").textContent).toMatch(/not installed/i);
    expect(option(container, "claude").disabled).toBe(false);
  });

  it("shows names rather than keys", () => {
    const { container } = render(() => <SessionsPage prefs={fakePrefs()} />);
    expect(option(container, "shell").textContent).toBe("Plain shell");
    expect(option(container, "claude").textContent).toBe("Claude");
  });

  it("disables nothing without an answer from the server", () => {
    const { container } = render(() => <SessionsPage prefs={fakePrefs()} />);
    for (const o of Array.from(picker(container).options)) {
      expect(o.disabled, `${o.value} disabled`).toBe(false);
    }
  });
});
