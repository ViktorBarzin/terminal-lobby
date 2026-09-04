import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { PREF_DEFAULTS, type Prefs, type PrefsStore } from "../src/store/prefs";

/**
 * The rail is the whole navigation surface, so the behaviour it replaced a
 * 2,400px scroll with is worth holding down: one page renders at a time, ↑↓
 * walk the rail from the moment the panel opens, and where you were is where
 * you come back to.
 */

const LAST_PAGE_KEY = "tl:settings:page";

beforeEach(() => localStorage.removeItem(LAST_PAGE_KEY));
afterEach(cleanup);

function fakePrefs(): PrefsStore {
  const [prefs] = createSignal<Prefs>(structuredClone(PREF_DEFAULTS));
  return { prefs, setPref() {}, setFontSize() {}, async bootSync() {}, dispose() {} };
}

const panel = (initialPage?: Parameters<typeof SettingsPanel>[0]["initialPage"]) =>
  render(() => (
    <SettingsPanel prefs={fakePrefs()} onClose={() => {}} initialPage={initialPage} />
  ));

const rail = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>(".tl-set-rail-item")];
const onPage = (c: HTMLElement) =>
  c.querySelector(".tl-set-rail-item.is-on")?.textContent;
const title = (c: HTMLElement) => c.querySelector(".tl-set-page-title")?.textContent;

describe("the Settings rail", () => {
  it("shows one page at a time, not every group at once", () => {
    const { container } = panel();
    expect(title(container)).toBe("Appearance");
    // The theme grid is here; the terminal steppers and the byte breakdown
    // are not, which is the whole point of the rail.
    expect(container.querySelector(".tl-set-swatches")).toBeTruthy();
    expect(container.querySelector(".tl-set-stepper")).toBeNull();
    expect(container.querySelector(".tl-netusage")).toBeNull();
  });

  it("swaps the page on a rail click", async () => {
    const { container } = panel();
    fireEvent.click(rail(container).find((r) => r.textContent === "Terminal")!);
    await waitFor(() => expect(title(container)).toBe("Terminal"));
    expect(container.querySelector(".tl-set-stepper")).toBeTruthy();
    expect(container.querySelector(".tl-set-swatches")).toBeNull();
  });

  it("takes focus on the selected entry, so ↑↓ work immediately", async () => {
    panel();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Appearance"),
    );
    expect((document.activeElement as HTMLElement).getAttribute("role")).toBe("tab");
  });

  it("walks with the arrow keys and stops at both ends", async () => {
    const { container } = panel();
    // Initial focus is deferred a microtask, like the command palette's.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Appearance"));
    const down = () => fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    const up = () => fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });

    down();
    await waitFor(() => expect(onPage(container)).toBe("Terminal"));
    down();
    await waitFor(() => expect(onPage(container)).toBe("Sessions"));
    up();
    await waitFor(() => expect(onPage(container)).toBe("Terminal"));

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    await waitFor(() => expect(onPage(container)).toBe("Appearance"));
    up(); // already at the top
    await waitFor(() => expect(onPage(container)).toBe("Appearance"));

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    await waitFor(() => expect(onPage(container)).toBe("Skills"));
    down(); // already at the bottom
    await waitFor(() => expect(onPage(container)).toBe("Skills"));
  });

  it("keeps a roving tabindex, so Tab reaches the rail once", async () => {
    const { container } = panel();
    const tabbable = rail(container).filter((r) => r.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]!.textContent).toBe("Appearance");
  });

  it("reopens on the page you left it on", async () => {
    const first = panel();
    fireEvent.click(rail(first.container).find((r) => r.textContent === "Network")!);
    await waitFor(() => expect(localStorage.getItem(LAST_PAGE_KEY)).toBe("network"));
    cleanup();

    const { container } = panel();
    expect(title(container)).toBe("Network");
  });

  it("lets an opener ask for a page without making it the remembered one", async () => {
    // The header's Skills button comes in this way. Someone who then closes
    // and reaches for the gear should land where they last NAVIGATED to.
    localStorage.setItem(LAST_PAGE_KEY, "terminal");
    const { container } = panel("skills");
    expect(title(container)).toBe("Skills");
    expect(localStorage.getItem(LAST_PAGE_KEY)).toBe("terminal");
  });

  it("falls back to the first page when the remembered one is not on offer", () => {
    // Stored by an admin tab, read back by a caller with no act-as control.
    localStorage.setItem(LAST_PAGE_KEY, "actas");
    const { container } = panel();
    expect(title(container)).toBe("Appearance");
  });

  it("reports the page showing, not the page it was sent to", async () => {
    // Whoever opened it needs this: the rail moves the page afterwards, and an
    // opener holding its own copy would say the wrong thing about its button.
    const seen: string[] = [];
    const { container } = render(() => (
      <SettingsPanel
        prefs={fakePrefs()}
        onClose={() => {}}
        initialPage="skills"
        onPageChange={(id) => seen.push(id)}
      />
    ));
    await waitFor(() => expect(seen).toEqual(["skills"]));

    fireEvent.click(rail(container).find((r) => r.textContent === "Terminal")!);
    await waitFor(() => expect(seen).toEqual(["skills", "terminal"]));
  });

  it("moves to a page an opener asks for while it is already open", async () => {
    // The header's Skills button pressed over an open Settings. It must switch
    // pages rather than leave the panel where it was.
    const [asked, setAsked] = createSignal<"terminal" | "skills">("terminal");
    const { container } = render(() => (
      <SettingsPanel prefs={fakePrefs()} onClose={() => {}} initialPage={asked()} />
    ));
    expect(title(container)).toBe("Terminal");

    setAsked("skills");
    await waitFor(() => expect(title(container)).toBe("Skills"));
    // Being sent somewhere is not navigating there, so nothing is remembered.
    expect(localStorage.getItem(LAST_PAGE_KEY)).toBeNull();
  });

  it("steps into the page on Enter, so the keyboard is not stuck on the rail", async () => {
    const { container } = panel("terminal");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Terminal"));

    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await waitFor(() => {
      const page = container.querySelector(".tl-set-page")!;
      expect(page.contains(document.activeElement)).toBe(true);
    });
  });

  it("adds the admin page, below its own rule, only for an admin", () => {
    const admin = render(() => (
      <SettingsPanel
        prefs={fakePrefs()}
        onClose={() => {}}
        actAs={{ users: () => ["bob"], current: () => "", switchTo: () => {} }}
      />
    ));
    const entry = rail(admin.container).at(-1)!;
    expect(entry.textContent).toBe("Act as user");
    expect(entry.classList.contains("starts-group")).toBe(true);
    cleanup();

    const { container } = panel();
    expect(rail(container).map((r) => r.textContent)).not.toContain("Act as user");
  });
});

