import { describe, it, expect, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createPreviewStore, type PreviewStore } from "../src/store/preview";
import {
  FileApiError,
  readErrorMessage,
  type FileEntry,
  type LoadedFile,
} from "../src/lib/file-api";
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

// Typing an in-home DIRECTORY into the path box used to answer "it's outside
// your home folder, or not a readable file" — while the Browse button one click
// away listed that same directory happily. Two opposite answers for one path.
describe("preview store — a directory typed into the path box", () => {
  it("reports a FOLDER instead of the containment error", async () => {
    const [s, dispose] = withStore({
      loadFile: async () => {
        throw new FileApiError(400, readErrorMessage(400, "path is a directory\n"));
      },
    });
    await s.open("/home/wizard/proj/sub");
    expect(s.status()).toBe("error");
    expect(s.error()).toMatch(/is a folder/i);
    expect(s.error()).not.toMatch(/outside your home/i);
    dispose();
  });

  it("leaves an out-of-home path on the deliberately vague message", async () => {
    const [s, dispose] = withStore({
      loadFile: async () => {
        throw new FileApiError(400, readErrorMessage(400, "invalid path\n"));
      },
    });
    await s.open("/etc/passwd");
    expect(s.status()).toBe("error");
    expect(s.error()).toBe(readErrorMessage(400));
    expect(s.error()).not.toMatch(/is a folder/i);
    dispose();
  });
});

