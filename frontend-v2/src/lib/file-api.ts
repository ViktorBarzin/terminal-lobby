/**
 * file-api client (roadmap pillar #6). Per-user file read/list backend on the
 * devvm (:7686), same-origin behind the ingress which injects
 * X-Authentik-Username. Shapes mirror file-api/*.go. Read maps HTTP status to a
 * FileApiError so the store can render 404 / 413 / 400 distinctly, and peeks the
 * response content-type to route ext-less images / true binaries WITHOUT
 * downloading their bodies.
 */
import { fileListUrl, fileReadUrl, fileWriteUrl } from "./config";
import {
  byteLength,
  classifyFile,
  type RendererKind,
} from "../store/preview.logic";

export class FileApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** the 400 was "path is a directory" — the ONE refusal whose message names
     *  itself, and the one the preview store acts on (it points Browse at that
     *  path instead of at its parent, so "press Browse to list what's inside
     *  it" is true rather than one click short). False for every other error. */
    public readonly isDirectory = false,
  ) {
    super(message);
    this.name = "FileApiError";
  }
}

/** One row of GET /files/list — mirrors file-api's fileEntry. */
export interface FileEntry {
  name: string;
  path: string;
  size: number;
  mtime: number;
  isDir: boolean;
}

/** A resolved file ready to render. `text` is set for markdown/html/code;
 *  `size` for binary (and text when known). Image bytes are never fetched here —
 *  the component points an <img> at fileReadUrl(path). */
export interface LoadedFile {
  kind: RendererKind;
  language?: string;
  text?: string;
  size?: number;
  contentType?: string;
}

/**
 * The one 400 body from GET /files/read that is safe to repeat back. file-api
 * emits it (files.go) only AFTER the path has already resolved inside the home
 * containment root, and GET /files/list will list that same directory one click
 * away — so naming it discloses nothing Browse doesn't already.
 */
const DIRECTORY_400_BODY = "path is a directory";

/**
 * Human message for an HTTP status from GET /files/read. `body` is the server's
 * plain-text response body when one was read (readFile passes it for 400 only).
 *
 * file-api answers 400 to FOUR different read refusals — "invalid path"
 * (resolves outside the home containment root), "path must be absolute", "path
 * is a directory" and "not a regular file". Three of them stay behind one vague
 * sentence on purpose (files.go pathHTTPError: the message must not let a probe
 * tell "outside home" from "does not exist"), and the sentence has to cover them
 * without claiming any one; the old wording asserted the file-type case, so
 * /etc/passwd and a ../../etc/shadow traversal both read as complaints about the
 * file's type rather than about being out of reach.
 *
 * "path is a directory" is the exception, and it is the common typo: the vague
 * sentence told the user their own in-home directory was out of reach while the
 * Browse button beside the path box listed it happily — two opposite answers for
 * one path. Naming it costs no secrecy (see DIRECTORY_400_BODY) and points at
 * the control that does work.
 */
export function readErrorMessage(status: number, body = ""): string {
  switch (status) {
    case 404:
      return "File not found.";
    case 413:
      return "File is too large to preview (max 10MB).";
    case 400:
      return body.trim() === DIRECTORY_400_BODY
        ? "That path is a folder — press Browse to list what's inside it."
        : "Can't open this path — it's outside your home folder, or not a readable file.";
    case 401:
    case 403:
      return "Not authorized to read this file.";
    default:
      return `Couldn't load file (HTTP ${status}).`;
  }
}

/**
 * What a failed <img> says when the server is not the reason — the bytes came
 * back fine and the DECODE failed (corrupt or unsupported image), or the probe
 * below could not run at all.
 */
export const IMAGE_DECODE_MESSAGE = "Couldn't load image.";

/**
 * Why did an <img> fail? readFile() classifies images by NAME and returns
 * WITHOUT a fetch — the <img> element does the only round-trip — so the
 * 404/413/400 vocabulary above never reached an image: a missing PNG, a 12MB
 * PNG and a PNG outside the home root all read "Couldn't load image.", as if
 * the file were damaged. The 413 is the one that costs the reader something:
 * a readable file over the preview limit, with an actionable workaround,
 * described as corruption.
 *
 * This resolves the real status on the ERROR path only, so the happy path
 * keeps its single request: one GET whose body is cancelled unread (the 400
 * body is read, as in readFile, because it is the only one that distinguishes
 * anything). A 2xx here means the server was happy and the decode was not —
 * the one case IMAGE_DECODE_MESSAGE actually describes.
 */
