import { uploadBlob, uploadField } from "./upload";
import { attachmentKind } from "../lib/attachments";
import type { DraftAttachment } from "../store/drafts";

/**
 * Put files into a session's attachment store and hand back the tray chips.
 *
 * Shared because two composers do it at different moments. The live composer
 * uploads when a file is picked, which it can because its session already
 * exists. The new-session composer cannot: the session a file belongs to is not
 * created until Enter is pressed, and writing into a bucket for a session that
 * may never exist would leave litter behind every abandoned draft. So it HOLDS
 * the files and calls this after the create, which is the first moment both
 * halves are known.
 *
 * Three outcomes, and the caller is told about all of them:
 *   - stored — the bytes are in the per-(user, session) store, readable back by
 *     the web surface, so the tray gets a chip and the prompt gets its path;
 *   - transferred — over clipboard-upload's store cap, so it stays an ephemeral
 *     /tmp file. No chip, because nothing can draw it, and the path is handed
 *     over instead: a message that looks attached and is not would be worse;
 *   - failed — reported by name, and the rest of the batch still goes.
 *
 * Distinct from clipboard/attach.ts, which is the document-level paste and drop
 * glue. This is only the upload, called by both.
 */
export interface AttachFilesOptions {
  /** How to tell the person what happened. Absent means silently. */
  notify?: (message: string, kind: "error" | "info") => void;
  /** injectable for tests; defaults to window.fetch. */
  fetchImpl?: typeof fetch;
}

export async function uploadAttachments(
  files: readonly File[],
  session: string,
  opts: AttachFilesOptions = {},
): Promise<DraftAttachment[]> {
  const added: DraftAttachment[] = [];
  const transferred: string[] = [];
  for (const file of files) {
    try {
      const up = await uploadBlob(file, {
        session,
        field: uploadField(file.type),
        filename: file.name,
        fetchImpl: opts.fetchImpl,
      });
      const name = up.path.slice(up.path.lastIndexOf("/") + 1);
      if (!up.stored) {
        transferred.push(up.path);
        continue;
      }
      added.push({ path: up.path, name, kind: attachmentKind(name) });
    } catch (err) {
      opts.notify?.(
        `Couldn't attach ${file.name}: ${err instanceof Error ? err.message : "upload failed"}`,
        "error",
      );
    }
  }
  if (transferred.length) {
    opts.notify?.(
      `Too large to attach (${transferred.length} file${transferred.length > 1 ? "s" : ""}) — ` +
        `the path is available but will not render: ${transferred.join(" ")}`,
      "info",
    );
  }
  // Chromium cannot decode HEIF, which clipboard-upload deliberately accepts,
  // and Claude Code's Read does not take it either — so an iPhone-native photo
  // is worth flagging at the moment it is attached rather than when the answer
  // comes back confused.
  if (added.some((a) => /\.hei[cf]$/i.test(a.name))) {
    opts.notify?.("HEIC images may not display or be readable — a JPEG is safer", "info");
  }
  return added;
}
