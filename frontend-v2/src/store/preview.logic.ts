import type { Event } from "../types/events";

/**
 * Pure, DOM-free logic for the file-preview surface (roadmap pillar #6). Keeps
 * the two risky mappings — file-type -> renderer and transcript-event -> file
 * path — in a unit-tested module so the store + overlay stay thin. No fetch, no
 * Solid, no DOM here.
 */

/** Which renderer a file routes to. */
export type RendererKind = "markdown" | "html" | "image" | "code" | "binary";

/** The md/html raw|rendered toggle. Ignored by image/code/binary. */
export type PreviewMode = "rendered" | "raw";

/**
 * HTML preview sandbox. EMPTY string = the maximally-restrictive sandbox: no
 * scripts, no same-origin, no top-navigation, no forms — the iframe gets a
 * unique opaque origin. This is a HARD security requirement (pillar #6): user
 * HTML is rendered via srcdoc and must NEVER run against the authed lobby
 * origin. Do not add `allow-scripts` or `allow-same-origin` here.
 */
export const HTML_SANDBOX = "";

/** Guard used by tests + the component: a sandbox value that can't run user HTML
 *  against our origin. */
export function sandboxIsSafe(value: string): boolean {
  return !/allow-same-origin|allow-scripts/i.test(value);
}

/** Extension -> highlight.js language id. Absent = no highlight (plaintext). */
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  css: "css",
  scss: "css",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  dockerfile: "dockerfile",
  diff: "diff",
  patch: "diff",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
};

/** Text extensions that carry no highlight grammar but are still text we show. */
const PLAIN_TEXT_EXT = new Set([
  "txt",
  "log",
  "env",
  "csv",
  "tsv",
  "gitignore",
  "dockerignore",
  "npmrc",
  "editorconfig",
  "properties",
  "lock",
]);

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const HTML_EXT = new Set(["html", "htm"]);

/** Lower-cased final extension of a path, or "" (also handles bare Dockerfile). */
export function extOf(path: string): string {
  const base = basename(path).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // no ext, or a dotfile like ".env" (dot at 0)
  return base.slice(dot + 1);
}

/** Trailing path segment (works on POSIX + Windows separators). */
export function basename(path: string): string {
  const p = path.replace(/[/\\]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Parent directory of a POSIX path ("/a/b.txt" -> "/a", "/a" -> "/"). */
export function dirname(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return p.slice(0, i);
}

/** highlight.js language id for a path, or undefined (plaintext / unknown). */
export function languageForPath(path: string): string | undefined {
  return LANG_BY_EXT[extOf(path)];
}

function contentTypeKind(ct: string): RendererKind | null {
  const t = ct.toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (
    t.startsWith("text/") ||
    t.includes("json") ||
    t.includes("xml") ||
    t.includes("javascript") ||
    t.includes("ecmascript") ||
    t.includes("x-sh") ||
    t.includes("x-shellscript")
  ) {
    return "code";
  }
  // Everything else (application/octet-stream, application/pdf, fonts, …).
  return "binary";
}

/**
 * Route a file to a renderer. Extension decides first (fast, no fetch); an
 * optional response content-type resolves the unknown-extension case (so an
 * ext-less image or a real binary is classified correctly after the HEAD-less
 * GET peek). With neither a known extension nor a content-type we optimistically
 * assume text ("code"); the store re-classifies once the response headers land.
 */
export function classifyFile(
  name: string,
  contentType?: string,
): { kind: RendererKind; language?: string } {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return { kind: "image" };
  if (MARKDOWN_EXT.has(ext)) return { kind: "markdown" };
  if (HTML_EXT.has(ext)) return { kind: "html" };

  const lang = LANG_BY_EXT[ext];
  if (lang) return { kind: "code", language: lang };
  if (PLAIN_TEXT_EXT.has(ext)) return { kind: "code" };

  // Unknown extension: let the content-type decide when we have one.
  if (contentType) {
    const k = contentTypeKind(contentType);
    if (k === "image") return { kind: "image" };
    if (k === "binary") return { kind: "binary" };
    return { kind: "code" };
  }
  return { kind: "code" };
}

/** Tools whose input names a single file we can preview. */
const FILE_PATH_TOOLS = new Set([
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * Extract the file path a Read/Edit/Write-style tool call targets, or null.
 * `input` is the JSON-encoded tool input off the wire (timeline ToolRow.input).
 * Only absolute paths are accepted — the file-api rejects relative paths anyway,
 * and a bare filename in some other tool's args must never become a preview
 * link.
 */
export function parseToolPath(tool: string, input: string): string | null {
  if (!FILE_PATH_TOOLS.has(tool)) return null;
  if (!input) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(input);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const p =
    typeof rec.file_path === "string"
      ? rec.file_path
      : typeof rec.path === "string"
        ? rec.path
        : typeof rec.notebook_path === "string"
          ? rec.notebook_path
          : "";
  if (!p || !isAbsolutePath(p)) return null;
  return p;
}

/** POSIX or Windows-drive absolute path. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

export interface RecentFile {
  path: string;
  name: string;
  /** last tool that touched it, for a subtle hint (Read/Edit/Write). */
  tool: string;
}

/**
 * Recent files touched in a session's transcript, most-recent-first and
 * de-duplicated by path (the newest mention wins its position). Drives the
 * overlay's recent-files list. Pure over the event array.
 */
export function extractRecentFiles(events: Event[], limit = 12): RecentFile[] {
  const seen = new Set<string>();
  const out: RecentFile[] = [];
  // Walk newest-first so the first time we see a path is its latest mention.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "tool_use" || !e.tool || !e.body) continue;
    const path = parseToolPath(e.tool, e.body);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, name: basename(path), tool: e.tool });
    if (out.length >= limit) break;
  }
  return out;
}

/** raw <-> rendered toggle. */
export function nextMode(mode: PreviewMode): PreviewMode {
  return mode === "rendered" ? "raw" : "rendered";
}

/** Whether the raw|rendered toggle applies to this renderer kind. */
export function modeApplies(kind: RendererKind): boolean {
  return kind === "markdown" || kind === "html";
}