describe("a settings row", () => {
  it("keeps an explanation behind the ⓘ until it is asked for", async () => {
    const { container, getByLabelText } = panel("terminal");
    expect(container.textContent).not.toContain("does nothing while that is off");

    const info = getByLabelText("Explain Scroll speed");
    expect(info.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(info);
    await waitFor(() =>
      expect(container.textContent).toContain("does nothing while that is off"),
    );
    expect(info.getAttribute("aria-expanded")).toBe("true");
    expect(info.getAttribute("aria-controls")).toBe(
      container.querySelector(".tl-set-hint")?.id,
    );

    fireEvent.click(info);
    await waitFor(() =>
      expect(container.textContent).not.toContain("does nothing while that is off"),
    );
  });

  it("marks what does not roam, and leaves what does unmarked", () => {
    const { container } = panel("terminal");
    const chipped = [...container.querySelectorAll(".tl-set-row")].filter((r) =>
      r.querySelector(".tl-set-chip"),
    );
    // Two rows on this page live in the browser rather than the account, in
    // page order: which terminal to render, the per-device escape hatch the
    // flip rests on and the only one an installed app has, then flow control.
    expect(chipped.map((r) => r.querySelector(".tl-set-row-label")?.textContent)).toEqual([
      "Engine",
      "Flow control",
    ]);
    // Everything else on this page is roamed, so nothing else is marked.
    expect(container.querySelectorAll(".tl-set-chip")).toHaveLength(2);
  });

  it("draws toggles as switches, still operable as checkboxes", () => {
    const { container } = panel("terminal");
    const blink = [...container.querySelectorAll<HTMLInputElement>(".tl-set-toggle")].at(0)!;
    expect(blink.type).toBe("checkbox");
    expect(blink.getAttribute("role")).toBe("switch");
  });
});
