/**
 * The inverse of a KILL and of a CREATE, which are the same pair of operations
 * read in opposite directions: undoing a kill puts a session back, undoing a
 * create takes one away.
 *
 * A KILL IS NOT SENT STRAIGHT AWAY. `store.kill` marks the card and starts an
 * 8-second window (store/lobby.ts GRACE_MS); only when it elapses does the
 * DELETE go out. So this file has two undos for one kind, and which one runs is
 * decided by the live world rather than by the entry:
 *
 *   inside the window — cancel the timer, un-dim the card, hand back the
 *     selection the kill took. Nothing ever reached the server, so there is
 *     nothing to put back, and this is the only undo here that cannot fail.
 *   past it — the session is dead, and it comes back from the record the kill
 *     left: POST /restore with the snapshot tmux-api took before killing.
 *
 * WHAT A RESURRECTED SESSION IS, since it is not the one that died. A snapshot
 * row is three fields, the name, the cwd and the claude uuid
 * (tmux-persist:382), so the restore recreates ONE window with ONE pane in that
 * directory and runs `claude --resume <uuid>` in it (tmux-persist:664-669). The
 * CONVERSATION comes back in full, which is the part worth having. Nothing else
 * does: the process tree is gone, so claude starts cold and takes roughly
 * 550 MB to settle again; the scrollback above the prompt is gone; so is
 * anything typed and not sent; so is any process that was not claude; and so is
 * any second window or pane, since the format holds one of each.
 *
 * THE NAME SURVIVES, which is what lets every name-keyed store here go on
 * resolving: the restore recreates the session under the name it was killed
 * with (tmux-persist:672-676). tmux's own session_id does not — a restored
 * session gets a fresh $N — so nothing in this file may lean on it, which is
 * the rule the rest of the codebase already follows and explains at
 * tmux-api/sessionid.go:11-15.
 *
 * THE RECORD LIVES IN THE STORE, not on the entry, because an entry is
 * immutable JSON the moment it is pushed (store/undo.ts) and the record only
 * exists once the DELETE has answered. `ports.killRecord` is the store's answer
 * to "what does this page life hold that could bring that session back", and
 * `undefined` from it is a real state: a tab that reloaded mid-window fired its
 * kill from `pagehide` and kept nothing, so the entry that survived in
 * sessionStorage refuses rather than reporting a resurrection that did not
 * happen.
 *
 * BOTH INVERSES REACH BELOW THE ACTION. `ports.killNow` is the plain write
 * under `store.kill` — no window, no entry — because an inverse that called the
 * action would push onto the stack and wipe the redo half the press is about to
 * fill (store/undo.titles.ts says the same about rename).
 *
 * Refusal messages are sentences a person reads after a lead-in, so they start
 * lower case and name what changed rather than what the code found.
 */
import type { RestoreSelection } from "../types/lobby";
import { registerUndoHandler, type UndoEntryBase, type UndoHandler } from "./undo";

/**
 * A session killed from the ⋯ menu, a right swipe, the sidebar's Delete, the
 * kill chord or the palette — every one of them funnels through `store.kill`.
 *
 * The NAME lives in `session` rather than in a field of its own, because that
 * is one of the two places the stack can rewrite when a rename lands under an
 * entry (store/undo.ts UndoEntryBase) — and eight seconds is long enough for a
 * fresh session's first title to land, which since ADR-0022 moves its name.
 */
export interface KillEntry extends UndoEntryBase {
  readonly kind: "kill";
  readonly session: string;
  /** The group the document had it in ("" = ungrouped). */
  readonly group: string;
  /** Its raw index in that group's array; -1 when the document never named
   *  it, which is ordinary — a session the layout has not placed renders as a
   *  swept-in leftover (components/lobby.logic.ts deriveSidebar). */
  readonly index: number;
  /** It was the session on screen. Absent means it was not, which is why this
   *  is not a plain boolean: `undefined` round-trips through JSON as absence
   *  and reads the same either way. */
  readonly wasSelected?: boolean;
}

/**
 * A session created from the composer, the sidebar's `+` or the palette.
 *
 * Creation reaches no server at all — the browser mints a name, PUTs the layout
 * and the ttyd attach is what makes the tmux session (store/lobby.ts create) —
 * so the inverse is an ordinary kill, and the first thing tmux-api hears about
 * the session may well be the DELETE that undoes it.
 */
export interface CreateEntry extends UndoEntryBase {
  readonly kind: "create";
  readonly session: string;
  /** Where it was created ("" = ungrouped), so a redo files it back there. */
  readonly group: string;
}

