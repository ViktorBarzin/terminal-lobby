import { parseStorePath, segmentMessage } from "../lib/attachments";
import { lsGet, lsSet } from "../lib/storage";

/**
 * The messages with a picture this device sent, per session, so ↑ can bring
 * the picture back (lib/attachments.ts, withSentPictures).
 *
 *   tl:sent-pictures:v1   session → [message, …], oldest first
 *
 * The transcript records a picture Claude Code attached as `[Image #N]`, which
 * names nothing the composer can attach again. The message as sent still
 * names the store file. Per-browser and a convenience only: without it, ↑
 * gives back what the transcript has, as before.
 */
export const SENT_PICTURES_KEY = "tl:sent-pictures:v1";

/** Kept per session; older ones go first. */
const PER_SESSION = 20;
/** Sessions kept; the ones written longest ago go first. */
const SESSIONS = 40;

function readAll(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(lsGet(SENT_PICTURES_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) out[k] = v.filter((s): s is string => typeof s === "string");
    }
    return out;
  } catch {
    return {}; // private mode / corrupt entry
  }
}

/** Whether a message names a picture in the store. */
function carriesPicture(text: string): boolean {
  return segmentMessage(text).some(
    (s) => s.kind === "file" && s.fileKind === "image" && parseStorePath(s.path) !== null,
  );
}

/** The session's remembered messages, oldest first. */
export function sentPictures(session: string): string[] {
  return readAll()[session] ?? [];
}

/** Remember a message sent from here, when it carries a picture. */
export function rememberSent(session: string, text: string): void {
  if (!carriesPicture(text)) return;
  const doc = readAll();
  const list = [...(doc[session] ?? []).filter((s) => s !== text), text].slice(-PER_SESSION);
  delete doc[session];
  doc[session] = list;
  const names = Object.keys(doc);
  for (const name of names.slice(0, Math.max(0, names.length - SESSIONS))) delete doc[name];
  // A refused write means ↑ gives back the transcript's text, as before.
  lsSet(SENT_PICTURES_KEY, JSON.stringify(doc));
}
