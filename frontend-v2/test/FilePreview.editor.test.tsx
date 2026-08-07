import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { FilePreview } from "../src/components/FilePreview";
import { createPreviewStore, type PreviewDeps, type PreviewStore } from "../src/store/preview";
import type { LoadedFile } from "../src/lib/file-api";

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length) roots.pop()!();
});

function makeStore(deps: PreviewDeps): PreviewStore {
  let store!: PreviewStore;
  const dispose = createRoot((d) => {
    store = createPreviewStore(deps);
    return d;
  });
  roots.push(dispose);
  return store;
}

const codeFile = (text: string): (() => Promise<LoadedFile>) =>
  async () => ({ kind: "code", language: "typescript", text });

describe("<FilePreview> — quick-edit mode", () => {
  it("shows an Edit button for editable files and enters edit mode (mounts CodeMirror)", async () => {
    const store = makeStore({ loadFile: codeFile("const a = 1;"), notify: vi.fn() });
    await store.open("/a/b.ts");
    const { getByRole, container } = render(() => <FilePreview store={store} />);

    const edit = getByRole("button", { name: "Edit" });
    fireEvent.click(edit);
    expect(store.editing()).toBe(true);
    // the read-only code body is replaced by the CodeMirror editor (lazy mount).
    await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy());
    // Save is present but disabled while clean; a View button exits.
    const save = getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(getByRole("button", { name: "View" })).toBeInTheDocument();
  });

  it("does NOT show an Edit button for images", async () => {
    const store = makeStore({ loadFile: async () => ({ kind: "image" }) });
    await store.open("/a/pic.png");
    const { queryByRole } = render(() => <FilePreview store={store} />);
    expect(queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("Ctrl-S while editing saves the draft via writeFile", async () => {
    const writeFile = vi.fn(async () => {});
    const notify = vi.fn();
    const store = makeStore({ loadFile: codeFile("old"), writeFile, notify });
    await store.open("/home/u/a.ts");
    render(() => <FilePreview store={store} />);

    store.beginEdit();
    store.setDraft("edited via editor"); // stands in for a CodeMirror change
    expect(store.dirty()).toBe(true);

    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith("/home/u/a.ts", "edited via editor"));
    expect(store.dirty()).toBe(false);
    expect(notify).toHaveBeenCalledWith("Saved", "success");
  });

  it("clicking Save writes the draft; the Save button is enabled only when dirty", async () => {
    const writeFile = vi.fn(async () => {});
    const store = makeStore({ loadFile: codeFile("old"), writeFile, notify: vi.fn() });
    await store.open("/a/b.ts");
    const { getByRole } = render(() => <FilePreview store={store} />);

    fireEvent.click(getByRole("button", { name: "Edit" }));
    const save = () => getByRole("button", { name: /Save|Saving/ }) as HTMLButtonElement;
    expect(save().disabled).toBe(true); // clean

    store.setDraft("new"); // becomes dirty
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.click(save());
    await waitFor(() => expect(writeFile).toHaveBeenCalledWith("/a/b.ts", "new"));
  });

  it("hides the raw/rendered toggle while editing markdown", async () => {
    const store = makeStore({
      loadFile: async () => ({ kind: "markdown", text: "# hi" }),
      notify: vi.fn(),
    });
    await store.open("/a/readme.md");
    const { getByRole, queryByRole } = render(() => <FilePreview store={store} />);
    // view mode: the toggle is present.
    expect(getByRole("button", { name: "Rendered" })).toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: "Edit" }));
    // edit mode: raw source only — the toggle is gone.
    expect(queryByRole("button", { name: "Rendered" })).toBeNull();
    expect(queryByRole("button", { name: "Raw" })).toBeNull();
  });
});

/**
 * Escape must step down the stack the user can SEE. The browse pane is the
 * top <Match> of the body switch and hides the Edit/Save/View controls, so an
 * editor open behind it is off-screen — yet Escape used to ask "Discard unsaved
 * changes?" about that invisible editor, and accepting it destroyed the draft
 * with nothing on screen changing at all. The user found out at Done.
 */
