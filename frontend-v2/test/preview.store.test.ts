import { describe, it, expect, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createPreviewStore, type PreviewStore } from "../src/store/preview";
import { FileApiError, type FileEntry, type LoadedFile } from "../src/lib/file-api";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

function withStore(
  deps: Parameters<typeof createPreviewStore>[0],
): [PreviewStore, () => void] {
  let store!: PreviewStore;
  const dispose = createRoot((d) => {
    store = createPreviewStore(deps);
    return d;
  });
  return [store, dispose];
}

describe("preview store — open + load a file", () => {
  it("open() shows the overlay, goes loading, then loaded with kind + text", async () => {
    const loaded: LoadedFile = {
      kind: "code",
      language: "typescript",
      text: "const a = 1;",
      size: 12,
    };
    const [s, dispose] = withStore({ loadFile: async () => loaded });
    expect(s.isOpen()).toBe(false);

    const p = s.open("/a/b.ts");
    expect(s.isOpen()).toBe(true);
    expect(s.status()).toBe("loading");
    expect(s.path()).toBe("/a/b.ts");
    expect(s.name()).toBe("b.ts");

    await p;
    expect(s.status()).toBe("loaded");
    expect(s.kind()).toBe("code");
    expect(s.language()).toBe("typescript");
    expect(s.text()).toBe("const a = 1;");
    expect(s.size()).toBe(12);
    dispose();
  });

  it("resets mode to rendered on every open", async () => {
    const [s, dispose] = withStore({
      loadFile: async () => ({ kind: "markdown", text: "# hi" }),
    });
    await s.open("/a/x.md");
    s.setMode("raw");
    expect(s.mode()).toBe("raw");
    await s.open("/a/y.md");
    expect(s.mode()).toBe("rendered");
    dispose();
  });

  it("passes the basename to the loader (not the full path)", async () => {
    const loadFile = vi.fn(async () => ({ kind: "code" }) as LoadedFile);
    const [s, dispose] = withStore({ loadFile });
    await s.open("/deep/dir/thing.py");
    expect(loadFile).toHaveBeenCalledWith("/deep/dir/thing.py", "thing.py");
    dispose();
  });

  it("an image loads without text (component renders it by URL)", async () => {
    const [s, dispose] = withStore({
      loadFile: async () => ({ kind: "image" }),
    });
    await s.open("/a/pic.png");
    expect(s.kind()).toBe("image");
    expect(s.text()).toBe("");
    expect(s.status()).toBe("loaded");
    dispose();
  });
});

describe("preview store — errors + validation", () => {
  it("rejects a relative path without hitting the loader", async () => {
    const loadFile = vi.fn(async () => ({ kind: "code" }) as LoadedFile);
    const [s, dispose] = withStore({ loadFile });
    await s.open("relative/path.ts");
    expect(loadFile).not.toHaveBeenCalled();
    expect(s.status()).toBe("error");
    expect(s.error()).toMatch(/absolute path/i);
    dispose();
  });

  it("maps a 404 FileApiError to an error state + message", async () => {
    const [s, dispose] = withStore({
      loadFile: async () => {
        throw new FileApiError(404, "File not found.");
      },
    });
    await s.open("/a/missing.ts");
    expect(s.status()).toBe("error");
    expect(s.error()).toBe("File not found.");
    dispose();
  });

  it("maps a 413 (too large) to an error state", async () => {
    const [s, dispose] = withStore({
      loadFile: async () => {
        throw new FileApiError(413, "File is too large to preview (max 10MB).");
      },
    });
    await s.open("/a/huge.log");
    expect(s.status()).toBe("error");
    expect(s.error()).toMatch(/too large/i);
    dispose();
  });
});

