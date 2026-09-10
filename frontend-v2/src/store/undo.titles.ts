/**
 * The inverse of a RETITLE: the title a person typed onto a card, and the
 * clear that hands the session back to its bare name.
 *
 * THIS ONE IS NOT EXACTLY REVERSIBLE, and the code has to admit it. Since
 * ADR-0022 the tmux NAME follows the title: tmux-api re-derives it on every
 * title that lands (tmux-api/session_mutate.go:183 → name_from_title.go
 * `derivedNameFor`) and hands a collision the next free `-N`, so putting the
 * old title back can land the session under a name it never had. The TITLE is
 * what this entry promises; the name is the server's to decide, and nothing
 * here assumes the old one came back.
 *
 * WHICH SESSION, THOUGH. The name is the last thing to trust, since it is the
 * thing that moves. Three links, in the order `resolve` tries them:
 *
 *   1. tmux's own session id (`Session.id`, types/lobby.ts:41), the one field a
 *      rename does not change. Recorded whenever the server supplies one.
 *   2. the name the entry carries, for a server that supplies no id. It is
 *      kept current by the stack's `carry`, which store/lobby.ts calls for
 *      every rename a poll reveals (carryRenamedRecords).
 *   3. the birth name (`Session.bornAs`), which is the link when the id cannot
 *      help: a fresh session is renamed as soon as its first title lands, and
 *      the session list is behind a 5-second cache, so the tab that created it
 *      routinely never saw it under the id it minted.
 *
 * The cascade is safe because of the PRECONDITION rather than in spite of it.
 * `check` reads the resolved session's title and refuses unless it is still one
 * end of this switch, so a stranger that has taken the old name is turned away
 * by its title rather than retitled.
 *
 * Refusal messages are sentences a person reads after a lead-in, so they start
 * lower case and name what changed.
 */
import type { Session } from "../types/lobby";
import {
  registerUndoHandler,
  type UndoEntryBase,
  type UndoHandler,
  type UndoHandlers,
} from "./undo";

/**
 * A title set, changed, or cleared.
 *
 * The session NAME lives in `session` rather than in a field of its own
 * because that is one of the two places {@link UndoEntryBase} can rewrite when
 * a rename lands under an entry. A `name` field would go stale the first time
 * a title landed, which for this kind is the very thing it records.
 */
export interface TitleEntry extends UndoEntryBase {
  readonly kind: "title";
  /** The name the session had when the entry was pushed, kept current by
   *  `carry`. Only ever a way to FIND the session, never an instruction. */
  readonly session: string;
  /** tmux's session id, when the server supplied one. */
  readonly id?: string;
  /** The title before the retitle. "" is a real instruction: it is the state
   *  every session that predates titles sits in, and clearing the box is how a
   *  person asks for the bare name back (store/lobby.ts clearTitle). */
  readonly before: string;
  /** What the retitle set, cleaned as the server stores it (lib/title.ts). */
  readonly after: string;
}

/** What a title inverse needs from the store that owns the action. */
export interface TitleUndoPorts {
  /** Every session this tab knows about, own and foreign (mergedSessions). */
  sessions(): readonly Session[];
  /** This tab's OS user, so a foreign row is never retitled on its owner's
   *  behalf. A foreign id comes from another user's tmux server, where the
   *  same `$41` names an unrelated session (store/lobby.ts renamesBetween). */
  me(): string;
  /**
   * Stamp a title (or clear it with ""), wait for the refresh that brings the
   * derived name back, and answer whether it landed.
   *
   * store/lobby.ts `applyTitle`, deliberately NOT its `rename`: rename records
   * an entry of its own, so an undo that went through it would push onto the
   * stack and wipe the redo half the press is about to fill.
   */
  setTitle(name: string, title: string): Promise<boolean>;
}

const SESSION_GONE = "that session is gone";
const TITLE_MOVED = "that session has been retitled since";
const WRITE_FAILED = "the title did not go through";

/** What a session is called to the person reading it. Absent means no title,
 *  which is exactly what an empty `before` asks for. */
const titleOf = (s: Session): string => s.title ?? "";

function resolve(ports: TitleUndoPorts, entry: TitleEntry): Session | null {
  const me = ports.me();
  const mine = ports.sessions().filter((s) => !s.owner || s.owner === me);
  const byId = entry.id ? mine.find((s) => s.id === entry.id) : undefined;
  return (
    byId ??
    mine.find((s) => s.name === entry.session) ??
    mine.find((s) => s.bornAs === entry.session) ??
    null
  );
}

function titleHandler(ports: TitleUndoPorts): UndoHandler<TitleEntry> {
  /** The session, or a refusal: every direction needs it and none may guess. */
  function must(entry: TitleEntry): Session {
    const s = resolve(ports, entry);
    if (!s) throw new Error(SESSION_GONE);
    return s;
  }

  return {
    check(entry) {
      const s = resolve(ports, entry);
      if (!s) return SESSION_GONE;
      // BOTH ends pass, because `check` cannot see which way it is about to
      // run (store/undo.ts UndoHandler): still carrying what the retitle set
      // means the undo is the next thing to happen to it, and carrying what it
      // replaced means the undo already ran and a redo is pending. Anything
      // else is a title somebody typed since, and dragging that back is not an
      // undo of anything the person asked for.
      const now = titleOf(s);
      return now === entry.after || now === entry.before ? null : TITLE_MOVED;
    },
    async undo(entry) {
      // Read the name off the live session rather than out of the entry: the
      // retitle this undoes is what moved it in the first place.
      if (!(await ports.setTitle(must(entry).name, entry.before))) {
        // The store has already toasted what went wrong; this sentence is what
        // the undo caller reports about the press itself.
        throw new Error(WRITE_FAILED);
      }
    },
    async redo(entry) {
      if (!(await ports.setTitle(must(entry).name, entry.after))) {
        throw new Error(WRITE_FAILED);
      }
    },
  };
}

/** The title inverse, keyed by kind. A Map so a test can hand its own registry
 *  to createUndoStore and stay isolated from the module-wide one. */
export function titleUndoHandlers(ports: TitleUndoPorts): UndoHandlers {
  return new Map<string, UndoHandler>([["title", titleHandler(ports)]]);
}

/** Teach the app-wide registry about it. Called from the store that owns the
 *  action, at wiring time (store/lobby.ts). */
export function registerTitleUndoHandlers(ports: TitleUndoPorts): void {
  for (const [kind, handler] of titleUndoHandlers(ports)) registerUndoHandler(kind, handler);
}
