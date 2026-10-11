/**
 * Who has a session open, what each of them is typing, and who sent each
 * prompt (ADR-0043). The wire shapes are session-events presence.go's.
 */

/** One open tab on the session, as the server reports it. */
export interface PresencePerson {
  id: string;
  /** The OS account. */
  user: string;
  /** The name the person goes by in the lobby. */
  name: string;
  /** "rw" drives, "ro" only watches. */
  mode: "rw" | "ro";
  draft?: string;
  /** When the draft last changed, on the server's clock (ms). */
  draftAt?: number;
}

/** One prompt sent from a composer, and by whom. `at` is the server's ms. */
export interface SenderRecord {
  text: string;
  at: number;
  user: string;
  name: string;
}

/** How long after the last keystroke a draft still reads as typing. */
const TYPING_MS = 4000;

/**
 * The other accounts present, one entry each, sorted by name. Your own tabs on
 * other devices are you, not company. When an account has several tabs, the
 * one holding a draft speaks for it.
 */
export function othersPresent(people: readonly PresencePerson[], me: string | undefined): PresencePerson[] {
  const byUser = new Map<string, PresencePerson>();
  for (const p of people) {
    if (p.user === me) continue;
    const seen = byUser.get(p.user);
    if (!seen || (!seen.draft && p.draft) || (seen.mode === "ro" && p.mode === "rw" && !seen.draft)) {
      byUser.set(p.user, p);
    }
  }
  return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The session bar's line: "emo here", "emo, bob (watching) here". */
export function presentLabel(others: readonly PresencePerson[]): string {
  if (others.length === 0) return "";
  const names = others.map((p) => (p.mode === "ro" ? `${p.name} (watching)` : p.name));
  const shown = names.length > 3 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(", ");
  return `${shown} here`;
}

/** Whether a person is typing now, has an unsent draft at rest, or neither.
 *  `now` is on the server's clock (the room frame's `now` plus elapsed). */
export function draftState(p: PresencePerson, now: number): "typing" | "resting" | "none" {
  if (!p.draft) return "none";
  return p.draftAt !== undefined && now - p.draftAt < TYPING_MS ? "typing" : "resting";
}

/** A user message, as much of it as attribution reads. `at` is in ms. */
export interface AttributableRow {
  key: string;
  body: string;
  at?: number;
}

/** How far apart a record and its message may be. A prompt held behind a long
 *  turn reaches the transcript when the turn ends, which can be many minutes. */
const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;

const norm = (s: string): string => s.trim();

/**
 * Which message each sender record belongs to, as row key → the sender's
 * name. Empty until someone other than the owner has sent, so a session
 * nobody shared reads as it always has.
 *
 * A record matches a message with the same words sent no more than
 * MATCH_WINDOW_MS before it (or a little after, for clock drift), and each
 * record labels one message, oldest first. A prompt typed into the terminal
 * has no record and stays unlabelled.
 */
export function attributeSenders(
  rows: readonly AttributableRow[],
  senders: readonly SenderRecord[],
  owner: string,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!senders.some((s) => s.user !== owner)) return out;
  const used = new Set<number>();
  for (const row of rows) {
    const body = norm(row.body);
    for (const [i, s] of senders.entries()) {
      if (used.has(i)) continue;
      if (norm(s.text) !== body) continue;
      if (row.at !== undefined && (s.at > row.at + 60_000 || row.at - s.at > MATCH_WINDOW_MS)) continue;
      used.add(i);
      out.set(row.key, s.name);
      break;
    }
  }
  return out;
}
