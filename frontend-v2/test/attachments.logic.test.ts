import { describe, it, expect } from "vitest";
import {
  STORE_ROOT,
  attachmentKind,
  contentUrlFor,
  isRenderablePath,
  parseStorePath,
  previewContentUrl,
  segmentMessage,
  storedDisplayName,
  type Segment,
} from "../src/lib/attachments";

/**
 * The recognition rule and the backend resolver
 * (docs/plans/2026-08-17-text-view-attachments-design.md, decision 7 and the
 * "one resolver" consequence). Pure — no fetch, no DOM — because it decides
 * both what a bubble draws and which of two services it draws it from, and
 * getting either wrong is silent: a wrong URL is a broken image, and a wrong
 * match turns prose into a chip.
 */

const MINE = "wizard";
const P = (rest: string): string => `${STORE_ROOT}/${rest}`;

/** Only the file segments, for the many cases where the prose is noise. */
const files = (segs: Segment[]): Segment[] => segs.filter((s) => s.kind === "file");

describe("parseStorePath", () => {
  it("splits owner, session and name", () => {
    expect(parseStorePath(P("wizard/anniversary/pasted-2026-a1.png"))).toEqual({
      owner: "wizard",
      session: "anniversary",
      name: "pasted-2026-a1.png",
    });
  });

  it("rejects anything that is not a store path", () => {
    expect(parseStorePath("/home/wizard/code/out/plot.png")).toBeNull();
    expect(parseStorePath("/tmp/clipboard-files/x.pdf")).toBeNull();
    expect(parseStorePath("")).toBeNull();
  });

  it("rejects a store path missing a segment, or carrying an extra one", () => {
    expect(parseStorePath(P("wizard/pasted-a1.png"))).toBeNull();
    expect(parseStorePath(P("wizard"))).toBeNull();
    expect(parseStorePath(P("wizard/session/sub/a1.png"))).toBeNull();
  });

  it("rejects a session name outside the charset every surface is keyed by", () => {
    expect(parseStorePath(P("wizard/has spaces/a1.png"))).toBeNull();
    expect(parseStorePath(P("wizard/../etc/a1.png"))).toBeNull();
  });
});

describe("attachmentKind", () => {
  it("calls a known image extension an image", () => {
    for (const n of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.avif", "a.heic"]) {
      expect(attachmentKind(n), n).toBe("image");
    }
  });

  it("calls everything else a doc", () => {
    for (const n of ["report.pdf", "q2.csv", "notes.md", "data.bin", "noext"]) {
      expect(attachmentKind(n), n).toBe("doc");
    }
  });
});

describe("isRenderablePath", () => {
  // Anything the app itself put in the store is chat content by construction,
  // whatever it is called — that is what the user attached.
  it("renders any store path, extension known or not", () => {
    expect(isRenderablePath(P("wizard/s/file-2026-abcd-report.pdf"))).toBe(true);
    expect(isRenderablePath(P("wizard/s/file-2026-abcd-archive.bin"))).toBe(true);
    expect(isRenderablePath(P("wizard/s/pasted-2026-a1.png"))).toBe(true);
  });

  it("renders an image anywhere on disk, so a plot Claude drew shows up", () => {
    expect(isRenderablePath("/home/wizard/code/out/plot.png")).toBe(true);
    expect(isRenderablePath("/tmp/screenshot.jpeg")).toBe(true);
  });

  it("renders an unambiguous document format anywhere on disk", () => {
    expect(isRenderablePath("/home/wizard/Downloads/report.pdf")).toBe(true);
    expect(isRenderablePath("/home/wizard/data/q2.csv")).toBe(true);
  });

  // The timeline is mostly Claude naming source files. Turning every one of
  // those into a chip would bury the conversation, and they already have an
  // affordance: the tool row that read them opens the preview.
  it("leaves a source path alone", () => {
    for (const p of [
      "/home/wizard/code/terminal-lobby/src/App.tsx",
      "/home/wizard/code/infra/main.tf",
      "/home/wizard/code/x/main.go",
      "/etc/nginx/nginx.conf",
      "/home/wizard/docs/plans/design.md",
    ]) {
      expect(isRenderablePath(p), p).toBe(false);
    }
  });

  it("leaves a relative path alone — a chip needs something Claude can read", () => {
    expect(isRenderablePath("out/plot.png")).toBe(false);
    expect(isRenderablePath("./plot.png")).toBe(false);
  });
});

