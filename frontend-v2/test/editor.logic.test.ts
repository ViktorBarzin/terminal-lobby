import { describe, it, expect } from "vitest";
import {
  canEdit,
  cmLanguageForPath,
  editReduce,
  hasUnsavedChanges,
  initialEditState,
  isDirty,
  isEditing,
  type EditState,
} from "../src/store/editor.logic";

describe("cmLanguageForPath — extension -> CodeMirror language", () => {
  it("maps the JS/TS family, splitting tsx/jsx out (lang-javascript options)", () => {
    expect(cmLanguageForPath("/a/b.ts")).toBe("typescript");
    expect(cmLanguageForPath("/a/b.mts")).toBe("typescript");
    expect(cmLanguageForPath("/a/b.tsx")).toBe("tsx");
    expect(cmLanguageForPath("/a/b.js")).toBe("javascript");
    expect(cmLanguageForPath("/a/b.mjs")).toBe("javascript");
    expect(cmLanguageForPath("/a/b.jsx")).toBe("jsx");
  });

  it("maps the remaining common languages the task calls out", () => {
    expect(cmLanguageForPath("/a/data.json")).toBe("json");
    expect(cmLanguageForPath("/a/readme.md")).toBe("markdown");
    expect(cmLanguageForPath("/a/page.html")).toBe("html");
    expect(cmLanguageForPath("/a/x.htm")).toBe("html");
    expect(cmLanguageForPath("/a/styles.css")).toBe("css");
    expect(cmLanguageForPath("/a/app.py")).toBe("python");
    expect(cmLanguageForPath("/a/main.go")).toBe("go");
    expect(cmLanguageForPath("/a/conf.yaml")).toBe("yaml");
    expect(cmLanguageForPath("/a/conf.yml")).toBe("yaml");
    expect(cmLanguageForPath("/a/run.sh")).toBe("shell");
    expect(cmLanguageForPath("/a/.bashrc.bash")).toBe("shell");
  });

  it("is case-insensitive on the extension", () => {
    expect(cmLanguageForPath("/a/B.TS")).toBe("typescript");
    expect(cmLanguageForPath("/a/Main.GO")).toBe("go");
  });

  it("falls back to plain (undefined) for unknown or extension-less paths", () => {
    expect(cmLanguageForPath("/a/notes.txt")).toBeUndefined();
    expect(cmLanguageForPath("/a/data.bin")).toBeUndefined();
    expect(cmLanguageForPath("/a/LICENSE")).toBeUndefined();
    expect(cmLanguageForPath("/a/.env")).toBeUndefined();
  });
});

describe("canEdit — which loaded kinds are editable", () => {
  it("allows code, markdown, and html (raw source)", () => {
    expect(canEdit("code")).toBe(true);
    expect(canEdit("markdown")).toBe(true);
    expect(canEdit("html")).toBe(true);
  });

  it("forbids images, binaries, and the not-yet-loaded state", () => {
    expect(canEdit("image")).toBe(false);
    expect(canEdit("binary")).toBe(false);
    expect(canEdit(null)).toBe(false);
  });
});

describe("edit/dirty/save state machine (editReduce)", () => {
  const enter = (text: string): EditState =>
    editReduce(initialEditState, { type: "enter", text });

  it("enter seeds saved+draft and starts clean", () => {
    const s = enter("hello");
    expect(s).toEqual({ phase: "clean", saved: "hello", draft: "hello" });
    expect(isEditing(s)).toBe(true);
    expect(isDirty(s)).toBe(false);
    expect(hasUnsavedChanges(s)).toBe(false);
  });

  it("a change away from saved goes dirty; reverting back goes clean", () => {
    let s = enter("hello");
    s = editReduce(s, { type: "change", text: "hello!" });
    expect(s.phase).toBe("dirty");
    expect(isDirty(s)).toBe(true);
    expect(hasUnsavedChanges(s)).toBe(true);
    // revert to the exact saved content — dirty clears.
    s = editReduce(s, { type: "change", text: "hello" });
    expect(s.phase).toBe("clean");
    expect(isDirty(s)).toBe(false);
    expect(hasUnsavedChanges(s)).toBe(false);
  });

  it("ignores stray changes when idle (not editing)", () => {
    const s = editReduce(initialEditState, { type: "change", text: "x" });
    expect(s).toBe(initialEditState);
  });

  it("saveStart only applies to a dirty editor", () => {
    const clean = enter("a");
    expect(editReduce(clean, { type: "saveStart" })).toBe(clean); // no-op when clean
    const dirty = editReduce(clean, { type: "change", text: "b" });
    const saving = editReduce(dirty, { type: "saveStart" });
    expect(saving.phase).toBe("saving");
    // draft is still dirty vs saved during the round-trip.
    expect(hasUnsavedChanges(saving)).toBe(true);
    expect(isDirty(saving)).toBe(false); // "saving" is not the button-dirty state
  });

  it("saveOk promotes the sent content to saved and returns to clean", () => {
    let s = enter("a");
    s = editReduce(s, { type: "change", text: "b" });
    s = editReduce(s, { type: "saveStart" });
    s = editReduce(s, { type: "saveOk", text: "b" });
    expect(s).toEqual({ phase: "clean", saved: "b", draft: "b" });
    expect(hasUnsavedChanges(s)).toBe(false);
  });

  it("saveFail returns to dirty so the edit can be retried, keeping the draft", () => {
    let s = enter("a");
    s = editReduce(s, { type: "change", text: "b" });
    s = editReduce(s, { type: "saveStart" });
    s = editReduce(s, { type: "saveFail" });
    expect(s.phase).toBe("dirty");
    expect(s.draft).toBe("b");
    expect(s.saved).toBe("a");
    expect(isDirty(s)).toBe(true);
  });

  it("a keystroke during a save is retained, and confirming the OLD save leaves it dirty", () => {
    let s = enter("a");
    s = editReduce(s, { type: "change", text: "b" });
    s = editReduce(s, { type: "saveStart" });
    // user types again mid-round-trip; the in-flight save was for "b"
    s = editReduce(s, { type: "change", text: "bc" });
    expect(s.phase).toBe("saving"); // still saving
    expect(s.draft).toBe("bc"); // newer content kept, not lost
    // the "b" save resolves: baseline becomes "b" but draft "bc" is ahead, so
    // the editor is correctly dirty again (bc was never sent to the server).
    s = editReduce(s, { type: "saveOk", text: "b" });
    expect(s.saved).toBe("b");
    expect(s.draft).toBe("bc");
    expect(s.phase).toBe("dirty");
    expect(hasUnsavedChanges(s)).toBe(true);
  });

  it("exit resets to idle from any phase", () => {
    let s = enter("a");
    s = editReduce(s, { type: "change", text: "b" });
    expect(editReduce(s, { type: "exit" })).toEqual(initialEditState);
    expect(isEditing(editReduce(s, { type: "exit" }))).toBe(false);
  });
});
