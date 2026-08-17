import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { Show, createRoot } from "solid-js";
import { FilePreview, fmtBytes } from "../src/components/FilePreview";
import { createPreviewStore, type PreviewStore } from "../src/store/preview";
import type { FileEntry, LoadedFile } from "../src/lib/file-api";
import { FileApiError } from "../src/lib/file-api";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length) roots.pop()!();
  vi.unstubAllGlobals();
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

// An <img> that fails says nothing about WHY on its own, and readFile never
// fetched a name-classified image, so all three server refusals — missing, too
// large, out of the home root — landed on one sentence about a broken image.
describe("<FilePreview> — a failed image says what the server said", () => {
  /** Stub the onerror probe's GET with a fixed non-OK status. */
  function stubProbe(status: number, body = ""): ReturnType<typeof vi.fn> {
    const spy = vi.fn(
      async () =>
        ({
          ok: false,
          status,
          headers: { get: () => null },
          text: async () => body,
          body: { cancel: async () => {} },
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", spy as unknown as typeof fetch);
    return spy;
  }

  it("a 413 image reads as too large, not as a broken image", async () => {
    stubProbe(413);
    const store = await loaded(async () => ({ kind: "image" }), "/a/huge.png");
    const { container, findByText } = render(() => <FilePreview store={store} />);
    fireEvent.error(container.querySelector("img")!);
    expect(await findByText(/too large to preview/i)).toBeInTheDocument();
  });

  it("a 404 image reads as not found", async () => {
    stubProbe(404);
    const store = await loaded(async () => ({ kind: "image" }), "/a/nope.png");
    const { container, findByText } = render(() => <FilePreview store={store} />);
    fireEvent.error(container.querySelector("img")!);
    expect(await findByText("File not found.")).toBeInTheDocument();
  });

  it("an out-of-home image reads as out of reach", async () => {
    stubProbe(400, "invalid path\n");
    const store = await loaded(async () => ({ kind: "image" }), "/etc/logo.png");
    const { container, findByText } = render(() => <FilePreview store={store} />);
    fireEvent.error(container.querySelector("img")!);
    expect(await findByText(/outside your home folder/i)).toBeInTheDocument();
  });

  it("a healthy image costs no probe request", async () => {
    const spy = stubProbe(404);
    const store = await loaded(async () => ({ kind: "image" }), "/a/ok.png");
    const { container } = render(() => <FilePreview store={store} />);
    expect(container.querySelector("img")).toBeTruthy();
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
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
    expect(listDir).toHaveBeenCalledWith("/home/wizard", false);
  });

  // The box is the app's own record of "which file is this". It was written
  // only by typing, so opening a file any other way (a Browse entry, a recent
  // chip, a transcript click) left the PREVIOUS path sitting in it: two
  // filenames on screen at once, and Enter re-opened the older one.
  it("follows the file on screen when one is opened from Browse", async () => {
    const bodies: Record<string, string> = {
      "/vfp/notes.txt": "baseline\n",
      "/vfp/hello.md": "hello\n\nsecond file",
    };
    const loadFile = vi.fn(
      async (p: string) => ({ kind: "code", text: bodies[p] ?? "" }) as LoadedFile,
    );
    const listDir = vi.fn(async () => [
      { name: "hello.md", path: "/vfp/hello.md", size: 3, mtime: 0, isDir: false },
    ]);
    const store = makeStore({ loadFile, listDir });
    const { getByLabelText, getByRole, findByRole } = render(() => (
      <FilePreview store={store} />
    ));
    const input = getByLabelText("File path") as HTMLInputElement;

    // Typed the first path, as a user does.
    fireEvent.input(input, { target: { value: "/vfp/notes.txt" } });
    fireEvent.submit(input.closest("form")!);
    await Promise.resolve();
    expect(input.value).toBe("/vfp/notes.txt");

    // Browse → click the other file.
    fireEvent.click(getByRole("button", { name: "Browse" }));
    fireEvent.click(await findByRole("button", { name: /hello\.md/ }));
    await Promise.resolve();

    // The box names the file that is actually on screen …
    expect(store.path()).toBe("/vfp/hello.md");
    expect(input.value).toBe("/vfp/hello.md");

    // … so Enter re-opens THAT file, not the one before it.
    loadFile.mockClear();
    fireEvent.submit(input.closest("form")!);
    expect(loadFile).toHaveBeenCalledWith("/vfp/hello.md", "hello.md");
  });

  it("still lets you type a different path over it", async () => {
    const loadFile = vi.fn(async () => ({ kind: "code", text: "x" }) as LoadedFile);
    const store = makeStore({ loadFile });
    await store.open("/vfp/notes.txt");
    const { getByLabelText } = render(() => <FilePreview store={store} />);
    const input = getByLabelText("File path") as HTMLInputElement;
    expect(input.value).toBe("/vfp/notes.txt");

    fireEvent.input(input, { target: { value: "/vfp/other.go" } });
    expect(input.value).toBe("/vfp/other.go"); // typing is not overwritten
    fireEvent.submit(input.closest("form")!);
    expect(loadFile).toHaveBeenLastCalledWith("/vfp/other.go", "other.go");
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

// The browse pane's only control was the path box, so the dotfiles file-api
// deliberately allows you to edit (.gitignore, .env, .bashrc) could never be
// listed — listDir's `all` parameter existed and was never passed.
/**
 * The panel is a modal over an opaque backdrop and its own empty state says
 * "Type an absolute file path above" — but nothing focused the box, and Tab
 * walked straight out into the session composer and the sidebar behind the
 * backdrop (measured: 26 of 30 Tab presses landed outside the panel; reaching
 * the path box took 7). Mirrors SettingsPanel.focus.test.tsx, whose panel makes
 * — and keeps — the same three promises.
 */
describe("<FilePreview> — focus management", () => {
  /** Mount an opener button + the <Show>-gated overlay, as SessionView wires it. */
  function openPreview(store: PreviewStore) {
    const utils = render(() => (
      <>
        <button type="button" class="tl-icon-btn tl-preview-btn" aria-label="File preview">
          📄
        </button>
        <Show when={store.isOpen()}>
          <FilePreview store={store} />
        </Show>
      </>
    ));
    const opener = utils.getByLabelText("File preview") as HTMLButtonElement;
    opener.focus(); // a real click focuses the button; jsdom does not
    store.show();
    return { ...utils, opener };
  }

  async function ready(container: HTMLElement): Promise<HTMLElement> {
    await waitFor(() => expect(container.querySelector(".tl-preview-panel")).not.toBeNull());
    const panel = container.querySelector(".tl-preview-panel") as HTMLElement;
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    return panel;
  }

  it("puts the caret in the path box on open, so blind typing lands there", async () => {
    const store = makeStore({});
    const { container, getByLabelText } = openPreview(store);
    await ready(container);
    const input = getByLabelText("File path") as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    // What a user typing straight after opening actually produces.
    fireEvent.input(input, { target: { value: "/tmp/x" } });
    expect(input.value).toBe("/tmp/x");
  });

  it("declares itself modal, which is what makes the Tab trap a promise", async () => {
    const store = makeStore({});
    const { container } = openPreview(store);
    const panel = await ready(container);
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
  });

  it("keeps Tab inside the panel instead of walking into the app behind", async () => {
    const store = makeStore({});
    const { container } = openPreview(store);
    const panel = await ready(container);

    const tabbable = [
      ...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = tabbable[0]!;
    const last = tabbable[tabbable.length - 1]!;
    expect(tabbable.length).toBeGreaterThan(1);

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("gives focus back to the button that opened it", async () => {
    const store = makeStore({});
    const { container, opener, getByLabelText } = openPreview(store);
    await ready(container);

    const close = getByLabelText("Close preview") as HTMLButtonElement;
    close.focus(); // what a real click does before the handler runs
    fireEvent.click(close);

    await waitFor(() => expect(container.querySelector(".tl-preview-panel")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

describe("<FilePreview> — the browse bar's hidden-files toggle", () => {
  const entry = (name: string): FileEntry => ({
    name,
    path: `/d/${name}`,
    size: 0,
    mtime: 0,
    isDir: false,
  });

  it("is off by default, and switching it on lists the dotfiles", async () => {
    // Mirrors file-api: dotfiles come back only when &all=1 is asked for.
    const listDir = vi.fn(async (_dir: string, all = false) =>
      all ? [entry(".hidden.txt"), entry("sample.md")] : [entry("sample.md")],
    );
    const store = makeStore({ listDir });
    await store.browse("/d");
    const { getByRole, queryByText, findByText } = render(() => (
      <FilePreview store={store} />
    ));

    expect(queryByText(".hidden.txt")).toBeNull();
    const toggle = getByRole("checkbox", { name: /hidden/i }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    expect(await findByText(".hidden.txt")).toBeInTheDocument();
    expect(listDir).toHaveBeenLastCalledWith("/d", true);
    expect(toggle.checked).toBe(true);
  });

  it("only exists inside the browse pane", async () => {
    const store = await loaded(async () => ({ kind: "code", text: "x" }), "/a/x.ts");
    const { queryByRole } = render(() => <FilePreview store={store} />);
    expect(queryByRole("checkbox", { name: /hidden/i })).toBeNull();
  });
});

describe("<FilePreview> — relative images in a previewed markdown file", () => {
  const md = [
    "![rel](pic.png)",
    "",
    "![nested](sub/pic.png)",
    "",
    "![absolute](/files/read?path=%2Fa%2Fb%2Fpic.png)",
    "",
    "![remote](https://example.com/pic.png)",
  ].join("\n");

  const srcs = (container: HTMLElement): string[] =>
    [...container.querySelectorAll(".tl-preview-md img")].map(
      (n) => n.getAttribute("src") ?? "",
    );

  it("resolves a relative src against the file's own directory, via the file-api", async () => {
    // A markdown file is previewed by PATH, but its <img> resolves against the
    // lobby ORIGIN — so `![x](pic.png)` beside the document asked the lobby for
    // /pic.png and 404'd, while the same picture referenced absolutely loaded.
    const store = await loaded(
      async () => ({ kind: "markdown", text: md }),
      "/a/b/doc.md",
    );
    const { container } = render(() => <FilePreview store={store} />);

    expect(srcs(container)).toEqual([
      "/files/read?path=%2Fa%2Fb%2Fpic.png",
      "/files/read?path=%2Fa%2Fb%2Fsub%2Fpic.png",
      // already a URL — left exactly as written
      "/files/read?path=%2Fa%2Fb%2Fpic.png",
      "https://example.com/pic.png",
    ]);
  });

  it("leaves every src alone when the markdown has no base (the transcript case)", async () => {
    // Markdown is shared with the assistant transcript renderer, which passes
    // no base and whose srcs are already absolute. Rewriting there would be a
    // regression, so the base must be opt-in.
    const { Markdown } = await import("../src/components/Markdown");
    const { container } = render(() => <Markdown text={md} />);
    expect(
      [...container.querySelectorAll("img")].map((n) => n.getAttribute("src")),
    ).toEqual([
      "pic.png",
      "sub/pic.png",
      "/files/read?path=%2Fa%2Fb%2Fpic.png",
      "https://example.com/pic.png",
    ]);
  });
});

describe("<FilePreview> — the Browse button reads the path box", () => {
  it("lists the directory typed beside it, not the loaded file's", async () => {
    // The button sits next to the path box and ignored it: with code.ts open,
    // typing a sibling folder and pressing Browse listed code.ts's own folder.
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const store = makeStore({
      listDir,
      loadFile: async () => ({ kind: "code", text: "x" }),
    });
    await store.open("/home/u/vfpx/code.ts");
    const { getByRole, getByLabelText } = render(() => <FilePreview store={store} />);

    const box = getByLabelText("File path") as HTMLInputElement;
    expect(box.value).toBe("/home/u/vfpx/code.ts"); // the box mirrors the file
    fireEvent.input(box, { target: { value: "/home/u/vfpx/sub" } });
    fireEvent.click(getByRole("button", { name: "Browse" }));

    await waitFor(() => expect(listDir).toHaveBeenCalledWith("/home/u/vfpx/sub", false));
  });

  it("still lists the loaded file's folder when the box was left alone", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const store = makeStore({
      listDir,
      loadFile: async () => ({ kind: "code", text: "x" }),
    });
    await store.open("/home/u/vfpx/code.ts");
    const { getByRole } = render(() => <FilePreview store={store} />);

    fireEvent.click(getByRole("button", { name: "Browse" }));
    await waitFor(() => expect(listDir).toHaveBeenCalledWith("/home/u/vfpx", false));
  });
});

describe("fmtBytes — the header's size chip", () => {
  it("names the sizes it is given", () => {
    expect(fmtBytes(null)).toBe("");
    expect(fmtBytes(-1)).toBe("");
    expect(fmtBytes(0)).toBe("0 B"); // an empty file has a real size
    expect(fmtBytes(1023)).toBe("1023 B");
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1048576)).toBe("1.0 MB");
  });

  // The KB branch tested the RAW byte count while the label printed the ROUNDED
  // one, so every size that rounds up to 1024.0 KB was shown in a unit nobody
  // uses. Exactly 51 sizes fall in that window, 1 MiB-1 among them.
  it("rolls over to MB as soon as the rounded label would read 1024 KB", () => {
    expect(fmtBytes(1048524)).toBe("1023.9 KB"); // the last honest KB size
    expect(fmtBytes(1048525)).toBe("1.0 MB"); // first of the 51
    expect(fmtBytes(1048575)).toBe("1.0 MB"); // 1 MiB - 1, the reported case
  });

  it("never prints a number the next unit up should have absorbed", () => {
    // Swept rather than spot-checked: the defect is a boundary, and a boundary
    // is what point samples miss. Collected into ONE assertion so the sweep
    // costs a few ms instead of 300k expect() calls.
    const chip = /^(\d+(?:\.\d)?) (B|KB|MB)$/;
    const bad: string[] = [];
    for (let n = 0; n <= 2 * 1024 * 1024; n += 7) {
      const out = fmtBytes(n);
      const m = out.match(chip);
      if (!m || (m[2] !== "MB" && Number(m[1]) >= 1024)) bad.push(`${n} -> ${out}`);
    }
    expect(bad).toEqual([]);
  });
});

// --- panel chrome around a previewed file (Viktor's screenshot, 2026-08-17) --
// Opening an attachment showed the picture floating between two large voids: a
// Recent strip that belongs to FINDING a file, and the fixed-height panel
// centring a picture that has a natural size of its own.
describe("<FilePreview> — chrome around a loaded file", () => {
  const recentEvents: Event[] = [
    ev({ id: 1, kind: "tool_use", tool: "Read", toolId: "t1", body: '{"file_path":"/a/one.ts"}' }),
    ev({ id: 2, kind: "tool_use", tool: "Read", toolId: "t2", body: '{"file_path":"/a/two.ts"}' }),
  ];

  const withRecents = (): PreviewStore =>
    makeStore({
      loadFile: async () => ({ kind: "image" }),
      events: () => recentEvents,
    });

  it("offers Recent while no file is loaded — that is when it helps you find one", async () => {
    const store = withRecents();
    store.show();
    const { container } = render(() => <FilePreview store={store} />);
    await waitFor(() => expect(container.querySelector(".tl-preview-pathbar")).not.toBeNull());
    expect(store.recentFiles().length).toBeGreaterThan(0);
    expect(container.querySelector(".tl-preview-recents")).not.toBeNull();
  });

  it("drops Recent once a file is on screen", async () => {
    const store = withRecents();
    await store.open("/a/shot.png");
    const { container } = render(() => <FilePreview store={store} />);
    await waitFor(() => expect(container.querySelector(".tl-preview-image")).not.toBeNull());
    // The recents are still THERE — they are just not taking a band of the
    // panel while you are looking at something.
    expect(store.recentFiles().length).toBeGreaterThan(0);
    expect(container.querySelector(".tl-preview-recents")).toBeNull();
  });

  // The panel is a fixed 85vh whatever it holds. A picture has its own size, so
  // it is the one kind that should make the panel hug its content instead of
  // centring it between two empty bands. The CSS keys off this attribute.
  it("labels the panel with the loaded kind so an image can hug its content", async () => {
    const store = await loaded(async () => ({ kind: "image" }), "/a/shot.png");
    const { container } = render(() => <FilePreview store={store} />);
    await waitFor(() => expect(container.querySelector(".tl-preview-image")).not.toBeNull());
    expect(container.querySelector(".tl-preview-panel")?.getAttribute("data-kind")).toBe("image");
  });

  it("labels a non-image kind too, so only the image rule can match", async () => {
    const store = await loaded(async () => ({ kind: "code", text: "x" }), "/a/m.ts");
    const { container } = render(() => <FilePreview store={store} />);
    await waitFor(() => expect(container.querySelector(".tl-codeview")).not.toBeNull());
    expect(container.querySelector(".tl-preview-panel")?.getAttribute("data-kind")).toBe("code");
  });
});
