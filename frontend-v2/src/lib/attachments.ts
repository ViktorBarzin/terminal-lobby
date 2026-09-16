import { clipboardFileUrl, clipboardImgUrl, fileReadUrl } from "./config";
import { extOf, IMAGE_EXT } from "../store/preview.logic";
import { NAME_RE } from "../types/lobby";

/**
 * Attachments in the text view: which paths in a message are files worth
 * drawing, and which backend serves each one's bytes
 * (docs/plans/2026-08-17-text-view-attachments-design.md).
 *
 * Pure — no fetch, no Solid, no DOM. Two decisions live here and both fail
 * silently when wrong, which is why they are unit-tested away from the
 * components: a bad match turns prose into a chip, and a bad URL is a broken
 * image with nothing to say about why.
 */

/** Where clipboard-upload keeps the per-(user, session) store. */
export const STORE_ROOT = "/var/lib/clipboard-store";

/** What an attachment is drawn as. */
export type AttachmentKind = "image" | "doc";

/** A store path, split into the three things the read-back routes need. */
export interface StorePath {
  owner: string;
  session: string;
  name: string;
}

/**
 * Document formats that render as a chip when they are NOT in the store.
 *
 * Deliberately short. In the store, anything is chat content by construction —
 * the user attached it. Outside the store the timeline is mostly Claude naming
 * source files, and turning every `.ts`, `.go` or `.md` path into a chip would
 * bury the conversation under affordances for files nobody attached. Those
 * already have one: the tool row that read them opens the preview.
 *
 * So this is formats a person attaches and cannot read as plain text — not
 * "every extension the preview knows".
 */
const DOC_EXT = new Set([
  "pdf",
  "csv",
  "tsv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "epub",
  "pages",
  "numbers",
  "key",
]);

/**
 * Image extensions a chip may be drawn from. `IMAGE_EXT` is what the file
 * preview decodes; heic/heif/tiff are added because clipboard-upload accepts the
 * HEIF container (an iPhone-native photo), so such a path can genuinely name a
 * stored image. Chromium does not decode HEIF — that lands as the chip's error
 * placeholder, the same degradation the gallery already shows.
 */
const CHIP_IMAGE_EXT = new Set([...IMAGE_EXT, "heic", "heif", "tif", "tiff"]);

/** Every extension that can start a match outside the store. */
const RENDERABLE_EXT = [...CHIP_IMAGE_EXT, ...DOC_EXT];

/** Escape a literal for embedding in a RegExp source. */
function esc(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One match per file reference. The store branch comes FIRST so a stored file
 * matches whole, whatever it is named — alternation is ordered, and at a given
 * start position the leftmost branch that matches wins.
 *
 * The extension branch is anchored to END at a known extension, which keeps
 * prose punctuation out of the path with no trimming pass: `a.png,` matches only
 * `a.png`. The `\b` after the group stops `.pngx` matching as `.png`.
 */
const FILE_RE = new RegExp(
  `(?:${esc(STORE_ROOT)}\\/\\S+)|(?:\\/\\S*\\.(?:${RENDERABLE_EXT.join("|")})\\b)`,
  "gi",
);

/** Trailing characters that belong to the sentence, not to a stored path. */
const TRAILING_PROSE_RE = /[.,;:!?)\]}"'»]+$/;

/**
 * Split `/var/lib/clipboard-store/<owner>/<session>/<name>` into its parts, or
 * null for anything that is not exactly that shape. Both identity segments are
 * charset-checked because the session goes into a URL the read-back route
 * parses, and the owner decides whether it is ours to ask for at all.
 */
export function parseStorePath(path: string): StorePath | null {
  if (!path.startsWith(STORE_ROOT + "/")) return null;
  const parts = path.slice(STORE_ROOT.length + 1).split("/");
  if (parts.length !== 3) return null;
  const [owner, session, name] = parts as [string, string, string];
  if (!owner || !session || !name) return null;
  if (!NAME_RE.test(owner) || !NAME_RE.test(session)) return null;
  if (name.includes("..") || name.startsWith(".")) return null;
  return { owner, session, name };
}

/** How a file is drawn: a picture, or a chip. */
export function attachmentKind(name: string): AttachmentKind {
  return CHIP_IMAGE_EXT.has(extOf(name)) ? "image" : "doc";
}

/**
 * Whether a path is worth drawing as an attachment. In the store: always — the
 * user put it there. Outside it: images (so a plot Claude drew shows up) and
 * document formats, and nothing else.
 */
export function isRenderablePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (parseStorePath(path)) return true;
  const ext = extOf(path);
  return CHIP_IMAGE_EXT.has(ext) || DOC_EXT.has(ext);
}