describe("contentUrlFor", () => {
  it("serves my own stored image through the image route", () => {
    expect(contentUrlFor(P("wizard/anniversary/pasted-2026-a1.png"), MINE)).toBe(
      "/clipboard/img/anniversary/pasted-2026-a1.png",
    );
  });

  it("serves my own stored document through the document route", () => {
    expect(contentUrlFor(P("wizard/s/file-2026-abcd-report.pdf"), MINE)).toBe(
      "/clipboard/file/s/file-2026-abcd-report.pdf",
    );
  });

  // The clipboard routes ignore the user segment and resolve inside the
  // CALLER's own directory, so serving this would either 404 or — worse —
  // answer with your own same-named file.
  it("refuses another user's store path rather than resolving it as mine", () => {
    expect(contentUrlFor(P("bob/s/pasted-2026-a1.png"), MINE)).toBeNull();
  });

  it("serves anything else through the file-api", () => {
    expect(contentUrlFor("/home/wizard/code/out/plot.png", MINE)).toBe(
      "/files/read?path=%2Fhome%2Fwizard%2Fcode%2Fout%2Fplot.png",
    );
  });

  it("has nothing to serve without a known effective user", () => {
    expect(contentUrlFor(P("wizard/s/pasted-2026-a1.png"), "")).toBeNull();
  });
});

describe("storedDisplayName", () => {
  // The stored name carries a timestamp and a random token the user never
  // chose. A chip shows what they picked.
  it("strips the file- prefix, the stamp and the token", () => {
    expect(storedDisplayName("file-20260817-150232-c17e6008-report.pdf")).toBe("report.pdf");
  });

  it("leaves a name it does not recognise alone", () => {
    expect(storedDisplayName("pasted-20260817-150232-a1.png")).toBe(
      "pasted-20260817-150232-a1.png",
    );
    expect(storedDisplayName("report.pdf")).toBe("report.pdf");
  });
});

describe("segmentMessage", () => {
  it("returns one text segment when there is no path", () => {
    expect(segmentMessage("what's wrong here?")).toEqual([
      { kind: "text", text: "what's wrong here?" },
    ]);
  });

  it("replaces a path in place, keeping the prose around it", () => {
    const segs = segmentMessage(`look at ${P("wizard/s/pasted-a1.png")} closely`);
    expect(segs).toEqual([
      { kind: "text", text: "look at " },
      {
        kind: "file",
        path: P("wizard/s/pasted-a1.png"),
        name: "pasted-a1.png",
        fileKind: "image",
      },
      { kind: "text", text: " closely" },
    ]);
  });

  // The pty typed the path at the caret, so every message predating the tray
  // has it welded into the middle of a sentence.
  it("handles the historical mid-sentence shape", () => {
    const path = P("wizard/anniversary/pasted-20260719-161556-94d38fa6.png");
    const segs = segmentMessage(`which table would you recommend for 2 ${path}`);
    expect(files(segs)).toHaveLength(1);
    expect(files(segs)[0]).toMatchObject({ path, fileKind: "image" });
  });

  it("handles our own send format — paths first, one per line", () => {
    const a = P("wizard/s/pasted-a1.png");
    const b = P("wizard/s/file-2026-abcd-report.pdf");
    const segs = segmentMessage(`${a}\n${b}\nwhat's wrong, vs the pdf?`);
    expect(files(segs).map((s) => s.kind === "file" && s.path)).toEqual([a, b]);
    expect(files(segs).map((s) => s.kind === "file" && s.fileKind)).toEqual(["image", "doc"]);
  });

  it("does not swallow trailing prose punctuation into the path", () => {
    const path = P("wizard/s/pasted-a1.png");
    const segs = segmentMessage(`see ${path}, then stop.`);
    expect(files(segs)[0]).toMatchObject({ path });
    expect(segs.at(-1)).toEqual({ kind: "text", text: ", then stop." });
  });

  it("leaves a longer extension alone rather than matching a prefix of it", () => {
    // .pngx is not .png — matching it would render a file that is not there.
    expect(files(segmentMessage("/home/wizard/a.pngx"))).toHaveLength(0);
  });

  it("leaves source paths as text", () => {
    const text = "edit /home/wizard/code/x/App.tsx and /home/wizard/code/x/main.go";
    expect(segmentMessage(text)).toEqual([{ kind: "text", text }]);
  });

  it("keeps an empty message empty", () => {
    expect(segmentMessage("")).toEqual([]);
  });
});

describe("previewContentUrl", () => {
  // The preview asks a different question from the timeline: the user opened
  // this file deliberately, so a 404 is a message worth showing rather than a
  // row to quietly downgrade.
  it("resolves a store path without asking who owns it", () => {
    expect(previewContentUrl(P("bob/s/pasted-2026-a1.png"))).toBe(
      "/clipboard/img/s/pasted-2026-a1.png",
    );
  });

  it("sends a stored document to the document route", () => {
    expect(previewContentUrl(P("wizard/s/file-2026-abcd-report.pdf"))).toBe(
      "/clipboard/file/s/file-2026-abcd-report.pdf",
    );
  });

  it("sends everything else to the file-api", () => {
    expect(previewContentUrl("/home/wizard/notes.md")).toBe(
      "/files/read?path=%2Fhome%2Fwizard%2Fnotes.md",
    );
  });

  it("has nothing to resolve for a relative path", () => {
    expect(previewContentUrl("notes.md")).toBeNull();
  });
});
