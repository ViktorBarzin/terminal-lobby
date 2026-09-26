import { describe, it, expect } from "vitest";
import {
  PAD,
  STORE_ROOT,
  anchorRestored,
  attachToken,
  attachmentKind,
  cutSpan,
  dropToken,
  collapseSegments,
  contentUrlFor,
  isPicturePath,
  isRenderablePath,
  parseStorePath,
  previewContentUrl,
  segmentMessage,
  segmentPrompt,
  storedDisplayName,
  type Segment,
  type TokenizedAttachment,
} from "../src/lib/attachments";
import type { ImageRef } from "../src/types/events";

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

  // A picture comes from any path the caller can read, /tmp included, through
  // file-api's picture-only route (2026-09-24). 57 of 137 Reads of an image in
  // the census were under /tmp/claude-1000/*/scratchpad, which /files/read
  // refuses because it confines to the home.
  it("serves a picture anywhere on disk through the picture route", () => {
    expect(contentUrlFor("/home/wizard/code/out/plot.png", MINE)).toBe(
      "/files/image?path=%2Fhome%2Fwizard%2Fcode%2Fout%2Fplot.png",
    );
    expect(contentUrlFor("/tmp/claude-1000/x/scratchpad/shot.PNG", MINE)).toBe(
      "/files/image?path=%2Ftmp%2Fclaude-1000%2Fx%2Fscratchpad%2Fshot.PNG",
    );
  });

  // The picture route names svg by its extension and serves it sandboxed, so
  // it takes svg too.
  it("serves an svg through the picture route", () => {
    expect(contentUrlFor("/home/wizard/diagram.svg", MINE)).toBe(
      "/files/image?path=%2Fhome%2Fwizard%2Fdiagram.svg",
    );
  });

  // The picture route sniffs four raster types and nothing else, so an image
  // it would refuse keeps the home-only read it has always had rather than
  // turning into a 415.
  it("keeps /files/read for an image type the picture route does not serve", () => {
    expect(contentUrlFor("/home/wizard/icon.bmp", MINE)).toBe(
      "/files/read?path=%2Fhome%2Fwizard%2Ficon.bmp",
    );
  });

  it("serves a document through the file-api's read, as before", () => {
    expect(contentUrlFor("/home/wizard/notes.pdf", MINE)).toBe(
      "/files/read?path=%2Fhome%2Fwizard%2Fnotes.pdf",
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

  // Only an ABSOLUTE path is a picture (decision 1). Today's expression found
  // `/a.png` inside `shots/a.png`, and the tail of a URL or a home-relative path
  // the same way, so the character before a match decides whether it starts a
  // path at all.
  it("refuses a match that continues a relative path, a URL or a ~ path", () => {
    for (const text of [
      "saved to shots/a.png",
      "saved to ./a.png",
      "saved to ../up/a.png",
      "saved to ~/a.png",
      "see https://x.com/a.png",
      "see file:///tmp/a.png",
      "nova-tv.png",
    ]) {
      expect(files(segmentMessage(text)), text).toEqual([]);
    }
  });

  it("accepts a path in backticks, brackets or quotes", () => {
    for (const text of ["`/tmp/a.png`", "(/tmp/a.png)", '"/tmp/a.png"', "at:\n/tmp/a.png"]) {
      expect(files(segmentMessage(text)), text).toMatchObject([{ path: "/tmp/a.png" }]);
    }
  });

  it("still finds a path after a refused one in the same text", () => {
    const segs = segmentMessage("not shots/a.png but /tmp/b.png");
    expect(files(segs)).toMatchObject([{ path: "/tmp/b.png" }]);
  });

  // The store branch takes everything up to whitespace, so a backticked store
  // path in a bubble carried its closing backtick into the file name.
  it("leaves a closing backtick out of a store path", () => {
    const path = P("wizard/s/pasted-20260817-150232-a1b2c3d4.png");
    const segs = segmentMessage("look at `" + path + "` please");
    expect(files(segs)).toMatchObject([{ path }]);
    expect(segs.at(-1)).toEqual({ kind: "text", text: "` please" });
  });
});

describe("isPicturePath", () => {
  it("accepts an absolute path to an image", () => {
    for (const p of ["/tmp/a.png", "/home/wizard/x/Plot.JPG", "/a.webp", "/x/y.svg", "/x/y.heic"]) {
      expect(isPicturePath(p), p).toBe(true);
    }
  });

  it("refuses a relative path, a URL, a query or a fragment", () => {
    for (const p of ["a.png", "./a.png", "//cdn.x/a.png", "https://x/a.png", "/a.png?x=1", "/a.png#top"]) {
      expect(isPicturePath(p), p).toBe(false);
    }
  });

  it("refuses a path that is not an image", () => {
    expect(isPicturePath("/home/wizard/notes.pdf")).toBe(false);
    expect(isPicturePath("/home/wizard/x/App.tsx")).toBe(false);
  });

  // A reference the lobby wrote by hand to one of its own routes is already a
  // URL. `![](/clipboard/img/abc.png)` has always been passed through verbatim.
  it("refuses a path under one of the lobby's own routes", () => {
    for (const p of [
      "/clipboard/img/abc.png",
      "/files/read/a.png",
      "/result/s/t/image.png",
      "/api/sessions/x.png",
      "/assets/logo.png",
    ]) {
      expect(isPicturePath(p), p).toBe(false);
    }
  });
});

// --- a terminal paste: `[Image #N]` in the text, the picture in a block ------
describe("segmentPrompt", () => {
  const ref = (n: number, paste?: number): ImageRef => ({
    n,
    mediaType: "image/png",
    bytes: 100,
    ...(paste !== undefined ? { paste } : {}),
  });

  it("puts each picture where its placeholder stood, matched by paste id", () => {
    const a = ref(0, 1);
    const b = ref(1, 2);
    expect(segmentPrompt("[Image #2] vs [Image #1]\n\nwhich?", [a, b])).toEqual([
      { kind: "block", ref: b, text: "[Image #2]" },
      { kind: "text", text: " vs " },
      { kind: "block", ref: a, text: "[Image #1]" },
      { kind: "text", text: "\n\nwhich?" },
    ]);
  });

  it("matches by order when no picture carries a paste id", () => {
    const a = ref(0);
    const b = ref(1);
    expect(segmentPrompt("[Image #3] and [Image #7]", [a, b])).toEqual([
      { kind: "block", ref: a, text: "[Image #3]" },
      { kind: "text", text: " and " },
      { kind: "block", ref: b, text: "[Image #7]" },
    ]);
  });

  it("keeps a placeholder no picture answers to as text", () => {
    const a = ref(0, 1);
    expect(segmentPrompt("[Image #1] and [Image #2]", [a])).toEqual([
      { kind: "block", ref: a, text: "[Image #1]" },
      { kind: "text", text: " and [Image #2]" },
    ]);
  });

  it("claims a picture once, so a repeated placeholder stays text", () => {
    const a = ref(0, 1);
    expect(segmentPrompt("[Image #1] [Image #1]", [a])).toEqual([
      { kind: "block", ref: a, text: "[Image #1]" },
      { kind: "text", text: " [Image #1]" },
    ]);
  });

  it("appends a picture no placeholder claimed, on a line of its own", () => {
    const a = ref(0, 5);
    expect(segmentPrompt("what is this?", [a])).toEqual([
      { kind: "text", text: "what is this?" },
      { kind: "text", text: "\n" },
      { kind: "block", ref: a, text: "" },
    ]);
    expect(segmentPrompt("", [a])).toEqual([{ kind: "block", ref: a, text: "" }]);
  });

  it("leaves a prompt with no pictures exactly as segmentMessage does", () => {
    const text = `see ${P("wizard/s/pasted-a1.png")} and [Image #1]`;
    expect(segmentPrompt(text, [])).toEqual(segmentMessage(text));
    expect(segmentPrompt(text)).toEqual(segmentMessage(text));
  });

  it("keeps a store path and a placeholder side by side", () => {
    const path = P("wizard/s/pasted-a1.png");
    const a = ref(0, 1);
    expect(segmentPrompt(`${path}\n[Image #1]`, [a])).toEqual([
      { kind: "file", path, name: "pasted-a1.png", fileKind: "image" },
      { kind: "text", text: "\n" },
      { kind: "block", ref: a, text: "[Image #1]" },
    ]);
  });
});

// --- collapsing a long bubble without cutting a path in half ----------------
describe("collapseSegments", () => {
  const text = (t: string): Segment => ({ kind: "text", text: t });

  it("cuts a long text run at the limit and says so", () => {
    const r = collapseSegments([text("a".repeat(700))], 600);
    expect(r.cut).toBe(true);
    expect(r.segments).toEqual([text("a".repeat(600))]);
  });

  it("leaves a message within the limit whole", () => {
    const segs = [text("a".repeat(600))];
    expect(collapseSegments(segs, 600)).toEqual({ segments: segs, cut: false });
  });

  // The old collapse sliced the body at character 600, which could end in the
  // middle of a store path: the bubble then showed a broken fragment of the
  // path as text where the picture should have been.
  it("keeps a store path that straddles the limit whole", () => {
    const path = P("wizard/s/pasted-20260817-150232-a1b2c3d4.png");
    const segs = segmentMessage("x".repeat(580) + " " + path + " and then " + "y".repeat(100));
    const r = collapseSegments(segs, 600);
    expect(r.cut).toBe(true);
    expect(files(r.segments)).toMatchObject([{ path }]);
    expect(r.segments.at(-1)).toMatchObject({ kind: "file", path });
  });

  it("keeps a placeholder whole, and drops what starts past the limit", () => {
    const block: Segment = { kind: "block", ref: { n: 0, paste: 1 }, text: "[Image #1]" };
    const late: Segment = { kind: "block", ref: { n: 1, paste: 2 }, text: "[Image #2]" };
    const r = collapseSegments([text("a".repeat(595)), block, text("b".repeat(50)), late], 600);
    expect(r.cut).toBe(true);
    expect(r.segments).toEqual([text("a".repeat(595)), block]);
  });

  it("does not report a cut when the only thing past the limit is nothing", () => {
    const r = collapseSegments([text("a".repeat(600)), text("")], 600);
    expect(r.cut).toBe(false);
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

// --- the tokens an attachment stands as, inside the message ----------------
// A file is written into the prompt as a token where the writer put it, and
// swapped for its path at send time (2026-09-13). These decide whether a chip
// can be paired back to its file at all, and each fails quietly when wrong: a
// mispaired token sends the wrong path, and a token the restore does not
// recognize reaches Claude as literal text.
describe("attachToken", () => {
  const none = new Set<string>();

  it("names the file when the name says something", () => {
    expect(attachToken("chart.png", "image", none)).toBe("[img: chart.png]");
    expect(attachToken("report.pdf", "doc", none)).toBe("[file: report.pdf]");
  });

  it("recovers the name the writer chose from a stored one", () => {
    expect(attachToken("file-20260817-150232-c17e6008-report.pdf", "doc", none)).toBe(
      "[file: report.pdf]",
    );
  });

  it("says nothing more than the kind for a name only the store cares about", () => {
    expect(attachToken("pasted-20260817-150232-a1.png", "image", none)).toBe("[img]");
    expect(attachToken("displayed-20260817-150232-a1.png", "image", none)).toBe("[img]");
    // What Chrome calls a clipboard image.
    expect(attachToken("image.png", "image", none)).toBe("[img]");
  });

  it("numbers around the tokens already in the message", () => {
    expect(attachToken("shot.png", "image", new Set(["[img: shot.png]"]))).toBe(
      "[img 2: shot.png]",
    );
    expect(attachToken("a.png", "image", new Set(["[img]"]))).toBe("[img: a.png]");
    expect(attachToken("x.png", "image", new Set(["[img: x.png]", "[img 2: x.png]"]))).toBe(
      "[img 3: x.png]",
    );
  });

  it("cuts a long name short rather than filling the line with it", () => {
    const t = attachToken("a-very-long-screenshot-name-indeed.png", "image", none);
    expect(t.length).toBeLessThanOrEqual(30);
    expect(t.endsWith("…]")).toBe(true);
  });

  // An image token is drawn as the picture itself, painted over the token's own
  // characters — so the token has to be as WIDE as the picture, or the picture
  // covers the words after it. The padding is figure spaces, which do not break
  // a line, so the token can never be split with the thumbnail across the break.
  it("pads the token out to the width a thumbnail needs", () => {
    expect(attachToken("pasted-20260817-150232-a1.png", "image", none, 6)).toBe(
      `[img${PAD.repeat(6)}]`,
    );
    expect(attachToken("chart.png", "image", none, 3)).toBe(`[img: chart.png${PAD.repeat(3)}]`);
  });

  it("numbers around a padded token already in the message", () => {
    const taken = new Set([`[img${PAD.repeat(6)}]`]);
    expect(attachToken("pasted-20260817-150232-a2.png", "image", taken, 6)).toBe(
      `[img 2${PAD.repeat(6)}]`,
    );
  });

  it("pads nothing when no width was asked for", () => {
    expect(attachToken("pasted-20260817-150232-a1.png", "image", none)).toBe("[img]");
  });
});

describe("cutSpan and dropToken", () => {
  it("takes the space that separated the chip from its neighbour", () => {
    expect(dropToken("look at [img] here", "[img]")).toBe("look at here");
    expect(dropToken("look at [img]", "[img]")).toBe("look at");
    expect(dropToken("[img] here", "[img]")).toBe("here");
  });

  it("leaves a message that never had the token alone", () => {
    expect(dropToken("nothing attached", "[img]")).toBe("nothing attached");
  });

  it("says where the caret lands", () => {
    expect(cutSpan("look at [img] here", 8, 13)).toEqual({ text: "look at here", at: 8 });
  });
});

describe("anchorRestored", () => {
  const img = { name: "chart.png", kind: "image" as const, token: "[img: chart.png]" };

  it("keeps an attachment whose token is still in the text", () => {
    const r = anchorRestored("what about [img: chart.png]?", [img]);
    expect(r.text).toBe("what about [img: chart.png]?");
    expect(r.items).toEqual([img]);
  });

  it("anchors one that has no token yet, at the end", () => {
    const loose: TokenizedAttachment = { name: "chart.png", kind: "image" };
    const r = anchorRestored("half written", [loose]);
    expect(r.text).toBe("half written [img: chart.png]");
    expect(r.items[0]!.token).toBe("[img: chart.png]");
  });

  it("cuts out a token no attachment owns any more", () => {
    // The new-session composer holds Files, which cannot be persisted, so its
    // tokens outlive them by exactly one reload.
    const r = anchorRestored("what is wrong here? [img: shot.png]", []);
    expect(r.text).toBe("what is wrong here?");
    expect(r.items).toEqual([]);
  });

  it("keeps the ones it owns while cutting the ones it does not", () => {
    const r = anchorRestored("[img] and [img: chart.png] and [file: gone.pdf]", [img]);
    expect(r.text).toBe("and [img: chart.png] and");
    expect(r.items).toEqual([img]);
  });

  it("cuts out a padded token no attachment owns any more", () => {
    // The same reload as above, for a token written wide enough to carry a
    // picture. A pattern that did not know about the padding would leave the
    // whole thing in the message, and Claude would be sent the literal token.
    const r = anchorRestored(`what is wrong here? [img${PAD.repeat(8)}]`, []);
    expect(r.text).toBe("what is wrong here?");
    expect(r.items).toEqual([]);
  });

  it("has nothing to do for a plain message", () => {
    const r = anchorRestored("just words", []);
    expect(r.text).toBe("just words");
    expect(r.items).toEqual([]);
  });
});