/** What these inverses need from the store that owns the actions. */
export interface KillUndoPorts {
  /** Is a kill of this session still inside its grace window here? */
  pending(session: string): boolean;
  /** Drop that window: the timer goes, the card un-dims, and no DELETE is ever
   *  sent. false when there was nothing to drop. */
  cancelKill(session: string): boolean;
  /**
   * Kill NOW: the DELETE, the layout PUT, the local prune and the deselect,
   * with no window and no undo entry (store/lobby.ts killNow). false when the
   * DELETE did not go through, which the store has already toasted.
   *
   * The record it got back is kept in the store rather than returned, since the
   * caller that needs it is a later press asking `killRecord`.
   */
  killNow(session: string): Promise<boolean>;
  /**
   * Kill on the ordinary eight-second window, with no undo entry behind it
   * (store/lobby.ts armKill): the card dims, and the DELETE goes out only when
   * the window elapses. This is what a REDO uses, so the second kill costs
   * exactly what the first one did.
   *
   * false when a window was already open for that session, which is the world
   * the press wanted anyway rather than a failure.
   */
  killLater(session: string): boolean;
  /**
   * The DELETE that is out for this session right now, or undefined when
   * there is none (store/lobby.ts killNow).
   *
   * The THIRD state a kill passes through, and the only one the pair above
   * cannot describe: the grace timer has fired, so no window is pending, and
   * the session is still in the list, because the prune happens after the
   * request answers. A press landing there used to be told the session was
   * still running.
   */
  killInFlight(session: string): Promise<boolean> | undefined;
  /** What this page life holds that could bring that session back: the record
   *  its kill answered with, null when the server sent none, and undefined
   *  when this page never killed it (a reload, or somebody else's kill). */
  killRecord(session: string): RestoreSelection | null | undefined;
  /** POST /restore with that record and take the placement the server made
   *  (tmux-api/assignments.go places a restored session back in its project and
   *  re-stamps its title). Throws when the restore did not go through. */
  resurrect(record: RestoreSelection): Promise<void>;
  /** Is the session in the list right now? Own sessions only — a foreign row's
   *  name belongs to another account's tmux server. */
  isLive(session: string): boolean;
  /** Put a layout entry back at `index` of `group`, when nothing else did.
   *  A no-op when the document already names the session. */
  place(session: string, group: string, index: number): Promise<void>;
  /** Point the app at a session again, for a kill that took the open one. */
  select(session: string): void;
}

const SESSION_ALREADY_GONE = "that session is already gone";
const STILL_RUNNING = "that session is still running";
const KILL_FAILED = "the kill did not go through";
const RESTORE_FAILED = "that session could not be brought back";
const NO_RECORD = "there is nothing left to bring that session back from";

/** Where a session has to end up for either kind's put-it-back direction. */
interface Restorable {
  readonly session: string;
  readonly group: string;
  readonly index: number;
  readonly wasSelected?: boolean;
}

/**
 * Bring a killed session back, then tidy up after the server.
 *
 * The restore is the load-bearing half and the two steps after it are
 * gap-fillers: tmux-api files a restored session back into its project itself,
 * so `place` only writes when the document came back without it. A session the
 * restore had to rename — the name was taken, so it came back with a `-HHMM`
 * suffix (types/lobby.ts SnapshotRow) — is left alone by both, because this
 * entry's slot and this entry's selection are about the name that was killed.
 */
async function bringBack(
  ports: KillUndoPorts,
  entry: Restorable,
  record: RestoreSelection,
): Promise<void> {
  try {
    await ports.resurrect(record);
  } catch {
    // The api's own message names an HTTP status; this one is for a person.
    throw new Error(RESTORE_FAILED);
  }
  if (!ports.isLive(entry.session)) return;
  await ports.place(entry.session, entry.group, entry.index);
  if (entry.wasSelected) ports.select(entry.session);
}

/** Kill for real, refusing in the caller's words when the DELETE failed. */
async function killAgain(ports: KillUndoPorts, session: string): Promise<void> {
  if (!ports.isLive(session)) throw new Error(SESSION_ALREADY_GONE);
  if (!(await ports.killNow(session))) throw new Error(KILL_FAILED);
}

/**
 * Which of the three states this session is in, from the entry's point of view.
 * `check` and both directions all ask, and they must agree.
 *
 * A kill whose DELETE is in flight reads as "live" here, which is what `check`
 * wants — it must not refuse a press that is still in time — and `undo` looks
 * for that case itself before it trusts the answer (`killInFlight`).
 */
function state(ports: KillUndoPorts, session: string): "pending" | "live" | "dead" {
  if (ports.pending(session)) return "pending";
  return ports.isLive(session) ? "live" : "dead";
}

