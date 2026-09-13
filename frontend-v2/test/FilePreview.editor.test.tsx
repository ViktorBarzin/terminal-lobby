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

const codeFile =
  (text: string): (() => Promise<LoadedFile>) =>
  async () => ({ kind: "code", language: "typescript", text });

/**
 * How long CodeMirror is given to appear, and the budget the test around it
 * needs so that wait can actually be spent.
 *
 * TWO NUMBERS, because one of them alone does nothing. `waitFor` gives up after
 * its own timeout, but vitest kills the whole test at `testTimeout` first, and
 * that default is 5,000ms — so a 15,000ms `waitFor` inside a default-budget
 * test is a number that can never be reached. Measured on 2026-09-12: with ten
 * spinners on the pinned core this file failed with "Test timed out in 5000ms"
 * while its `waitFor` still claimed 15 seconds of patience. `CodeView.test.tsx`
 * is the file that already had this right — a 20,000ms `waitFor` inside
 * `}, 30_000)` tests — and this one carried the wait without the test budget.
 *
 * Why the waits are long at all: `CodeEditor` reaches the editor through
 * `await import("./codemirror-view")`, which pulls the whole @codemirror graph
 * through vite-node the first time any test in this file asks for it. Measured
 * the same day, cold, on this 32-core devvm:
 *
 *   this file to itself                 612ms
 *   pinned to one core                  770ms
 *   one core, three spinners          3,031ms
 *   one core, ten spinners           >5,000ms (killed at testTimeout)
 *
 * A full run is the third row: 31 isolated workers competing for transforms on
 * one main thread, on a box already carrying other work. So these are not
 * padding for a slow machine, they are the real cost of the import under the
 * only conditions the suite ever runs in. Nothing here waits on a clock — a
 * `waitFor` returns the moment its condition holds, so an idle machine pays
 * none of it.
 */
const EDITOR_WAIT_MS = 15_000;
/** Comfortably past {@link EDITOR_WAIT_MS}, so the wait is what decides. */
const EDITOR_TEST_MS = 20_000;

describe("<FilePreview> — quick-edit mode", () => {
  it(
    "shows an Edit button for editable files and enters edit mode (mounts CodeMirror)",
    async () => {
      const store = makeStore({ loadFile: codeFile("const a = 1;"), notify: vi.fn() });
      await store.open("/a/b.ts");
      const { getByRole, container } = render(() => <FilePreview store={store} />);

      const edit = getByRole("button", { name: "Edit" });
      fireEvent.click(edit);
      expect(store.editing()).toBe(true);
      // The read-only code body is replaced by the CodeMirror editor (lazy
      // mount). This is the COLD import of the whole editor, so it carries the
      // explicit budget above rather than waitFor's 1s default.
      await waitFor(() => expect(container.querySelector(".cm-editor")).toBeTruthy(), {
        timeout: EDITOR_WAIT_MS,
      });
      // Save is present but disabled while clean; a View button exits.
      const save = getByRole("button", { name: "Save" }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      expect(getByRole("button", { name: "View" })).toBeInTheDocument();
    },
    EDITOR_TEST_MS,
  );

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
    await waitFor(() =>
      expect(writeFile).toHaveBeenCalledWith("/home/u/a.ts", "edited via editor"),
    );
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
  async function openFile(confirm: (m: string) => boolean): Promise<PreviewStore> {
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
  it(
    "brings the draft back with the editor when Browse closes",
    async () => {
      const store = await openFile(() => true);
      const { container } = render(() => <FilePreview store={store} />);

      store.beginEdit();
      // Both waits below are the editor mounting, so both carry the editor budget.
      // This one was the 1s default until 2026-09-12 and is the assertion that
      // failed a full suite run while passing on its own — the same cold import
      // the first test in this file was already given 15 seconds for, waited on
      // with the default in the file that documents why the default is not enough.
      await waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy(), {
        timeout: EDITOR_WAIT_MS,
      });
      store.setDraft("baseline\nDRAFT-KEEPME");
      await store.browse(dir);
      expect(container.querySelector(".cm-content")).toBeNull(); // covered by Browse

      esc(); // back to the editor

      // Browse unmounted CodeMirror, so this is a second mount, not a re-render.
      await waitFor(
        () => expect(container.querySelector(".cm-content")?.textContent).toContain("DRAFT-KEEPME"),
        { timeout: EDITOR_WAIT_MS },
      );
      expect(store.unsaved()).toBe(true);
    },
    EDITOR_TEST_MS,
  );

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
    expect([store.browsing(), store.editing(), store.isOpen()]).toEqual([false, true, true]);
    esc();
    expect([store.browsing(), store.editing(), store.isOpen()]).toEqual([false, false, true]);
    esc();
    expect(store.isOpen()).toBe(false);
  });
});
