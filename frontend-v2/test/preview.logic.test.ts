import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import { canEdit } from "../src/store/editor.logic";
import {
  HTML_SANDBOX,
  basename,
  byteLength,
  classifyFile,
  dirname,
  extOf,
  extractRecentFiles,
  isAbsolutePath,
  languageForPath,
  modeApplies,
  nextMode,
  parseToolPath,
  sandboxIsSafe,
} from "../src/store/preview.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

describe("classifyFile — file-type -> renderer routing", () => {
  it("routes markdown extensions to the markdown renderer", () => {
    expect(classifyFile("README.md").kind).toBe("markdown");
    expect(classifyFile("/a/b/notes.markdown").kind).toBe("markdown");
    expect(classifyFile("doc.mdx").kind).toBe("markdown");
  });

  it("routes html extensions to the html (sandboxed-iframe) renderer", () => {
    expect(classifyFile("index.html").kind).toBe("html");
    expect(classifyFile("page.htm").kind).toBe("html");
  });

  it("routes image extensions to the image renderer", () => {
    for (const n of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.avif"]) {
      expect(classifyFile(n).kind).toBe("image");
    }
  });

  it("routes known code extensions to code, with a highlight.js language", () => {
    expect(classifyFile("main.ts")).toEqual({ kind: "code", language: "typescript" });
    expect(classifyFile("app.py")).toEqual({ kind: "code", language: "python" });
    expect(classifyFile("server.go")).toEqual({ kind: "code", language: "go" });
    expect(classifyFile("Dockerfile")).toEqual({ kind: "code", language: "dockerfile" });
    expect(classifyFile("conf.toml")).toEqual({ kind: "code", language: "ini" });
  });

  it("treats plain-text extensions as code with no language", () => {
    expect(classifyFile("out.log")).toEqual({ kind: "code" });
    expect(classifyFile(".env")).toEqual({ kind: "code" }); // dotfile, no ext
  });

  it("uses content-type to resolve an unknown extension", () => {
    expect(classifyFile("blob", "image/png").kind).toBe("image");
    expect(classifyFile("blob", "application/octet-stream").kind).toBe("binary");
    expect(classifyFile("blob", "application/pdf").kind).toBe("pdf");
    expect(classifyFile("blob", "text/plain").kind).toBe("code");
    expect(classifyFile("data", "application/json").kind).toBe("code");
  });

  it("defaults an unknown extension with no content-type to code (optimistic)", () => {
    expect(classifyFile("mystery").kind).toBe("code");
  });

  it("prefers the extension over the content-type for known types", () => {
    // A .md served as text/plain is still markdown; a .png served oddly is image.
    expect(classifyFile("x.md", "text/plain").kind).toBe("markdown");
    expect(classifyFile("x.png", "application/octet-stream").kind).toBe("image");
  });
});

describe("extOf / basename / dirname / languageForPath", () => {
  it("extracts the lower-cased extension", () => {
    expect(extOf("/a/b/File.TS")).toBe("ts");
    expect(extOf("noext")).toBe("");
    expect(extOf("/a/.gitignore")).toBe(""); // leading-dot dotfile has no ext
  });
  it("treats a bare Dockerfile as the dockerfile ext", () => {
    expect(extOf("/repo/Dockerfile")).toBe("dockerfile");
    expect(extOf("Dockerfile.dev")).toBe("dockerfile");
  });
  it("basename returns the trailing segment", () => {
    expect(basename("/a/b/c.txt")).toBe("c.txt");
    expect(basename("c.txt")).toBe("c.txt");
    expect(basename("/a/b/")).toBe("b");
  });
  it("dirname returns the parent", () => {
    expect(dirname("/a/b/c.txt")).toBe("/a/b");
    expect(dirname("/a")).toBe("/");
    expect(dirname("/a/b/")).toBe("/a");
  });
  // The browse pane walks up with dirname. Returning the RELATIVE "." for the
  // root turned the fourth ⬆ Up click into a navigation to ".", which file-api
  // rejects (errNotAbsolute → 400) and the pane labelled as a "." directory.
  // The root is its own parent, so the walk has a fixed point to stop on.
  it("dirname of the root is the root, never the relative '.'", () => {
    expect(dirname("/")).toBe("/");
    expect(dirname("//")).toBe("/");
    expect(dirname("///")).toBe("/");
  });
  it("languageForPath maps by extension", () => {
    expect(languageForPath("x.rs")).toBe("rust");
    expect(languageForPath("x.unknownext")).toBeUndefined();
  });
});

describe("byteLength", () => {
  // The size chip is a BYTE count. JS string length counts UTF-16 code units,
  // so any non-ASCII file reported short (the fixture below is 59 bytes on
  // disk, 45 JS characters).
  it("counts UTF-8 bytes, not JS characters", () => {
    const utf8 = "# héllo wörld — ünïcødé ✅\n\nnaïve café résumé\n";
    expect(utf8.length).toBe(45); // what the old `text.length` reported
    expect(byteLength(utf8)).toBe(59); // what `wc -c` reports
  });
  it("is 0 for the empty string and exact for pure ASCII", () => {
    expect(byteLength("")).toBe(0);
    expect(byteLength("hello")).toBe(5);
  });
  it("counts an astral-plane character as its four UTF-8 bytes", () => {
    expect("𝄞".length).toBe(2); // surrogate pair
    expect(byteLength("𝄞")).toBe(4);
  });
});