// listDir has carried an `all` parameter (→ &all=1) since it was written, and
// the shipped app never passed it — so the Browse pane could not ask for the
// dotfiles file-api's own comment names as editable (.gitignore, .env, .bashrc).
describe("preview store — the show-hidden toggle", () => {
  const entries = (...names: string[]): FileEntry[] =>
    names.map((name) => ({ name, path: `/d/${name}`, size: 0, mtime: 0, isDir: false }));

  /** Mirrors file-api: dotfiles only when the caller asks for them. */
  const lister = () =>
    vi.fn(async (_dir: string, all = false) =>
      all ? entries(".hidden.txt", "sample.md") : entries("sample.md"),
    );

  it("defaults to off and asks for a plain listing", async () => {
    const listDir = lister();
    const [s, dispose] = withStore({ listDir });
    expect(s.showHidden()).toBe(false);
    await s.browse("/d");
    expect(listDir).toHaveBeenCalledWith("/d", false);
    expect(s.browseEntries().map((e) => e.name)).toEqual(["sample.md"]);
    dispose();
  });

  it("turning it on re-lists the current directory with dotfiles", async () => {
    const listDir = lister();
    const [s, dispose] = withStore({ listDir });
    await s.browse("/d");
    await s.toggleHidden();
    expect(s.showHidden()).toBe(true);
    expect(listDir).toHaveBeenLastCalledWith("/d", true);
    expect(s.browseEntries().map((e) => e.name)).toContain(".hidden.txt");
    dispose();
  });

  it("turning it back off restores exactly today's listing", async () => {
    const listDir = lister();
    const [s, dispose] = withStore({ listDir });
    await s.browse("/d");
    await s.toggleHidden();
    await s.toggleHidden();
    expect(s.showHidden()).toBe(false);
    expect(listDir).toHaveBeenLastCalledWith("/d", false);
    expect(s.browseEntries().map((e) => e.name)).toEqual(["sample.md"]);
    dispose();
  });

  it("browseUp carries the flag to the parent listing", async () => {
    const listDir = lister();
    const [s, dispose] = withStore({ listDir });
    await s.browse("/d/deep");
    await s.toggleHidden();
    await s.browseUp();
    expect(listDir).toHaveBeenLastCalledWith("/d", true);
    dispose();
  });

  it("toggling with the pane closed changes the flag without a request", async () => {
    const listDir = lister();
    const [s, dispose] = withStore({ listDir });
    await s.toggleHidden();
    expect(s.showHidden()).toBe(true);
    expect(listDir).not.toHaveBeenCalled();
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
    expect(listDir).toHaveBeenLastCalledWith("/a", false);
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

// file-api contains every path to the user's home; anything above it is a 400.
// The Up button used to climb past that root, stranding the pane on /home, then
// /, then the relative "." — each an empty list plus an error, with no entry to
// click back into. The floor is learned from the server's own refusal.
describe("preview store — browseUp stops at the containment root", () => {
  /** A lister that mimics file-api: everything under `home` lists, the rest 400s. */
  function containedLister(home: string, calls: string[] = []) {
    return async (dir: string): Promise<FileEntry[]> => {
      calls.push(dir);
      if (dir === home || dir.startsWith(`${home}/`)) {
        return [{ name: "f.ts", path: `${dir}/f.ts`, size: 1, mtime: 0, isDir: false }];
      }
      throw new FileApiError(400, "Can't list this folder.");
    };
  }

  it("an Up walk stops at the root instead of stranding on /home, / and '.'", async () => {
    const calls: string[] = [];
    const [s, dispose] = withStore({
      listDir: containedLister("/home/wizard", calls),
    });
    await s.browse("/home/wizard/.qa-verify-scratch");
    expect(s.browseDir()).toBe("/home/wizard/.qa-verify-scratch");

    await s.browseUp(); // -> /home/wizard, the containment root
    expect(s.browseDir()).toBe("/home/wizard");
    expect(s.browseStatus()).toBe("loaded");

    // Every further click must leave the pane exactly where it is.
    for (let i = 0; i < 3; i++) {
      await s.browseUp();
      expect(s.browseDir()).toBe("/home/wizard");
      expect(s.browseStatus()).toBe("loaded"); // never an error pane
      expect(s.browseEntries().length).toBeGreaterThan(0); // never an empty list
    }
    // Nothing reports the containment root to the client, so it is learned:
    // the parent above the root is probed ONCE and never again, and the walk
    // never reaches / or the relative "." beyond it.
    expect(calls.filter((c) => c === "/home")).toHaveLength(1);
    expect(calls).not.toContain("/");
    expect(calls).not.toContain(".");
    dispose();
  });

  it("canBrowseUp goes false once the root is known, and the button stays live below it", async () => {
    const [s, dispose] = withStore({ listDir: containedLister("/home/wizard") });
    await s.browse("/home/wizard/deep/dir");
    expect(s.canBrowseUp()).toBe(true);
    await s.browseUp();
    expect(s.canBrowseUp()).toBe(true); // /home/wizard/deep
    await s.browseUp();
    expect(s.browseDir()).toBe("/home/wizard");
    await s.browseUp(); // probes /home once, learns the floor
    expect(s.canBrowseUp()).toBe(false);
    dispose();
  });

  it("a refused climb restores the pane it interrupted, error and all", async () => {
    const [s, dispose] = withStore({
      listDir: async (dir: string) => {
        if (dir === "/home/wizard/gone") throw new FileApiError(404, "Folder not found.");
        throw new FileApiError(400, "Can't list this folder.");
      },
    });
    await s.browse("/home/wizard/gone");
    expect(s.browseStatus()).toBe("error");
    await s.browseUp(); // parent refused — must not flip the pane to "Empty directory"
    expect(s.browseStatus()).toBe("error");
    expect(s.browseError()).toBe("Folder not found.");
    dispose();
  });

  it("a transient (non-400) failure is surfaced, not mistaken for the root", async () => {
    let first = true;
    const [s, dispose] = withStore({
      listDir: async (dir: string) => {
        if (first && dir === "/home/wizard/x") {
          first = false;
          return [{ name: "f", path: "/home/wizard/x/f", size: 0, mtime: 0, isDir: false }];
        }
        throw new FileApiError(500, "Couldn't load folder (HTTP 500).");
      },
    });
    await s.browse("/home/wizard/x");
    await s.browseUp();
    expect(s.browseStatus()).toBe("error");
    expect(s.browseError()).toMatch(/HTTP 500/);
    expect(s.canBrowseUp()).toBe(true); // a blip must not disable Up forever
    dispose();
  });
});

// Browse used to be reachable only after a file was already loaded, so a plain
// shell session (no transcript, no path) had no way into the picker at all.
describe("preview store — browseStart, the cold-open entry", () => {
  it("starts at the loaded file's directory when there is one", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const [s, dispose] = withStore({
      listDir,
      loadFile: async () => ({ kind: "code", text: "x" }),
    });
    await s.open("/home/u/proj/main.ts");
    await s.browseStart();
    expect(listDir).toHaveBeenCalledWith("/home/u/proj", false);
    dispose();
  });

  // The folder message tells the user to "press Browse to list what's inside
  // it". browseStart() assumes path() is a FILE and lists dirname(path) — so
  // the button listed the folder's PARENT and the sentence was a lie by one
  // click. The failed read already told us it is a directory; use that.
  it("lists the typed folder ITSELF when the read failed because it is one", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const [s, dispose] = withStore({
      listDir,
      loadFile: async () => {
        throw new FileApiError(400, readErrorMessage(400, "path is a directory\n"), true);
      },
    });
    await s.open("/home/u/proj/sub");
    expect(s.error()).toMatch(/is a folder/i);
    await s.browseStart();
    expect(listDir).toHaveBeenCalledWith("/home/u/proj/sub", false);
    expect(s.browseDir()).toBe("/home/u/proj/sub");
    dispose();
  });

  it("goes back to dirname once a real file loads over the folder error", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    let dir = true;
    const [s, dispose] = withStore({
      listDir,
      loadFile: async () => {
        if (dir) throw new FileApiError(400, "folder", true);
        return { kind: "code", text: "x" } as LoadedFile;
      },
    });
    await s.open("/home/u/proj/sub");
    dir = false;
    await s.open("/home/u/proj/main.ts");
    await s.browseStart();
    expect(listDir).toHaveBeenCalledWith("/home/u/proj", false);
    dispose();
  });

  it("a non-directory 400 does not turn the path into a browse target", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const [s, dispose] = withStore({
      listDir,
      loadFile: async () => {
        throw new FileApiError(400, readErrorMessage(400, "invalid path\n"));
      },
    });
    await s.open("/etc/passwd");
    await s.browseStart();
    expect(listDir).toHaveBeenCalledWith("/etc", false);
    dispose();
  });

  it("falls back to the most recent transcript file's directory", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const events = (): Event[] => [
      ev({ id: 1, kind: "tool_use", tool: "Read", body: '{"file_path":"/home/u/a/one.ts"}' }),
    ];
    const [s, dispose] = withStore({ listDir, events });
    s.show();
    await s.browseStart();
    expect(listDir).toHaveBeenCalledWith("/home/u/a", false);
    dispose();
  });

  it("with no path and no transcript, falls back to the user's home", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const [s, dispose] = withStore({
      listDir,
      homeDir: async () => "/home/wizard",
    });
    s.show();
    await s.browseStart();
    expect(s.browsing()).toBe(true);
    expect(listDir).toHaveBeenCalledWith("/home/wizard", false);
    expect(s.browseDir()).toBe("/home/wizard");
    // Home IS the containment root, so Up is inert straight away.
    expect(s.canBrowseUp()).toBe(false);
    dispose();
  });

  // The path box sits directly beside the Browse button, and the button never
  // read it: typing a folder and pressing Browse listed the LOADED file's
  // directory instead, discarding the typed text with no signal.
  it("lists what the user typed, in preference to the loaded file's directory", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const [s, dispose] = withStore({
      listDir,
      loadFile: async () => ({ kind: "code", text: "x" }),
    });
    await s.open("/home/u/proj/main.ts");
    await s.browseStart("/home/u/proj/sub");
    expect(listDir).toHaveBeenCalledWith("/home/u/proj/sub", false);
    expect(s.browseDir()).toBe("/home/u/proj/sub");
    dispose();
  });

  it("lists what the user typed even with no file loaded at all", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const [s, dispose] = withStore({ listDir, homeDir: async () => "/home/u" });
    s.show();
    await s.browseStart("  /home/u/typed  ");
    expect(listDir).toHaveBeenCalledWith("/home/u/typed", false);
    dispose();
  });

  // The box MIRRORS the open file (an effect keeps it in sync), so a box that
  // still equals path() means nothing was typed — the old behaviour stands, and
  // the deliberate folder route below keeps working.
  it("treats a box that still mirrors the open file as nothing typed", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const [s, dispose] = withStore({
      listDir,
      loadFile: async () => ({ kind: "code", text: "x" }),
    });
    await s.open("/home/u/proj/main.ts");
    await s.browseStart("/home/u/proj/main.ts");
    expect(listDir).toHaveBeenCalledWith("/home/u/proj", false);
    dispose();
  });

  it("keeps the folder-Open → Browse route when the box mirrors that folder", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const [s, dispose] = withStore({
      listDir,
      loadFile: async () => {
        throw new FileApiError(400, readErrorMessage(400, "path is a directory\n"), true);
      },
    });
    await s.open("/home/u/proj/sub");
    await s.browseStart("/home/u/proj/sub");
    expect(listDir).toHaveBeenCalledWith("/home/u/proj/sub", false);
    dispose();
  });

  it("opens the browse pane with an explanation when even home is unknown", async () => {
    const listDir = vi.fn(async () => [] as FileEntry[]);
    const [s, dispose] = withStore({ listDir, homeDir: async () => null });
    s.show();
    await s.browseStart();
    expect(s.browsing()).toBe(true);
    expect(s.browseStatus()).toBe("error");
    expect(s.browseError()).toBeTruthy();
    expect(listDir).not.toHaveBeenCalled();
    dispose();
  });
});