function killHandler(ports: KillUndoPorts): UndoHandler<KillEntry> {
  return {
    check(entry) {
      // Tolerant on purpose, because `check` cannot see which way it is about
      // to run (store/undo.ts UndoHandler) and each of the first two states is
      // one direction's ordinary starting point: pending means an undo is next,
      // live means the undo already ran and a redo is pending. Dead is where
      // the answer depends on something the entry does not carry, so it asks
      // the store whether anything could still bring the session back.
      if (state(ports, entry.session) !== "dead") return null;
      return ports.killRecord(entry.session) ? null : NO_RECORD;
    },
    async undo(entry) {
      // Inside the window: the whole kill is retracted and nothing has to be
      // put back, because nothing was ever sent.
      if (ports.cancelKill(entry.session)) {
        if (entry.wasSelected) ports.select(entry.session);
        return;
      }
      // The DELETE is already out and has not answered. The press is in time
      // by every measure a person has — the card is still on screen and the
      // window has only just run out — so it waits for the request rather than
      // reading the half-finished world underneath it. The wait is real: that
      // DELETE snapshots the whole box before it kills (tmux-api/snapshots.go
      // resurrectRecordFor). Answering from the state as it stands would say
      // "still running", drop the entry, and leave nothing to bring the
      // session back with once the kill landed a moment later.
      const landing = ports.killInFlight(entry.session);
      if (landing) {
        await landing;
        // The kill did not go through (the store has toasted). The session is
        // where the undo wanted it, so there is nothing left to do but hand
        // back the selection the kill took.
        if (ports.isLive(entry.session)) {
          if (entry.wasSelected) ports.select(entry.session);
          return;
        }
        const landed = ports.killRecord(entry.session);
        if (!landed) throw new Error(NO_RECORD);
        await bringBack(ports, entry, landed);
        return;
      }
      // Alive with no window in front of it. This is what a tab that crashed
      // mid-window comes back to: the entry outlived the timer in
      // sessionStorage, `pagehide` never ran, and the session the person meant
      // to kill is still there. Nothing to undo, so say that rather than
      // quietly succeeding.
      if (ports.isLive(entry.session)) throw new Error(STILL_RUNNING);
      const record = ports.killRecord(entry.session);
      if (!record) throw new Error(NO_RECORD);
      await bringBack(ports, entry, record);
    },
    async redo(entry) {
      // Its own eight seconds, through the ordinary path. Cmd+Shift+Z is as
      // easy to press by accident as the kill was, and the window is what
      // replaced the confirm in front of both, so a redo that sent the DELETE
      // straight out would be the only way left to lose a session in one
      // keystroke.
      //
      // Nothing is left disagreeing while that window runs: the entry this
      // press just moved onto the undo stack is exactly the one whose `undo`
      // cancels the timer, and `check` reads the pending state as an ordinary
      // starting point. `killLater` reaches below `store.kill` so the redo
      // records nothing of its own; false from it means a window was already
      // open, which is the world this press was asking for.
      if (!ports.isLive(entry.session)) throw new Error(SESSION_ALREADY_GONE);
      ports.killLater(entry.session);
    },
  };
}

function createHandler(ports: KillUndoPorts): UndoHandler<CreateEntry> {
  return {
    check(entry) {
      if (state(ports, entry.session) !== "dead") return null;
      return ports.killRecord(entry.session) ? null : SESSION_ALREADY_GONE;
    },
    async undo(entry) {
      // A create can be undone an hour after it happened, so this kills the
      // session outright rather than opening a grace window of its own: a press
      // that did nothing visible for eight seconds and then something
      // invisible is worse than one that acts.
      await killAgain(ports, entry.session);
    },
    async redo(entry) {
      const record = ports.killRecord(entry.session);
      if (!record) throw new Error(NO_RECORD);
      // -1 appends, which is where the create put it (addSessionToGroup).
      await bringBack(ports, { session: entry.session, group: entry.group, index: -1 }, record);
    },
  };
}

/**
 * Teach the app-wide registry about both. Called from the store that owns the
 * actions, at wiring time (store/lobby.ts).
 *
 * No `killUndoHandlers` Map beside this, unlike undo.layout.ts and
 * undo.titles.ts. Those two hand a test its own registry so it can drive the
 * inverse against fake ports; these two reach so far into the store's live
 * state — a running timer, a record it kept, the selection — that such a test
 * would mostly be asserting against its own double, so test/undo.kill.test.ts
 * drives the real store instead and this module exports only what the app
 * calls.
 */
export function registerKillUndoHandlers(ports: KillUndoPorts): void {
  registerUndoHandler<KillEntry>("kill", killHandler(ports));
  registerUndoHandler<CreateEntry>("create", createHandler(ports));
}