describe("preview store — stale-load guard", () => {
  it("a superseded load never overwrites the newer one", async () => {
    let resolveFirst!: (v: LoadedFile) => void;
    const first = new Promise<LoadedFile>((r) => (resolveFirst = r));
    let call = 0;
    const [s, dispose] = withStore({
      loadFile: async (path) => {
        call++;
        if (call === 1) return first; // hangs until we resolve it
        return { kind: "code", text: `SECOND ${path}` };
      },
    });
    const p1 = s.open("/a/first.ts");
    const p2 = s.open("/a/second.ts");
    await p2;
    expect(s.text()).toBe("SECOND /a/second.ts");
    // Now let the first (stale) load finish — it must NOT clobber the state.
    resolveFirst({ kind: "code", text: "FIRST" });
    await p1;
    expect(s.text()).toBe("SECOND /a/second.ts");
    dispose();
  });

  it("close() abandons an in-flight load", async () => {
    let resolve!: (v: LoadedFile) => void;
    const hang = new Promise<LoadedFile>((r) => (resolve = r));
    const [s, dispose] = withStore({ loadFile: async () => hang });
    const p = s.open("/a/slow.ts");
    s.close();
    expect(s.isOpen()).toBe(false);
    resolve({ kind: "code", text: "late" });
    await p;
    expect(s.status()).toBe("loading"); // never advanced to loaded
    expect(s.isOpen()).toBe(false);
    dispose();
  });
});

describe("preview store — raw/rendered toggle", () => {
  it("toggleMode flips and setMode sets", async () => {
    const [s, dispose] = withStore({
      loadFile: async () => ({ kind: "markdown", text: "# hi" }),
    });
    await s.open("/a/x.md");
    expect(s.mode()).toBe("rendered");
    expect(s.modeApplies()).toBe(true);
    s.toggleMode();
    expect(s.mode()).toBe("raw");
    s.toggleMode();
    expect(s.mode()).toBe("rendered");
    s.setMode("raw");
    expect(s.mode()).toBe("raw");
    dispose();
  });

  it("modeApplies is false for code/image/binary kinds", async () => {
    const [s, dispose] = withStore({
      loadFile: async () => ({ kind: "code", text: "x" }),
    });
    await s.open("/a/x.ts");
    expect(s.modeApplies()).toBe(false);
    dispose();
  });
});

describe("preview store — recent files from the transcript", () => {
  it("derives a newest-first, de-duplicated list from the events accessor", () => {
    const [events, setEvents] = createSignal<Event[]>([]);
    let s!: PreviewStore;
    const dispose = createRoot((d) => {
      s = createPreviewStore({ events });
      return d;
    });
    expect(s.recentFiles()).toEqual([]);
    setEvents([
      ev({ id: 1, kind: "tool_use", tool: "Read", body: '{"file_path":"/a/one.ts"}' }),
      ev({ id: 2, kind: "tool_use", tool: "Write", body: '{"file_path":"/a/two.md"}' }),
    ]);
    expect(s.recentFiles().map((r) => r.path)).toEqual(["/a/two.md", "/a/one.ts"]);
    dispose();
  });
});

describe("preview store — show + directory browse", () => {
  it("show() opens the overlay idle (no file)", () => {
    const [s, dispose] = withStore({});
    s.show();
    expect(s.isOpen()).toBe(true);
    expect(s.status()).toBe("idle");
    dispose();
  });

  it("browse() lists a directory; browseUp goes to the parent", async () => {
    const entries: FileEntry[] = [
      { name: "sub", path: "/a/sub", size: 0, mtime: 0, isDir: true },
      { name: "f.ts", path: "/a/f.ts", size: 10, mtime: 0, isDir: false },
    ];
    const listDir = vi.fn(async () => entries);
    const [s, dispose] = withStore({ listDir });
    const p = s.browse("/a/b");
    expect(s.browsing()).toBe(true);
    expect(s.browseStatus()).toBe("loading");
    await p;
    expect(s.browseStatus()).toBe("loaded");
    expect(s.browseEntries()).toHaveLength(2);

    await s.browseUp();
    expect(listDir).toHaveBeenLastCalledWith("/a");
    expect(s.browseDir()).toBe("/a");
    dispose();
  });

  it("surfaces a browse failure as browseStatus=error", async () => {
    const [s, dispose] = withStore({
      listDir: async () => {
        throw new FileApiError(404, "not found");
      },
    });
    await s.browse("/nope");
    expect(s.browseStatus()).toBe("error");
    expect(s.browseError()).toBe("not found");
    dispose();
  });
});