export async function imageErrorMessage(path: string): Promise<string> {
  try {
    const resp = await fetch(fileReadUrl(path), { credentials: "same-origin" });
    if (resp.ok) {
      await resp.body?.cancel().catch(() => {});
      return IMAGE_DECODE_MESSAGE;
    }
    let body = "";
    if (resp.status === 400) body = await resp.text().catch(() => "");
    else await resp.body?.cancel().catch(() => {});
    return readErrorMessage(resp.status, body);
  } catch {
    return IMAGE_DECODE_MESSAGE; // offline / aborted — no status to report
  }
}

/**
 * Human message for an HTTP status from GET /files/list. A LISTING fails for
 * directory-shaped reasons — "not a directory", outside the home containment
 * root, or not absolute — so it needs its own vocabulary. Reusing the read
 * table told the user their directory was "not a regular file".
 */
export function listErrorMessage(status: number): string {
  switch (status) {
    case 404:
      return "Folder not found.";
    case 400:
      return "Can't list this folder — it's outside your home folder, or not a directory.";
    case 401:
    case 403:
      return "Not authorized to list this folder.";
    default:
      return `Couldn't load folder (HTTP ${status}).`;
  }
}

/**
 * Read + classify one file. Extension routes first; for an unknown extension the
 * response content-type resolves image-vs-binary-vs-text. Binary/image bodies
 * are cancelled unread. Throws FileApiError(status) on a non-OK response.
 */
export async function readFile(path: string, name = path): Promise<LoadedFile> {
  // A name-classified image needs no fetch here — the <img> loads it by URL, so
  // we avoid a redundant round-trip. A broken path surfaces via <img> onerror.
  const byName = classifyFile(name);
  if (byName.kind === "image") return { kind: "image" };

  const resp = await fetch(fileReadUrl(path), { credentials: "same-origin" });
  if (!resp.ok) {
    // 400 is the only status whose body distinguishes anything worth saying (a
    // directory, vs the three refusals that stay deliberately vague), so it is
    // the only one we read. Every other body is drained unread so the
    // connection can be reused.
    let body = "";
    if (resp.status === 400) body = await resp.text().catch(() => "");
    else await resp.body?.cancel().catch(() => {});
    throw new FileApiError(
      resp.status,
      readErrorMessage(resp.status, body),
      resp.status === 400 && body.trim() === DIRECTORY_400_BODY,
    );
  }
  const contentType = resp.headers.get("content-type") ?? "";
  const k = classifyFile(name, contentType);

  if (k.kind === "image") {
    await resp.body?.cancel().catch(() => {});
    return { kind: "image", contentType };
  }
  if (k.kind === "binary") {
    const len = Number(resp.headers.get("content-length"));
    await resp.body?.cancel().catch(() => {});
    return {
      kind: "binary",
      contentType,
      ...(Number.isFinite(len) && len > 0 ? { size: len } : {}),
    };
  }

  const text = await resp.text();
  return {
    kind: k.kind,
    ...(k.language ? { language: k.language } : {}),
    text,
    // BYTES, not characters — `text.length` is UTF-16 code units and
    // under-reports every non-ASCII file. Counted from the decoded text rather
    // than Content-Length so it survives chunked/compressed transfer.
    size: byteLength(text),
    contentType,
  };
}

/** GET /files/list?dir= — directory entries (dirs first, then name). Throws
 *  FileApiError on a non-OK response. */
export async function listDir(dir: string, all = false): Promise<FileEntry[]> {
  const resp = await fetch(fileListUrl(dir, all), { credentials: "same-origin" });
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new FileApiError(resp.status, listErrorMessage(resp.status));
  }
  const data = (await resp.json()) as unknown;
  return Array.isArray(data) ? (data as FileEntry[]) : [];
}

/** Human message for an HTTP status from POST /files/write. */
export function writeErrorMessage(status: number): string {
  switch (status) {
    case 413:
      return "File is too large to save (max 10MB).";
    case 404:
      return "Can't save — the parent folder doesn't exist.";
    case 400:
      return "Can't save this path (not a regular file).";
    case 401:
    case 403:
      return "Not authorized to save this file.";
    default:
      return `Couldn't save file (HTTP ${status}).`;
  }
}

/**
 * Write `content` to `path` via POST /files/write (roadmap pillar #6 editor).
 * Same-origin credentials (the ingress injects X-Authentik-Username). Resolves
 * on the server's 204 (any 2xx); throws FileApiError(status) otherwise so the
 * store can surface 413 (too large) / 403 (denied) / 404 (no parent dir)
 * distinctly. The body is drained on failure so the connection can be reused.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  const resp = await fetch(fileWriteUrl(), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  if (resp.ok) {
    await resp.body?.cancel().catch(() => {});
    return;
  }
  await resp.body?.cancel().catch(() => {});
  throw new FileApiError(resp.status, writeErrorMessage(resp.status));
}
