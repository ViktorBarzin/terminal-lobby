import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { FilePreview } from "../src/components/FilePreview";
import { createPreviewStore, type PreviewStore } from "../src/store/preview";
import type { LoadedFile } from "../src/lib/file-api";
import { FileApiError } from "../src/lib/file-api";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length) roots.pop()!();
});

function makeStore(deps: Parameters<typeof createPreviewStore>[0]): PreviewStore {
  let store!: PreviewStore;
  const dispose = createRoot((d) => {
    store = createPreviewStore(deps);
    return d;
  });
  roots.push(dispose);
  return store;
}

async function loaded(loadFile: () => Promise<LoadedFile>, path: string): Promise<PreviewStore> {
  const store = makeStore({ loadFile });
  await store.open(path);
  return store;
}

describe("<FilePreview> — HTML sandbox (hard security requirement)", () => {
  it("renders user HTML in a sandboxed iframe: sandbox present, no scripts, no same-origin, srcdoc only", async () => {
    const html = "<h1>hi</h1><script>window.__pwned=1</script>";
    const store = await loaded(async () => ({ kind: "html", text: html }), "/a/page.html");
    const { container } = render(() => <FilePreview store={store} />);

    const iframe = container.querySelector("iframe");
    expect(iframe).toBeTruthy();
    // sandbox attribute is PRESENT ...
    expect(iframe!.hasAttribute("sandbox")).toBe(true);
    const sb = iframe!.getAttribute("sandbox") ?? "__missing__";
    // ... and never enables scripts or same-origin (would let user HTML run
    // against the authed origin).
    expect(sb).not.toContain("allow-same-origin");
    expect(sb).not.toContain("allow-scripts");
    // content comes via srcdoc, never a same-origin src.
    expect(iframe!.getAttribute("srcdoc")).toBe(html);
    expect(iframe!.hasAttribute("src")).toBe(false);
  });

  it("the sandboxed iframe truly cannot execute the embedded script", async () => {
    // A live sanity check that the sandbox is doing its job in jsdom: srcdoc runs
    // synchronously on attach, so if scripts were allowed the global would be set.
    const html = "<script>window.__pwned = true</script>";
    const store = await loaded(async () => ({ kind: "html", text: html }), "/a/x.html");
    render(() => <FilePreview store={store} />);
    await new Promise((r) => setTimeout(r, 0));
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});

describe("<FilePreview> — markdown raw/rendered toggle", () => {
  it("renders markdown by default and swaps to raw source on toggle", async () => {
    const md = "# Title\n\nsome **bold** text";
    const store = await loaded(async () => ({ kind: "markdown", text: md }), "/a/readme.md");
    const { container, getByRole } = render(() => <FilePreview store={store} />);

    // rendered: markdown produced real elements, no iframe.
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("iframe")).toBeNull();

    // toggle to raw: the markdown is no longer rendered; the source is shown.
    fireEvent.click(getByRole("button", { name: "Raw" }));
    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).toContain("# Title");

    // toggle back to rendered.
    fireEvent.click(getByRole("button", { name: "Rendered" }));
    expect(container.querySelector("h1")?.textContent).toBe("Title");
  });

  it("shows the raw|rendered toggle only for markdown/html (not code)", async () => {
    const store = await loaded(
      async () => ({ kind: "code", language: "typescript", text: "const a=1" }),
      "/a/x.ts",
    );
    const { queryByRole } = render(() => <FilePreview store={store} />);
    expect(queryByRole("button", { name: "Rendered" })).toBeNull();
    expect(queryByRole("button", { name: "Raw" })).toBeNull();
  });
});