describe("isAbsolutePath", () => {
  it("accepts POSIX + Windows-drive absolute paths, rejects relative", () => {
    expect(isAbsolutePath("/home/u/a.txt")).toBe(true);
    expect(isAbsolutePath("C:\\Users\\a.txt")).toBe(true);
    expect(isAbsolutePath("relative/a.txt")).toBe(false);
    expect(isAbsolutePath("a.txt")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });
});

describe("HTML sandbox — hard security invariant", () => {
  it("the sandbox value is empty (maximally restrictive)", () => {
    expect(HTML_SANDBOX).toBe("");
  });
  it("the sandbox value never enables scripts or same-origin", () => {
    expect(HTML_SANDBOX).not.toContain("allow-same-origin");
    expect(HTML_SANDBOX).not.toContain("allow-scripts");
    expect(sandboxIsSafe(HTML_SANDBOX)).toBe(true);
  });
  it("sandboxIsSafe flags a value that would run user HTML against our origin", () => {
    expect(sandboxIsSafe("allow-scripts")).toBe(false);
    expect(sandboxIsSafe("allow-same-origin")).toBe(false);
    expect(sandboxIsSafe("allow-scripts allow-same-origin")).toBe(false);
    expect(sandboxIsSafe("allow-forms")).toBe(true);
  });
});

describe("parseToolPath — transcript tool -> file path", () => {
  it("extracts file_path from Read/Edit/Write tool inputs", () => {
    expect(parseToolPath("Read", '{"file_path":"/a/b.ts"}')).toBe("/a/b.ts");
    expect(parseToolPath("Edit", '{"file_path":"/a/b.ts","old_string":"x"}')).toBe("/a/b.ts");
    expect(parseToolPath("Write", '{"file_path":"/c/d.md","content":"hi"}')).toBe("/c/d.md");
    expect(parseToolPath("NotebookEdit", '{"notebook_path":"/n/x.ipynb"}')).toBe("/n/x.ipynb");
  });
  it("returns null for non-file tools", () => {
    expect(parseToolPath("Bash", '{"command":"ls /a"}')).toBeNull();
    expect(parseToolPath("Grep", '{"pattern":"foo","path":"/a"}')).toBeNull();
  });
  it("rejects relative paths and malformed input", () => {
    expect(parseToolPath("Read", '{"file_path":"relative.ts"}')).toBeNull();
    expect(parseToolPath("Read", "not json")).toBeNull();
    expect(parseToolPath("Read", "")).toBeNull();
    expect(parseToolPath("Read", "{}")).toBeNull();
  });
});

describe("extractRecentFiles — transcript -> recent files list", () => {
  it("collects Read/Edit/Write paths newest-first, de-duplicated by path", () => {
    const events: Event[] = [
      ev({ id: 1, kind: "tool_use", tool: "Read", body: '{"file_path":"/a/one.ts"}' }),
      ev({ id: 2, kind: "tool_use", tool: "Bash", body: '{"command":"ls"}' }),
      ev({ id: 3, kind: "tool_use", tool: "Edit", body: '{"file_path":"/a/two.md"}' }),
      ev({ id: 4, kind: "tool_use", tool: "Read", body: '{"file_path":"/a/one.ts"}' }), // dup, newer
    ];
    const recent = extractRecentFiles(events);
    expect(recent.map((r) => r.path)).toEqual(["/a/one.ts", "/a/two.md"]);
    expect(recent[0]).toMatchObject({ name: "one.ts", tool: "Read" });
  });

  it("honours the limit", () => {
    const events: Event[] = Array.from({ length: 20 }, (_, i) =>
      ev({ id: i + 1, kind: "tool_use", tool: "Read", body: `{"file_path":"/a/f${i}.ts"}` }),
    );
    expect(extractRecentFiles(events, 5)).toHaveLength(5);
  });

  it("returns [] when the transcript has no file tools", () => {
    expect(extractRecentFiles([ev({ id: 1, kind: "text", body: "hi" })])).toEqual([]);
  });
});

describe("mode toggle helpers", () => {
  it("nextMode flips rendered <-> raw", () => {
    expect(nextMode("rendered")).toBe("raw");
    expect(nextMode("raw")).toBe("rendered");
  });
  it("modeApplies only to markdown + html", () => {
    expect(modeApplies("markdown")).toBe(true);
    expect(modeApplies("html")).toBe(true);
    expect(modeApplies("code")).toBe(false);
    expect(modeApplies("image")).toBe(false);
    expect(modeApplies("binary")).toBe(false);
  });
});

// A PDF is the most likely document to be attached to a text-view message
// (docs/plans/2026-08-17-text-view-attachments-design.md decision 4), so it gets
// its own renderer instead of falling to "binary — preview unavailable".
describe("classifyFile — pdf", () => {
  it("routes a pdf by extension", () => {
    expect(classifyFile("report.pdf").kind).toBe("pdf");
    expect(classifyFile("/a/b/REPORT.PDF").kind).toBe("pdf");
  });

  it("routes a pdf by content type when the name says nothing", () => {
    expect(classifyFile("blob", "application/pdf").kind).toBe("pdf");
  });

  it("is not editable and has no raw/rendered toggle", () => {
    expect(canEdit("pdf")).toBe(false);
    expect(modeApplies("pdf")).toBe(false);
  });
});
