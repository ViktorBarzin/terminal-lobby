import { describe, it, expect, vi } from "vitest";
import { createRoot } from "solid-js";
import {
  createPreviewStore,
  DISCARD_MESSAGE,
  type PreviewDeps,
  type PreviewStore,
} from "../src/store/preview";
import { FileApiError, type LoadedFile } from "../src/lib/file-api";

function withStore(deps: PreviewDeps): [PreviewStore, () => void] {
  let store!: PreviewStore;
  const dispose = createRoot((d) => {
    store = createPreviewStore(deps);
    return d;
  });
  return [store, dispose];
}

const code = (text: string): (() => Promise<LoadedFile>) =>
  async () => ({ kind: "code", language: "typescript", text });

describe("preview store — entering edit mode", () => {
  it("beginEdit seeds the draft from the loaded text and starts clean", async () => {
    const [s, dispose] = withStore({ loadFile: code("const a = 1;") });
    await s.open("/a/b.ts");
    expect(s.editing()).toBe(false);
    expect(s.canEdit()).toBe(true);
    s.beginEdit();
    expect(s.editing()).toBe(true);
    expect(s.draft()).toBe("const a = 1;");
    expect(s.dirty()).toBe(false);
    dispose();
  });

  it("exposes the CodeMirror language key for the loaded path", async () => {
    const [s, dispose] = withStore({ loadFile: code("x") });
    await s.open("/a/main.go");
    expect(s.editLanguage()).toBe("go");
    dispose();
  });

  it("beginEdit is a no-op for non-editable kinds (image / binary)", async () => {
    const [img, d1] = withStore({ loadFile: async () => ({ kind: "image" }) });
    await img.open("/a/pic.png");
    expect(img.canEdit()).toBe(false);
    img.beginEdit();
    expect(img.editing()).toBe(false);
    d1();

    const [bin, d2] = withStore({ loadFile: async () => ({ kind: "binary", size: 9 }) });
    await bin.open("/a/x.bin");
    expect(bin.canEdit()).toBe(false);
    bin.beginEdit();
    expect(bin.editing()).toBe(false);
    d2();
  });

  it("markdown/html are editable (raw source)", async () => {
    const [s, dispose] = withStore({
      loadFile: async () => ({ kind: "markdown", text: "# hi" }),
    });
    await s.open("/a/readme.md");
    expect(s.canEdit()).toBe(true);
    dispose();
  });
});

describe("preview store — dirty tracking", () => {
  it("goes dirty on a change and clean again on revert", async () => {
    const [s, dispose] = withStore({ loadFile: code("v1") });
    await s.open("/a/b.ts");
    s.beginEdit();
    s.setDraft("v2");
    expect(s.dirty()).toBe(true);
    expect(s.unsaved()).toBe(true);
    s.setDraft("v1"); // back to saved content
    expect(s.dirty()).toBe(false);
    expect(s.unsaved()).toBe(false);
    dispose();
  });
});

describe("preview store — save maps to POST /files/write", () => {
  it("save() sends (path, draft) and on success clears dirty + updates the view + toasts", async () => {
    const writeFile = vi.fn(async () => {});
    const notify = vi.fn();
    const [s, dispose] = withStore({ loadFile: code("old"), writeFile, notify });
    await s.open("/home/u/a.ts");
    s.beginEdit();
    s.setDraft("new");
    expect(s.dirty()).toBe(true);

    await s.save();
    expect(writeFile).toHaveBeenCalledWith("/home/u/a.ts", "new");
    expect(s.dirty()).toBe(false);
    expect(s.unsaved()).toBe(false);
    expect(s.text()).toBe("new"); // read-only view reflects the save
    expect(notify).toHaveBeenCalledWith("Saved", "success");
    dispose();
  });

  it("save() is a no-op when the editor is clean (no write, no toast)", async () => {
    const writeFile = vi.fn(async () => {});
    const notify = vi.fn();
    const [s, dispose] = withStore({ loadFile: code("x"), writeFile, notify });
    await s.open("/a/b.ts");
    s.beginEdit();
    await s.save(); // clean
    expect(writeFile).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    dispose();
  });

  it.each([
    [413, /too large/i],
    [403, /not authorized/i],
    [404, /parent folder/i],
  ])(
    "a %i failure keeps the edit dirty and toasts the mapped error",
    async (status, re) => {
      const writeFile = vi.fn(async () => {
        throw new FileApiError(status, (await import("../src/lib/file-api")).writeErrorMessage(status));
      });
      const notify = vi.fn();
      const [s, dispose] = withStore({ loadFile: code("old"), writeFile, notify });
      await s.open("/a/b.ts");
      s.beginEdit();
      s.setDraft("new");
      await s.save();
      expect(writeFile).toHaveBeenCalledOnce();
      expect(s.dirty()).toBe(true); // still dirty — the user can retry
      expect(s.editing()).toBe(true);
      expect(s.text()).toBe("old"); // view NOT updated on failure
      const [msg, kind] = notify.mock.calls.at(-1)!;
      expect(kind).toBe("error");
      expect(msg).toMatch(re);
      dispose();
    },
  );

  it("sets saving() during the round-trip and clears it after", async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    const writeFile = vi.fn(async () => {
      await gate;
    });
    const [s, dispose] = withStore({ loadFile: code("a"), writeFile, notify: vi.fn() });
    await s.open("/a/b.ts");
    s.beginEdit();
    s.setDraft("b");
    const p = s.save();
    expect(s.saving()).toBe(true);
    resolve();
    await p;
    expect(s.saving()).toBe(false);
    dispose();
  });
});

