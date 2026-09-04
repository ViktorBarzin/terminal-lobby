/**
 * The first line of the prompt a session was created with, per browser.
 *
 *   tl:session-prompt-line:v1   session id → {text, at}
 *
 * A session's name is an opaque id (ADR-0019) and its title arrives from
 * Claude's own summary a few seconds after the first prompt
 * (tmux-api/autotitle.go). This covers the gap: the card shows what the person
 * typed until the summary replaces it.
 *
 * Deliberately NOT stamped as the session's @title. The auto-title rule only
 * fires while @title is unset, so writing the prompt line there would stop the
 * summary from ever landing — the placeholder would become permanent.
 *
 * Per-browser and never roamed, like store/drafts.ts and store/visits.ts: the
 * record covers seconds in the tab that did the creating, and the summary that
 * replaces it reaches every other device on its own. A session that never gets
 * a summary (a plain shell, a Claude that crashed at launch, a box with
 * CLAUDE_CODE_DISABLE_TERMINAL_TITLE set) keeps showing its prompt line here
 * and reads `New session` elsewhere, which is what an untitled session has
 * always read.
 */

export const PROMPT_LINES_KEY = "tl:session-prompt-line:v1";

interface PromptLine {
  text: string;
  /** epoch ms, for a future staleness rule and for debugging a leaked key. */
  at: number;
}

/** The whole document, or {} for absent/corrupt/foreign-shaped storage. */
function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PROMPT_LINES_KEY) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {}; // private mode / corrupt entry
  }
}

function writeAll(doc: Record<string, unknown>): void {
  try {
    localStorage.setItem(PROMPT_LINES_KEY, JSON.stringify(doc));
  } catch {
    /* private mode / quota — the card simply shows `New session` instead */
  }
}

/** The remembered line for one session, or null. */
export function promptLineFor(session: string): string | null {
  const rec = readAll()[session];
  if (!rec || typeof rec !== "object") return null;
  const { text } = rec as Record<string, unknown>;
  return typeof text === "string" && text.length > 0 ? text : null;
}

/** Record what a session was created with. An empty line records nothing. */
export function rememberPromptLine(session: string, text: string): void {
  if (!text) return;
  const doc = readAll();
  const rec: PromptLine = { text, at: Date.now() };
  doc[session] = rec;
  writeAll(doc);
}

/** Drop one — the summary landed, or the title was set by hand. */
export function forgetPromptLine(session: string): void {
  const doc = readAll();
  if (!(session in doc)) return;
  delete doc[session];
  writeAll(doc);
}

/**
 * How long a line is kept regardless of the live list.
 *
 * A session does not exist server-side until the terminal iframe attaches and
 * ttyd runs `tmux new-session -A`, and GET /sessions answers from a 5-second
 * cache, so for the first seconds of a create every poll reports a list without
 * it. The store passes its optimistic pending names in as live, which covers
 * the ordinary path; this covers the one where it cannot — a layout write that
 * failed drops the pending card, and the session the attach is still bringing
 * into being would have its line pruned before it ever appeared.
 *
 * Two minutes, matching tmux-api's auto-title window: past it, either the
 * summary has landed and the line has been forgotten, or the session was never
 * created at all.
 */
export const PROMPT_LINE_GRACE_MS = 2 * 60 * 1000;

/** When a record was written, or 0 for a record that does not say. */
function writtenAt(rec: unknown): number {
  if (!rec || typeof rec !== "object") return 0;
  const { at } = rec as Record<string, unknown>;
  return typeof at === "number" ? at : 0;
}

/**
 * Drop lines for sessions that no longer exist.
 *
 * An EMPTY live list is treated as "no information", not "everything died" — a
 * poll in flight or a briefly unreachable tmux would otherwise wipe the device.
 * Same guard shape store/drafts.ts and store/visits.ts need, for the same reason.
 *
 * A line younger than PROMPT_LINE_GRACE_MS is kept whether or not the list
 * names its session: for the first seconds of a create, no list does.
 */
export function prunePromptLines(live: readonly string[], now: number = Date.now()): void {
  if (live.length === 0) return;
  const doc = readAll();
  const keep = new Set(live);
  let changed = false;
  for (const session of Object.keys(doc)) {
    if (keep.has(session)) continue;
    if (now - writtenAt(doc[session]) < PROMPT_LINE_GRACE_MS) continue;
    delete doc[session];
    changed = true;
  }
  if (changed) writeAll(doc);
}
