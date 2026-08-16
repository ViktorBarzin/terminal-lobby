import { describe, it, expect, beforeEach } from "vitest";
import {
  loadWatch,
  saveWatch,
  resolveWatch,
  WATCH_KEY_PREFIX,
} from "../src/store/watchmode";

/**
 * Auto-join: opening a session that someone is already DRIVING comes up
 * watching, so a second device never takes the grid from the first.
 *
 * This needs three states, not two. "I have never said" has to be
 * distinguishable from "I said drive" — otherwise clicking *take control* on a
 * session your desktop is still driving would be undone by the same rule that
 * put you in watch mode, and the button would do nothing.
 */
describe("resolveWatch — explicit choice beats the automatic one", () => {
  it("never chosen + nobody driving = drive (today's behaviour, unchanged)", () => {
    expect(resolveWatch(undefined, false)).toBe(false);
  });

  it("never chosen + someone driving = watch (the whole point)", () => {
    expect(resolveWatch(undefined, true)).toBe(true);
  });

  it("an explicit choice wins in both directions", () => {
    expect(resolveWatch(true, false)).toBe(true); // watch an idle session
    expect(resolveWatch(false, true)).toBe(false); // take control from the desktop
  });

  it("taking control is not undone by the session still being driven", () => {
    // The failure this guards: if "drive" were stored as absence, the auto rule
    // would immediately put the client back into watch mode and the button
    // would appear inert.
    expect(resolveWatch(false, true)).toBe(false);
  });
});

describe("watch storage — three states on the wire and on disk", () => {
  beforeEach(() => localStorage.clear());

  it("an untouched session reads as no choice, not as a choice to drive", () => {
    expect(loadWatch("foo")).toBeUndefined();
  });

  it("both choices persist and read back", () => {
    saveWatch("foo", true);
    expect(loadWatch("foo")).toBe(true);
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "foo")).toBe("ro");

    saveWatch("foo", false);
    expect(loadWatch("foo")).toBe(false);
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "foo")).toBe("rw");
  });

  it("clearing a choice returns the session to automatic", () => {
    saveWatch("foo", true);
    saveWatch("foo", undefined);
    expect(loadWatch("foo")).toBeUndefined();
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "foo")).toBeNull();
  });

  it("a value written by the two-state version still reads correctly", () => {
    // The shipped version stored "ro" for watching and removed the key
    // otherwise. Both still mean what they used to.
    localStorage.setItem(WATCH_KEY_PREFIX + "old", "ro");
    expect(loadWatch("old")).toBe(true);
    localStorage.removeItem(WATCH_KEY_PREFIX + "old");
    expect(loadWatch("old")).toBeUndefined();
  });

  it("junk reads as no choice, so a damaged key falls back to automatic", () => {
    for (const junk of ["", "yes", "RO", "true", "0"]) {
      localStorage.setItem(WATCH_KEY_PREFIX + "foo", junk);
      expect(loadWatch("foo")).toBeUndefined();
    }
  });
});
