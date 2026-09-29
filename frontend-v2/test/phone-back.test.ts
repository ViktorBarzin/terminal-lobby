/**
 * The phone's Back goes from a session to the list, as the header's round
 * back button does.
 *
 * Deployed review round 1 of the T3 pass (2026-09-29): opening a session only
 * replaced the history entry, so Android's Back had nothing of the lobby's to
 * go back to and left it, closing the installed app. With an earlier entry it
 * changed the URL to "/" while the session stayed on screen, and a reload then
 * opened the New session screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { enterContent, leaveContent, listenPhoneBack } from "../src/lib/phone-back";

const popped = (): Promise<void> =>
  new Promise((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));

describe("the phone's session entry", () => {
  let showing: "list" | "content" | null;
  const toList = vi.fn(() => {
    showing = "list";
  });
  const toContent = vi.fn(() => {
    showing = "content";
  });
  let stop: () => void;

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    showing = "list";
    toList.mockClear();
    toContent.mockClear();
    stop = listenPhoneBack({ showing: () => showing, toList, toContent });
  });
  afterEach(() => stop());

  it("opening a session leaves an entry under it, the list's, with no session in its URL", async () => {
    window.history.replaceState(null, "", "/#alpha");
    const before = window.history.length;
    enterContent();
    showing = "content";
    expect(window.history.length).toBe(before + 1);
    expect(window.location.hash).toBe("#alpha");
    const back = popped();
    window.history.back();
    await back;
    expect(window.location.hash).toBe("");
    expect(toList).toHaveBeenCalledTimes(1);
    expect(showing).toBe("list");
  });

  it("does not stack a second entry for the screen it is already on", () => {
    enterContent();
    const after = window.history.length;
    enterContent();
    expect(window.history.length).toBe(after);
  });

  it("Forward from the list comes back to the session", async () => {
    window.history.replaceState(null, "", "/#alpha");
    enterContent();
    showing = "content";
    let pop = popped();
    window.history.back();
    await pop;
    pop = popped();
    window.history.forward();
    await pop;
    expect(toContent).toHaveBeenCalledTimes(1);
    expect(showing).toBe("content");
  });

  it("leaves an overlay's own entry to the overlay", async () => {
    enterContent();
    showing = "content";
    window.history.pushState({ tlOverlay: 1 }, "", window.location.href);
    const pop = popped();
    window.history.back();
    await pop;
    expect(toList).not.toHaveBeenCalled();
    expect(showing).toBe("content");
  });

  it("does nothing on a device that is not the phone layout", async () => {
    enterContent();
    showing = null;
    const pop = popped();
    window.history.back();
    await pop;
    expect(toList).not.toHaveBeenCalled();
  });

  it("the header's back button takes the session's entry back off", async () => {
    enterContent();
    showing = "content";
    const fallback = vi.fn();
    const pop = popped();
    leaveContent(fallback);
    await pop;
    expect(fallback).not.toHaveBeenCalled();
    expect(toList).toHaveBeenCalledTimes(1);
  });

  it("the header's back button with no session entry under it falls back", () => {
    const fallback = vi.fn();
    leaveContent(fallback);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