// The chip is set once at load and was never recomputed, so after saving a file
// that grew 59 -> 82 bytes the header still advertised the old size.
describe("preview store — the size chip follows a save", () => {
  it("save() recomputes size in bytes from the saved draft", async () => {
    const original = "# héllo wörld — ünïcødé ✅\n\nnaïve café résumé\n"; // 59 bytes
    const [s, dispose] = withStore({
      loadFile: async () => ({ kind: "markdown", text: original, size: 59 }),
      writeFile: async () => {},
      notify: () => {},
    });
    await s.open("/home/u/utf8.md");
    expect(s.size()).toBe(59);

    const grown = `${original}añadido — twenty-three more bytes\n`;
    s.beginEdit();
    s.setDraft(grown);
    await s.save();
    expect(s.text()).toBe(grown);
    expect(s.size()).toBe(new TextEncoder().encode(grown).length);
    expect(s.size()).toBeGreaterThan(59);
    dispose();
  });

  it("a FAILED save leaves the size untouched", async () => {
    const [s, dispose] = withStore({
      loadFile: async () => ({ kind: "code", text: "abc", size: 3 }),
      writeFile: async () => {
        throw new FileApiError(413, "File is too large to save (max 10MB).");
      },
      notify: () => {},
    });
    await s.open("/home/u/a.ts");
    s.beginEdit();
    s.setDraft("abcdefghij");
    await s.save();
    expect(s.size()).toBe(3);
    dispose();
  });
});
