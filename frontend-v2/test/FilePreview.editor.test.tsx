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
