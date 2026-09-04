import type { AttachmentKind } from "../lib/attachments";

/**
 * Composer drafts, per session, per browser
 * (docs/plans/2026-08-17-text-view-attachments-design.md, decision 10).
 *
 *   tl:session-drafts:v1   name → {text, attachments, at}
 *
 * Both halves of an unsent message persist: the typed text and the attachment
 * tray. A phone is the text view's default device and iOS evicts backgrounded
 * tabs, so losing a half-written message with a photo attached to it is exactly
 * the case this exists for.
 *
 * Per-browser and never roamed, like store/visits.ts and for the same reason —
 * an unsent draft belongs to the device it was typed on — and pruned to the live
 * session list the same way, so a killed session cannot leak an entry forever.
 *
 * Nothing here is ever load-bearing: the FILE an attachment names is already in
 * the store and listed in the 🖼 gallery, so a lost draft costs the reference,
 * never the upload.
 */

export const DRAFTS_KEY = "tl:session-drafts:v1";

/** One tray chip, as persisted. The path is what the send splices into the prompt. */
export interface DraftAttachment {
  /** absolute path on the devvm — the store path, or wherever it came from. */
  path: string;
  /** stored basename; the chip's label is derived from it. */
  name: string;
  kind: AttachmentKind;
}

export interface Draft {
  text: string;
  attachments: DraftAttachment[];
  /** epoch ms of the last write, for a future staleness rule. */
  at: number;
}

/** The whole document, or {} for absent/corrupt/foreign-shaped storage. */
function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {}; // private mode / corrupt entry
  }
}

function writeAll(doc: Record<string, unknown>): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(doc));
  } catch {
    /* private mode / quota — the draft simply does not stick */
  }
}

/**
 * Validate one persisted attachment. A relative path is rejected because a chip
 * that cannot be spliced into a prompt is worse than no chip: it would send text
 * Claude cannot resolve.
 */
function readAttachment(v: unknown): DraftAttachment | null {
  if (!v || typeof v !== "object") return null;
  const { path, name, kind } = v as Record<string, unknown>;
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  if (typeof name !== "string" || !name) return null;
  if (kind !== "image" && kind !== "doc") return null;
  return { path, name, kind };
}

/**
 * The saved draft for one session, or null. Anything malformed is dropped rather
 * than handed to the composer — a draft is restored into a live input, so a bad
 * record would surface as a broken field rather than an error.
 */
export function loadDraft(session: string): Draft | null {
  const rec = readAll()[session];
  if (!rec || typeof rec !== "object") return null;
  const { text, attachments, at } = rec as Record<string, unknown>;
  if (typeof text !== "string") return null;
  if (!Array.isArray(attachments)) return null;
  if (typeof at !== "number") return null;
  const clean = attachments.map(readAttachment).filter((a): a is DraftAttachment => a !== null);
  if (!text && clean.length === 0) return null;
  return { text, attachments: clean, at };
}

/** Persist one session's draft, or remove the entry when there is nothing left. */
export function saveDraft(session: string, draft: Draft): void {
  const doc = readAll();
  if (!draft.text && draft.attachments.length === 0) delete doc[session];
  else doc[session] = draft;
  writeAll(doc);
}

/**
 * The event a parked draft raises, so a field already on screen picks it up.
 *
 * `detail.session` is the draft key. PromptField restores a draft in onMount
 * and nowhere else — deliberately, so a restore cannot race the first keystroke
 * — which is right for every draft written by the field itself and wrong for
 * one written from OUTSIDE it while it is mounted.
 */
export const DRAFT_PARKED_EVENT = "tl:draft-parked";

/**
 * Park a message in a session's draft from outside its composer, and say so.
 *
 * The one caller is a first prompt that could not be delivered: by the time it
 * gives up, the new-session composer has been unmounted by the create's own
 * `select()`, and the field the person is looking at is the LIVE composer for
 * the session that was just made. Writing the draft alone would be invisible
 * there — that field mounted seconds earlier and has already read storage —
 * and worse than invisible: its persist effect writes `draft()` back on the
 * next keystroke, so one typed character would overwrite the parked message.
 */
export function parkDraft(session: string, draft: Draft): void {
  saveDraft(session, draft);
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(DRAFT_PARKED_EVENT, { detail: { session } }));
  } catch {
    /* no CustomEvent (an ancient engine) — the draft is still on disk */
  }
}

/** Forget one session's draft (it was sent, or deliberately cleared). */
export function clearDraft(session: string): void {
  const doc = readAll();
  if (!(session in doc)) return;
  delete doc[session];
  writeAll(doc);
}

/**
 * Drop drafts for sessions that no longer exist.
 *
 * An EMPTY live list is treated as "no information", not "everything died" — a
 * poll in flight or a briefly unreachable tmux would otherwise wipe every draft
 * on the device. Same guard shape store/visits.ts needs for the same reason.
 */
export function pruneDrafts(live: readonly string[]): void {
  if (live.length === 0) return;
  const doc = readAll();
  const keep = new Set(live);
  let changed = false;
  for (const name of Object.keys(doc)) {
    if (!keep.has(name)) {
      delete doc[name];
      changed = true;
    }
  }
  if (changed) writeAll(doc);
}