describe("<FilePreview> — Escape follows the stack you can see", () => {
  const dir = "/tmp/qa-harness-scratch/vfp";

  /** A loaded, editable file with an empty browse listing available. */
  async function openFile(
    confirm: (m: string) => boolean,
  ): Promise<PreviewStore> {
    const store = makeStore({
      loadFile: codeFile("baseline\n"),
      listDir: async () => [],
      writeFile: vi.fn(async () => {}),
      notify: vi.fn(),
      confirm,
    });
    await store.open(`${dir}/notes.txt`);
    return store;
  }

  const esc = (): boolean => fireEvent.keyDown(document, { key: "Escape" });

  it("closes Browse first and leaves the dirty editor — and its draft — intact", async () => {
    const confirm = vi.fn(() => true);
    const store = await openFile(confirm);
    render(() => <FilePreview store={store} />);

    store.beginEdit();
    store.setDraft("baseline\nDRAFT-KEEPME");
    await store.browse(dir);
    expect(store.browsing()).toBe(true);

    esc();

    // The layer on screen is the one that closed; nothing was discarded.
    expect(store.browsing()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(store.editing()).toBe(true);
    expect(store.unsaved()).toBe(true);
    expect(store.draft()).toBe("baseline\nDRAFT-KEEPME");
  });

  // The browse pane REPLACES the body, so CodeMirror is unmounted while it is
  // open and rebuilt when it closes — from `initialText`, which was the last
  // SAVED text. The store still held the draft (dirty dot on, Save enabled), so
  // the editor came back showing the file on disk while the app was one Save
  // away from writing something else. Only reachable through Done before
  // Escape stopped discarding the draft; now it is the normal way back.
  it("brings the draft back with the editor when Browse closes", async () => {
    const store = await openFile(() => true);
    const { container } = render(() => <FilePreview store={store} />);

    store.beginEdit();
    await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    store.setDraft("baseline\nDRAFT-KEEPME");
    await store.browse(dir);
    expect(container.querySelector(".cm-content")).toBeNull(); // covered by Browse

    esc(); // back to the editor

    await waitFor(() =>
      expect(container.querySelector(".cm-content")?.textContent).toContain(
        "DRAFT-KEEPME",
      ),
    );
    expect(store.unsaved()).toBe(true);
  });

  it("prompts only once the editor is the layer on screen", async () => {
    const confirm = vi.fn(() => true);
    const store = await openFile(confirm);
    render(() => <FilePreview store={store} />);

    store.beginEdit();
    store.setDraft("baseline\nDRAFT-KEEPME");
    await store.browse(dir);

    esc(); // 1 — Browse
    expect(confirm).not.toHaveBeenCalled();
    esc(); // 2 — the editor, now visible: this one is allowed to ask
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(store.editing()).toBe(false);
    expect(store.isOpen()).toBe(true); // the overlay survives the discard
  });

  it("keeps the draft when the discard prompt is declined", async () => {
    const confirm = vi.fn(() => false);
    const store = await openFile(confirm);
    render(() => <FilePreview store={store} />);

    store.beginEdit();
    store.setDraft("baseline\nDRAFT-KEEPME");
    await store.browse(dir);

    esc(); // Browse
    esc(); // the editor — declined
    expect(store.editing()).toBe(true);
    expect(store.draft()).toBe("baseline\nDRAFT-KEEPME");
  });

  it("takes exactly two Escapes for the two visible layers (Browse over a file)", async () => {
    const store = await openFile(() => true);
    render(() => <FilePreview store={store} />);

    await store.browse(dir);
    esc();
    expect(store.browsing()).toBe(false);
    expect(store.isOpen()).toBe(true);
    esc();
    expect(store.isOpen()).toBe(false);
  });

  it("never spends an Escape on an invisible layer (clean editor behind Browse)", async () => {
    const store = await openFile(() => true);
    render(() => <FilePreview store={store} />);

    store.beginEdit(); // clean — no draft typed
    await store.browse(dir);

    // Every press changes something the user can see: Browse, then the editor
    // it was hiding, then the overlay. No silent no-op in the ladder.
    esc();
    expect([store.browsing(), store.editing(), store.isOpen()]).toEqual([
      false,
      true,
      true,
    ]);
    esc();
    expect([store.browsing(), store.editing(), store.isOpen()]).toEqual([
      false,
      false,
      true,
    ]);
    esc();
    expect(store.isOpen()).toBe(false);
  });
});