/**
 * The URL that serves `path`'s bytes back, or null when nothing can.
 *
 * THE one place that decides between the two backends, so the timeline, the
 * gallery and the file preview cannot disagree about where a given path is read
 * from.
 *
 *   - a store path owned by `me` → the clipboard routes, which resolve inside
 *     the caller's own store directory
 *   - a store path owned by anyone else → null. The routes ignore the owner
 *     segment, so asking would either 404 or answer with the caller's own
 *     same-named file; falling back to the path text is decision 12
 *   - anything else → the file-api, which confines to the caller's home and
 *     answers 403 outside it, surfacing as the same fallback
 */
export function contentUrlFor(path: string, me: string): string | null {
  const store = parseStorePath(path);
  if (store && (!me || store.owner !== me)) return null;
  return previewContentUrl(path);
}

/**
 * Where a path's bytes are read from, WITHOUT the owner check.
 *
 * The file preview and the file-api client use this: a preview always acts as
 * the caller, and the clipboard routes resolve inside the caller's own store
 * directory regardless of what the path's owner segment says — so a foreign
 * path answers 404 (the stored name carries a timestamp and eight random hex
 * characters, so it cannot collide with one of the caller's own) and the
 * preview shows that as an error, which is the right outcome for a surface the
 * user opened deliberately.
 *
 * `contentUrlFor` adds the owner check on top, because the TIMELINE is asking a
 * different question — whether to draw anything at all, or fall back to the path
 * text — and there a speculative 404 per row is worth avoiding.
 */
export function previewContentUrl(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const store = parseStorePath(path);
  if (store) {
    return attachmentKind(store.name) === "image"
      ? clipboardImgUrl(store.session, store.name)
      : clipboardFileUrl(store.session, store.name);
  }
  return fileReadUrl(path);
}

/** `file-<stamp>-<token>-<original>` as written by clipboard-upload. */
const STORED_ATTACH_RE = /^file-\d{8}-\d{6}-[0-9a-f]{8}-(.+)$/;

/**
 * What a chip is labelled: the name the user chose, recovered from the stored
 * name's `file-<stamp>-<token>-` prefix. A name that does not match that shape
 * is shown as it is.
 */
export function storedDisplayName(name: string): string {
  return STORED_ATTACH_RE.exec(name)?.[1] ?? name;
}

/** A run of message text, or one file reference standing where it appeared. */
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; name: string; fileKind: AttachmentKind };

/**
 * Split a message into text runs and file references, replacing each renderable
 * path where it sits (decision 2). One rule serves every shape a message has
 * ever had: a path where the writer pasted it (2026-09-13), the block of paths
 * at the top that the tray sent before that, and the one the pty welded
 * mid-sentence before either.
 */
