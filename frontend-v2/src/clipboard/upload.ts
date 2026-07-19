import { clipboardUrl } from "../lib/config";

/**
 * Clipboard-upload client (feature-inventory Cat.8 "Drag-and-drop file upload"
 * + Cat.4 "Paste path"). Posts blobs to /clipboard/upload and returns the
 * server path the caller types into the pty. The field-routing decision is a
 * pure function so the drop path's image-vs-file split is unit-tested.
 */

/**
 * Which multipart field a transferred file uses. Images persist into the
 * per-(user, session) gallery store via the `image` field (must be image/*),
 * so they show up in the gallery; everything else rides the `file` field as an
 * ephemeral /tmp transfer (kept out of the gallery). Pure — the drop router's
 * decision point.
 */
export function uploadField(mime: string | null | undefined): "image" | "file" {
  return typeof mime === "string" && mime.startsWith("image/")
    ? "image"
    : "file";
}

export interface UploadOptions {
  session: string;
  field: "image" | "file";
  /** original filename; the `file` field keeps it (sanitized), `image` ignores it. */
  filename?: string;
  /** injectable for tests; defaults to window.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POST one blob to /clipboard/upload and return the stored path. Throws on a
 * non-2xx response (message = the server's body, or `HTTP <status>`) so callers
 * can surface the failure as a toast — mirroring the vanilla upload flow.
 */
export async function uploadBlob(
  blob: Blob,
  opts: UploadOptions,
): Promise<string> {
  const fd = new FormData();
  if (opts.filename) fd.append(opts.field, blob, opts.filename);
  else fd.append(opts.field, blob);
  fd.append("session", opts.session);

  const doFetch = opts.fetchImpl ?? fetch;
  const resp = await doFetch(clipboardUrl("/upload"), {
    method: "POST",
    body: fd,
    credentials: "same-origin",
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { path?: unknown };
  if (typeof data.path !== "string" || !data.path) {
    throw new Error("upload response missing path");
  }
  return data.path;
}