describe("preview store — confirm-before-discard", () => {
  it("close() with unsaved edits prompts; declining keeps the overlay + editor open", async () => {
    const confirm = vi.fn(() => false);
    const [s, dispose] = withStore({ loadFile: code("a"), confirm });
    await s.open("/a/b.ts");
    s.beginEdit();
    s.setDraft("b");
    s.close();
    expect(confirm).toHaveBeenCalledWith(DISCARD_MESSAGE);
    expect(s.isOpen()).toBe(true); // stayed open
    expect(s.editing()).toBe(true);
    dispose();
  });

  it("close() with unsaved edits closes when confirmed", async () => {
    const confirm = vi.fn(() => true);
    const [s, dispose] = withStore({ loadFile: code("a"), confirm });
    await s.open("/a/b.ts");
    s.beginEdit();
    s.setDraft("b");
    s.close();
    expect(s.isOpen()).toBe(false);
    expect(s.editing()).toBe(false);
    dispose();
  });

  it("close() on a CLEAN editor never prompts", async () => {
    const confirm = vi.fn(() => false);
    const [s, dispose] = withStore({ loadFile: code("a"), confirm });
    await s.open("/a/b.ts");
    s.beginEdit(); // clean
    s.close();
    expect(confirm).not.toHaveBeenCalled();
    expect(s.isOpen()).toBe(false);
    dispose();
  });

  it("requestExitEdit prompts when dirty; declining stays in edit mode", async () => {
    const confirm = vi.fn(() => false);
    const [s, dispose] = withStore({ loadFile: code("a"), confirm });
    await s.open("/a/b.ts");
    s.beginEdit();
    s.setDraft("b");
    expect(s.requestExitEdit()).toBe(false);
    expect(s.editing()).toBe(true);
    confirm.mockReturnValue(true);
    expect(s.requestExitEdit()).toBe(true);
    expect(s.editing()).toBe(false);
    dispose();
  });

  it("switching files while dirty prompts; declining aborts the switch", async () => {
    const confirm = vi.fn(() => false);
    const loadFile = vi.fn(code("a"));
    const [s, dispose] = withStore({ loadFile, confirm });
    await s.open("/a/first.ts");
    s.beginEdit();
    s.setDraft("edited");
    await s.open("/a/second.ts"); // declined
    expect(s.path()).toBe("/a/first.ts"); // stayed
    expect(s.editing()).toBe(true);
    expect(loadFile).toHaveBeenCalledTimes(1); // second load never fired
    dispose();
  });

  it("switching files while dirty loads the new file when confirmed (editor reset)", async () => {
    const confirm = vi.fn(() => true);
    const [s, dispose] = withStore({ loadFile: code("a"), confirm });
    await s.open("/a/first.ts");
    s.beginEdit();
    s.setDraft("edited");
    await s.open("/a/second.ts");
    expect(s.path()).toBe("/a/second.ts");
    expect(s.editing()).toBe(false); // editor reset on the new file
    dispose();
  });

  it("toggleEdit enters from view and (clean) exits without a prompt", async () => {
    const confirm = vi.fn(() => false);
    const [s, dispose] = withStore({ loadFile: code("a"), confirm });
    await s.open("/a/b.ts");
    s.toggleEdit();
    expect(s.editing()).toBe(true);
    s.toggleEdit(); // clean → no prompt
    expect(s.editing()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    dispose();
  });
});