export function segmentMessage(text: string): Segment[] {
  if (!text) return [];
  const out: Segment[] = [];
  let at = 0;
  for (const m of text.matchAll(FILE_RE)) {
    const index = m.index ?? 0;
    // The store branch takes \S+, so it can absorb the sentence's punctuation;
    // the extension branch cannot, because it ends AT the extension. Anything
    // trimmed here is left behind for the following text run rather than
    // dropped, which is why `at` advances by the PATH's length, not the match's.
    const path = m[0].replace(TRAILING_PROSE_RE, "");
    if (!path || !isRenderablePath(path)) continue;
    if (index > at) out.push({ kind: "text", text: text.slice(at, index) });
    const name = path.slice(path.lastIndexOf("/") + 1);
    out.push({ kind: "file", path, name, fileKind: attachmentKind(name) });
    at = index + path.length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

// ---- inline attachment tokens -------------------------------------------
//
// An attached file is written into the message AS a token — `[img]`,
// `[img: chart.png]`, `[file: report.pdf]` — standing exactly where the paste,
// the drop or the picker put it, and swapped for the absolute path at send
// time (logic/compose.logic.ts `composeMessage`). It replaces the tray that sat
// above the field and put every path at the FRONT of the message, which is what
// Viktor asked for on 2026-09-13: the file belongs where he wrote it.
//
// A textarea can only hold characters, so the token has to BE readable text:
// the chip look is painted behind it by a mirror layer the composer draws
// (PromptField, `.tl-composer-mirror`), and the text alone is what survives if
// that layer is ever wrong. No emoji, for the reason Icons.tsx gives — an
// emoji-default codepoint renders in colour and at its own size on every OS.

/** Everything the token machinery needs to know about one attachment. */
export interface TokenizedAttachment {
  /** stored basename, which decides the label. */
  name: string;
  kind: AttachmentKind;
  /** the token standing for it in the message, once it has one. */
  token?: string;
}

/**
 * Every token SHAPE, for finding ones no attachment owns any more.
 *
 * Deliberately narrow: the two heads, an optional ` 2` disambiguator and an
 * optional `: label`. A markdown link whose text is exactly `img` or `file`
 * would match, which costs that link its brackets in a restored draft and
 * nothing else — the price of a pattern loose enough to catch the labels people
 * actually attach.
 */
const TOKEN_RE = /\[(?:img|file)(?:\s\d+)?(?::\s[^\][\n]{1,80})? *\]/g;

/**
 * The character an image token is padded with, so the thumbnail painted over it
 * has the width to be a picture rather than a smear.
 *
 * A FIGURE SPACE (U+2007) rather than a plain one because it is non-breaking:
 * a wrapped line can never split a token and leave half a thumbnail on each
 * side of the break. It sits INSIDE the brackets, so it is part of the token
 * the send swaps out and never reaches the message as stray whitespace.
 */
export const PAD = " ";

/** `file-<stamp>-<token>-` is stripped by storedDisplayName; these two prefixes
 *  are the store's own names for a pasted image and a `show-image` render, and
 *  carry nothing a reader wants in their message. */
const UNNAMED_RE = /^(?:pasted|displayed)-/;
/** What Chrome calls a clipboard image, which is no more informative. */
const GENERIC_RE = /^image\.\w+$/i;

/** The longest label a token carries before it is cut short. */
const LABEL_MAX = 22;

/** The part of a token that names the file, or null when the name says nothing
 *  the writer did not already know (a pasted screenshot). */
function tokenLabel(name: string): string | null {
  const shown = storedDisplayName(name);
  if (!shown || UNNAMED_RE.test(shown) || GENERIC_RE.test(shown)) return null;
  return shown.length > LABEL_MAX ? shown.slice(0, LABEL_MAX - 1) + "…" : shown;
}

/**
 * The token for one attachment, unique among the ones already in the message.
 *
 * Uniqueness is what makes the swap at send time unambiguous, so a second
 * screenshot is `[img 2]` rather than a duplicate of the first.
 *
 * `pad` is how many figure spaces to carry before the closing bracket. An image
 * is drawn as the picture itself, painted over the token's own characters, so
 * the token has to be at least as wide as the picture — the composer measures
 * that in the font the field is actually using and asks for the count here
 * (PromptField, `padFor`). Zero, the default, is a token to be read.
 */
export function attachToken(
  name: string,
  kind: AttachmentKind,
  taken: ReadonlySet<string>,
  pad = 0,
): string {
  const head = kind === "image" ? "img" : "file";
  const label = tokenLabel(name);
  const body = (n: number): string =>
    `[${head}${n > 1 ? ` ${n}` : ""}${label ? `: ${label}` : ""}${PAD.repeat(pad)}]`;
  let n = 1;
  while (taken.has(body(n))) n += 1;
  return body(n);
}

/**
 * Cut `[start, end)` out of the text, taking one separating space with it, and
 * say where the caret should land. Removing a chip from the middle of a
 * sentence must not leave a double space behind.
 */
export function cutSpan(text: string, start: number, end: number): { text: string; at: number } {
  let from = start;
  let to = end;
  if (text[to] === " ") to += 1;
  else if (from > 0 && text[from - 1] === " ") from -= 1;
  return { text: text.slice(0, from) + text.slice(to), at: from };
}

/** Remove a token from the text, wherever it stands. A token that is not there
 *  leaves the text alone. */
export function dropToken(text: string, token: string): string {
  const at = text.indexOf(token);
  return at < 0 ? text : cutSpan(text, at, at + token.length).text;
}

/**
 * Make a restored message and its attachments agree about what is in it.
 *
 * Two things can be out of step by the time a draft is read back:
 *   - a token whose attachment is gone (the new-session composer holds FILES,
 *     which cannot be persisted, so its tokens outlive them) is cut out;
 *   - an attachment with no token — a draft written before attachments were
 *     anchored — is given one at the end of the message rather than dropped.
 *
 * A chip the writer deleted needs nothing here: the field drops that
 * attachment at the keystroke, so it is never saved in the first place.
 */
export function anchorRestored<T extends TokenizedAttachment>(
  text: string,
  items: readonly T[],
): { text: string; items: T[] } {
  const kept: T[] = [];
  const taken = new Set<string>();
  for (const item of items) {
    if (!item.token || taken.has(item.token) || !text.includes(item.token)) continue;
    taken.add(item.token);
    kept.push(item);
  }

  let out = text;
  const orphans = [...out.matchAll(TOKEN_RE)].filter((m) => !taken.has(m[0]));
  // Backwards, so an earlier cut cannot move a later match's index.
  for (let i = orphans.length - 1; i >= 0; i--) {
    const m = orphans[i]!;
    out = cutSpan(out, m.index, m.index + m[0].length).text;
  }

  for (const item of items) {
    if (kept.includes(item)) continue;
    const token = attachToken(item.name, item.kind, taken);
    taken.add(token);
    out = out.trimEnd() ? `${out.trimEnd()} ${token}` : token;
    kept.push({ ...item, token });
  }
  return { text: out, items: kept };
}
