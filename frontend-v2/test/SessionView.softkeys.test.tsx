/**
 * The soft-key toolbar belongs to the TERMINAL view.
 *
 * Its keys are terminal affordances — Esc, ⇧Tab, the arrows, Ctrl/Alt, Copy,
 * Paste. Text mode has a text field and a Send button, not a pty, so on a phone
 * the row (two rows, with the ⋯ tier open) sat above the keyboard doing nothing
 * for the view it was in. Viktor asked for text mode to be just the text area
 * (2026-08-17).
 *
 * The toolbar must UNMOUNT rather than hide, because its own cleanup is what
 * hands `--sk-h` back: the views reserve that height (app.css,
 * `body.has-soft-keys .tl-views`), so a hidden-but-mounted toolbar would keep
 * the composer floating an inch above the keyboard.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render } from "@solidjs/testing-library";
import { fireEvent } from "@solidjs/testing-library";
import { SessionView } from "../src/components/SessionView";

const realMatchMedia = window.matchMedia;

/** A coarse-pointer phone, which is the only place the toolbar renders at all. */
function stubPhone(): void {
  window.matchMedia = ((q: string) =>
    ({
      media: q,
      matches: q.includes("pointer: coarse") || /max-width:\s*(3|4|5|6|7)\d\dpx/.test(q),
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

const viewMode = (root: HTMLElement): string | null =>
  root.querySelector(".tl-session-view")?.getAttribute("data-mode") ?? null;

const segment = (root: HTMLElement, title: RegExp): HTMLButtonElement => {
  const b = Array.from(
    root.querySelectorAll<HTMLButtonElement>(".tl-viewswitch .tl-seg"),
  ).find((el) => title.test(el.getAttribute("title") ?? ""));
  expect(b, `the ${title} segment`).toBeTruthy();
  return b!;
};

describe("<SessionView> — the soft keys are the terminal view's", () => {
  afterEach(() => {
    window.matchMedia = realMatchMedia;
    document.documentElement.style.removeProperty("--sk-h");
  });

  it("shows them in the terminal view", () => {
    stubPhone();
    const { container } = render(() => <SessionView session="qa-softkeys" />);
    fireEvent.click(segment(container as HTMLElement, /Terminal/i));
    expect(viewMode(container as HTMLElement)).toBe("terminal");
    expect(document.getElementById("soft-keys")).not.toBeNull();
  });

  it("does not show them in the text view", () => {
    stubPhone();
    const { container } = render(() => <SessionView session="qa-softkeys" />);
    fireEvent.click(segment(container as HTMLElement, /Text/i));
    expect(viewMode(container as HTMLElement)).toBe("text");
    expect(document.getElementById("soft-keys")).toBeNull();
  });

  it("comes back when the terminal does", () => {
    // The gate has to run both ways: going to text once must not cost the
    // terminal its keys for the rest of the session.
    stubPhone();
    const { container } = render(() => <SessionView session="qa-softkeys" />);
    fireEvent.click(segment(container as HTMLElement, /Text/i));
    expect(document.getElementById("soft-keys")).toBeNull();
    fireEvent.click(segment(container as HTMLElement, /Terminal/i));
    expect(document.getElementById("soft-keys")).not.toBeNull();
  });

  // The reservation RULE stays on in text mode — it just reserves 0 for a
  // toolbar instead of a toolbar's height — but the class is written by the
  // APP, not here. It is one piece of shared document state and this component
  // is mounted once per kept session, so a per-session writer let the first
  // session to close take the reservation from all the others (installSoftKeysReserve,
  // and test/softkeys-reserve.test.ts, which owns that behaviour now).
  it("does not write the shared body class itself", () => {
    stubPhone();
    document.body.classList.remove("has-soft-keys");
    const { container } = render(() => <SessionView session="qa-softkeys" />);
    fireEvent.click(segment(container as HTMLElement, /Text/i));
    expect(document.body.classList.contains("has-soft-keys")).toBe(false);
  });
});
