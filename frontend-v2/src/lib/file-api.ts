/**
 * file-api client (roadmap pillar #6). Per-user file read/list backend on the
 * devvm (:7686), same-origin behind the ingress which injects
 * X-Authentik-Username. Shapes mirror file-api/*.go. Read maps HTTP status to a
 * FileApiError so the store can render 404 / 413 / 400 distinctly, and peeks the
 * response content-type to route ext-less images / true binaries WITHOUT
 * downloading their bodies.
 */
import { fileListUrl, fileReadUrl } from "./config";
import {
  classifyFile,
  type RendererKind,
} from "../store/preview.logic";

export class FileApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
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

/** Human message for an HTTP status from /files/read. */
export function readErrorMessage(status: number): string {
  switch (status) {
    case 404:
      return "File not found.";
    case 413:
      return "File is too large to preview (max 10MB).";
    case 400:
      return "Can't preview this path (not a regular file).";
    case 401:
    case 403:
      return "Not authorized to read this file.";
    default:
      return `Couldn't load file (HTTP ${status}).`;
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
    // Drain so the connection can be reused.
    await resp.body?.cancel().catch(() => {});
    throw new FileApiError(resp.status, readErrorMessage(resp.status));
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
    size: text.length,
    contentType,
  };
}

/** GET /files/list?dir= — directory entries (dirs first, then name). Throws
 *  FileApiError on a non-OK response. */
export async function listDir(dir: string, all = false): Promise<FileEntry[]> {
  const resp = await fetch(fileListUrl(dir, all), { credentials: "same-origin" });
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new FileApiError(resp.status, readErrorMessage(resp.status));
  }
  const data = (await resp.json()) as unknown;
  return Array.isArray(data) ? (data as FileEntry[]) : [];
}