describe("<FilePreview> — renders per kind + states", () => {
  it("image: an <img> pointed at the /files/read URL", async () => {
    const store = await loaded(async () => ({ kind: "image" }), "/a/pic.png");
    const { container } = render(() => <FilePreview store={store} />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toContain("/files/read?path=");
    expect(img!.getAttribute("src")).toContain(encodeURIComponent("/a/pic.png"));
  });

  it("code: the source text is shown", async () => {
    const store = await loaded(
      async () => ({ kind: "code", language: "python", text: "print('hello')" }),
      "/a/x.py",
    );
    const { container } = render(() => <FilePreview store={store} />);
    expect(container.textContent).toContain("print('hello')");
  });

  it("binary: a preview-unavailable note", async () => {
    const store = await loaded(async () => ({ kind: "binary", size: 4096 }), "/a/blob.bin");
    const { getByText } = render(() => <FilePreview store={store} />);
    expect(getByText(/preview unavailable/i)).toBeInTheDocument();
  });

  it("error: a 404 message is surfaced", async () => {
    const store = await loaded(async () => {
      throw new FileApiError(404, "File not found.");
    }, "/a/missing.ts");
    const { getByText } = render(() => <FilePreview store={store} />);
    expect(getByText("File not found.")).toBeInTheDocument();
  });
});

describe("<FilePreview> — the size chip", () => {
  it("shows the byte size of a loaded file", async () => {
    const store = await loaded(
      async () => ({ kind: "code", text: "abc", size: 59 }),
      "/a/utf8.md",
    );
    const { container } = render(() => <FilePreview store={store} />);
    expect(container.querySelector(".tl-preview-size")?.textContent).toBe("59 B");
  });

  // fmtBytes returned "" for 0, so an empty file rendered the chip element with
  // nothing in it — a stray gap in the header rather than an honest "0 B".
  it("renders '0 B' for an empty file, not an empty chip", async () => {
    const store = await loaded(
      async () => ({ kind: "code", text: "", size: 0 }),
      "/a/empty.txt",
    );
    const { container } = render(() => <FilePreview store={store} />);
    expect(container.querySelector(".tl-preview-size")?.textContent).toBe("0 B");
  });

  it("updates after a save that changes the byte count", async () => {
    const store = makeStore({
      loadFile: async () => ({ kind: "code", text: "abc", size: 3 }),
      writeFile: async () => {},
      notify: () => {},
    });
    await store.open("/a/x.ts");
    const { container } = render(() => <FilePreview store={store} />);
    expect(container.querySelector(".tl-preview-size")?.textContent).toBe("3 B");

    store.beginEdit();
    store.setDraft("abcdefghij"); // 10 bytes
    await store.save();
    expect(container.querySelector(".tl-preview-size")?.textContent).toBe("10 B");
  });
});

describe("<FilePreview> — recent files + explicit path entry", () => {
  it("shows transcript-derived recent files and opens one on click", async () => {
    const loadFile = vi.fn(async () => ({ kind: "code", text: "x" }) as LoadedFile);
    const events: Event[] = [
      ev({ id: 1, kind: "tool_use", tool: "Read", body: '{"file_path":"/a/one.ts"}' }),
      ev({ id: 2, kind: "tool_use", tool: "Edit", body: '{"file_path":"/a/two.md"}' }),
    ];
    const store = makeStore({ loadFile, events: () => events });
    store.show();
    const { getByRole } = render(() => <FilePreview store={store} />);

    // newest-first chips.
    const chip = getByRole("button", { name: "two.md" });
    expect(chip).toBeInTheDocument();
    fireEvent.click(chip);
    expect(loadFile).toHaveBeenCalledWith("/a/two.md", "two.md");
  });

  // A plain shell session has no transcript and no loaded path, and Browse was
  // gated behind `s.path()` — so the directory picker could only be reached by
  // first typing a full absolute file path, which is what the picker is for.
  it("offers Browse with no file loaded, and it opens the picker", async () => {
    const listDir = vi.fn(async () => []);
    const store = makeStore({ listDir, homeDir: async () => "/home/wizard" });
    store.show();
    const { getByRole } = render(() => <FilePreview store={store} />);

    const browse = getByRole("button", { name: "Browse" });
    expect(browse).toBeInTheDocument();
    fireEvent.click(browse);
    await Promise.resolve();
    await Promise.resolve();
    expect(listDir).toHaveBeenCalledWith("/home/wizard");
  });

  it("opens the path typed into the path box", async () => {
    const loadFile = vi.fn(async () => ({ kind: "code", text: "x" }) as LoadedFile);
    const store = makeStore({ loadFile });
    store.show();
    const { getByLabelText } = render(() => <FilePreview store={store} />);

    const input = getByLabelText("File path") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "/typed/path.go" } });
    // Submit the form directly (jsdom's implicit submit-on-click is unreliable).
    fireEvent.submit(input.closest("form")!);
    expect(loadFile).toHaveBeenCalledWith("/typed/path.go", "path.go");
  });
});
