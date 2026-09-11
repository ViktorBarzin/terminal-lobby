import { createMemo, createSignal, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { SessionsReport } from "../diagnostics/status";
import {
  addProject,
  addSessionToGroup,
  deleteProject,
  deriveSidebar,
  groupSeqTokens,
  isSystemSession,
  materializeGroup,
  moveSession,
  moveSessionToAnchor,
  removeSessionFromLayout,
  renameProject,
  reorderGroups,
  sameLayout,
  stabilizeModel,
  SYSTEM_GROUP_NAME,
  type DropAnchor,
  type SidebarModel,
} from "../components/lobby.logic";
import { applySessionOrder, captureVisibleOrder, type SessionOrder } from "../logic/order.logic";
import { createCollapseStore, type CollapseStore } from "./collapse";
import { toasts } from "./toast";
import { UNDO_CAP, type UndoResult, type UndoStore } from "./undo";
import { registerKillUndoHandlers } from "./undo.kill";
import { locate, registerLayoutUndoHandlers, type OrderModeCapture } from "./undo.layout";
import { registerLocalUndoHandlers } from "./undo.local";
import { registerTitleUndoHandlers } from "./undo.titles";
import { ApiError, lobbyApi, ORIGIN_USER, type LobbyApi } from "../lib/lobby-api";
import {
  emptyLayout,
  NAME_RE,
  type DockState,
  type Layout,
  type RestoreSelection,
  type Session,
  type SnapshotList,
  type SnapshotRow,
  type Whoami,
} from "../types/lobby";
import { track } from "../telemetry/track";
import { cleanTitle, firstPromptLine } from "../lib/title";
import { newSessionId } from "../lib/session-id";
import {
  forgetPromptLine,
  promptLineFor,
  prunePromptLines,
  rememberPromptLine,
} from "./prompt-line";
import { hideDockedSession } from "./dock.logic";
import { STATES_KEY } from "./visits";
import { applyWatch, carryWatch, loadWatch, setWatchUndo } from "./watchmode";
import { carryViewMode } from "./viewmode";
import { carryDraft } from "./drafts";
import { lensTarget } from "../lib/act-as";
import { ACT_AS } from "../lib/config";
import { lsGet, lsSet } from "../lib/storage";

export interface SelectedSession {
  name: string;
  owner?: string;
}

/**
 * What the text a session is created with MEANS.
 *
 * `prompt` — the composer's normal case. The text is the first thing Claude is
 * asked, and the session's title will be Claude's own summary of the
 * conversation a few seconds later (tmux-api/autotitle.go). The first line is
 * remembered locally to fill the gap and is deliberately NOT stamped, because
 * the auto-title rule only fires while `@title` is unset.
 *
 * `name` — the `shell` case. A plain shell has no conversation to summarise, so
 * nothing is ever coming and the typed text is stamped as the title.
 */
export type CreateKind = "prompt" | "name";

export interface LobbyStore {
  whoami: Accessor<Whoami | null>;
  me: Accessor<string>;
  model: Accessor<SidebarModel>;
  layout: Accessor<Layout>;
  sessions: Session[];
  loading: Accessor<boolean>;
  loadError: Accessor<string | null>;
  /**
   * How many polls have RETURNED a session list. Zero means nothing is known
   * yet, which `loading` cannot express: loading goes false even when /sessions
   * rejected. Anything deriving from the list — the app-icon badge, the visit
   * store's pruning — needs "we have an answer", not "we stopped waiting".
   *
   * It also ticks on every poll whose payload was unchanged, which is what an
   * effect needs in order to repaint on a schedule rather than only on a diff.
   */
  polls: Accessor<number>;
  /**
   * How the poll itself is doing, for the connection status panel. The session
   * list is the one channel that is not a persistent connection — it is
   * request/response with a backoff ladder — so "connected" is a fiction for it
   * and this reports what is true instead: when it last got an answer, and how
   * long it has been failing.
   */
  pollHealth: Accessor<SessionsReport>;
  selected: Accessor<SelectedSession | null>;
  toast: Accessor<string | null>;
  collapse: CollapseStore;
  /**
   * This tab's undo stack, or undefined on a page that has none.
   *
   * Handed straight back out of {@link LobbyStoreOptions.undo}, because a
   * component that holds the store has no other route to the one instance App
   * owns: the command layer reads it from here when App hands it no stack of
   * its own (keybindings/commands.ts). The dimmed card's arrow does NOT use
   * it — it goes through {@link LobbyStore.takeBackKill}, which presses that
   * kill's own entry rather than the top of the stack.
   */
  undo?: UndoStore;
  /** epoch ms a session was first observed running (working-timer anchor). */
  workingSince: (name: string) => number | undefined;

  refresh(): Promise<void>;
  /** Pause polling while the user is mid-interaction (rename/drag/menu) so a
   *  poll can't rebuild the list under them. Returns a release function. */
  hold(): () => void;
  select(name: string, owner?: string): void;
  /** Point the app at no session, which is what shows the new-session composer. */
  deselect(): void;
  /**
   * Create a session and return the id it was given. See the function's own
   * doc for what `kind` decides; the id is what a caller needs in order to send
   * the first prompt, upload attachments into its bucket, or link to it.
   */
  create(text: string, group: string, kind?: CreateKind): Promise<string>;
  /** write or clear layout.dock (the Ctrl+J scratch shell); undefined un-docks. */
  setDock(next: DockState | undefined): Promise<boolean>;
  /** Retitle a session. The tmux name is derived from the title again
   *  (ADR-0022), so this does move it; an empty title clears the title and
   *  leaves the name alone. */
  rename(name: string, title: string): Promise<boolean>;
  /** Kill a session — after a grace window in which Cmd+Z takes it back. See
   *  the function; nothing reaches tmux-api for GRACE_MS. */
  kill(name: string): Promise<void>;
  /** Is this session inside its kill window: on its way out, still in the
   *  list, and drawn dimmed with an undo arrow instead of vanishing? */
  killing(name: string): boolean;
  /**
   * When this session's kill lands, as epoch ms, or undefined when it is not
   * inside a window.
   *
   * The DEADLINE rather than a remaining count, because a count would have to
   * be re-published every second by whoever owns the timer, and nothing here
   * wants a second 1Hz signal: the sidebar already has one, and the card
   * subtracts on it (components/SessionCard.tsx). Reactive on arming and
   * disarming, not on the clock.
   */
  killingUntil(name: string): number | undefined;
  /** Take back THIS session's kill, which is what the dimmed card's arrow
   *  presses. See the function: it undoes that kill's own entry rather than
   *  the top of the stack, and works in a tab that has no stack at all. */
  takeBackKill(name: string): Promise<UndoResult>;
  /** Move into `group`; with an anchor, immediately above/below that card. */
  move(name: string, group: string, anchor?: DropAnchor): Promise<void>;
  /** Change which order the session list comes in. Goes through the store
   *  rather than straight to the pref because a switch into manual freezes the
   *  visible arrangement into the layout first, and because the switch is
   *  undoable. */
  setSessionOrderMode(next: SessionOrder): Promise<void>;
  reorderGroupsTo(from: number, to: number): Promise<void>;
  createProject(name: string, dir?: string): Promise<boolean>;
  /** Ask for a Claude session started ahead of a create, in this directory.
   *  A hint: failures are swallowed and the create works either way. */
  prewarm(dir: string): Promise<void>;
  /** Hand back a slot whose create never happened. */
  releasePrewarm(dir: string): Promise<void>;
  renameProjectAction(oldName: string, newName: string): Promise<boolean>;
  deleteProjectAction(name: string): Promise<void>;
  restore(sel?: RestoreSelection): Promise<void>;
  listSnapshots(): Promise<SnapshotList>;
  getSnapshot(ts: string): Promise<SnapshotRow[]>;
  dispose(): void;
}

/** Toast severity forwarded to the app's toast system (subset of ToastKind). */
export type NotifyKind = "info" | "error" | "warning" | "success";

export interface LobbyStoreOptions {
  /** Fired when the user ACTIVATES a session. Fires even if the name is
   *  unchanged — re-tapping the attached session is how a phone gets back to
   *  its terminal. */
  onActivate?: (session: SelectedSession) => void;
  api?: LobbyApi;
  pollMs?: number;
  autoStart?: boolean;
  initialSelected?: SelectedSession | null;
  /** update the URL hash on select (default true; off in tests). */
  syncHash?: boolean;
  /** surface a store message to the app's toast stack (in ADDITION to the
   *  legacy `toast()` signal). Omitted in tests. */
  notify?: (message: string, kind: NotifyKind) => void;
  /**
   * Which order the session list comes in — the roamed `sidebar.order` pref,
   * read here rather than in the sidebar so that ONE ordered model feeds the
   * cards, the Alt+1..0 chips, the next/prev-session chords and the anchor a
   * drop resolves against. Sorting in the render instead would have left the
   * keyboard walking an order nobody could see.
   *
   * Omitted means `manual`: exactly the behaviour every caller had before the
   * pref existed. The default that reaches a PERSON is the pref store's
   * (created time), which is where a default belongs.
   */
  sessionOrder?: Accessor<SessionOrder>;
  /** Change the ordering. A drop that names a position calls this with
   *  "manual" — see `move`. */
  setSessionOrder?: (order: SessionOrder) => void;
  /**
   * This tab's undo stack (store/undo.ts).
   *
   * App owns the one instance, because whether undo runs at all is the page's
   * business rather than this store's: a lens tab (`?as=bob`) has none. Every
   * layout action below records itself here AFTER its write lands, and the
   * inverses are registered from here at construction
   * (store/undo.layout.ts).
   *
   * Omitted means no undo: nothing is pushed, no handler is registered, and
   * every action behaves exactly as it did before undo existed. That is what
   * the tests of those actions run with.
   */
  undo?: UndoStore;
  /**
   * Whether this device can render the Ctrl+J dock, which decides whether the
   * docked shell may be hidden from the sidebar.
   *
   * The dock store publishes the same answer as `allowed`, but it is built out
   * of THIS store (App's `createDockStore({ store })`) and so cannot be passed
   * to this constructor.
   * App therefore reads the coarse-pointer query directly, as it already does
   * for the soft-keys reserve at :221. Both go through `watchQuery` on one
   * media query, so they are two views of a single browser fact rather than two
   * mechanisms; the drift worth avoiding is a CSS rule answering it as well,
   * which is why the `@media (pointer: coarse)` display:none was removed when
   * the mount was gated.
   *
   * Omitted means allowed, which is what every caller predating the phone gate
   * did. Tests that do not care about the dock keep working unchanged.
   */
  dockAllowed?: Accessor<boolean>;
}

const LAYOUT_GRACE_MS = 4000;

/**
 * How long a killed session sits in the sidebar, dimmed, before the DELETE
 * actually goes out.
 *
 * THE WINDOW IS THE CONFIRMATION. Every kill path used to ask
 * `Kill session "x"?` first, and that question is a poor one: it interrupts the
 * person who meant it, and to the person who did not it offers a name that is
 * a minted id (ADR-0019). A window asks nothing and undoes everything — the
 * card stays put and dimmed, Cmd+Z inside it retracts the whole thing, and
 * nothing has reached the server to put back.
 *
 * 8s is long enough to notice a card dim and reach for the keyboard, and short
 * enough that nobody is left wondering whether the kill worked. Exported so the
 * timer here, the sidebar's dim and the tests all read one number.
 */
export const GRACE_MS = 8000;

/**
 * Ceiling for the poll's failure backoff. The ladder doubles the base interval
 * per consecutive failure (5s → 10s → 20s) and stops here: far enough back to
 * stop hammering a link already failing to carry the poll, near enough that a
 * lobby left open through an outage catches up within half a minute of the
 * network returning — even in a browser that never fires `online`.
 */
const MAX_POLL_INTERVAL_MS = 30000;

// `STATES_KEY`, declared in ./visits and used by both stores, holds the epoch ms
// at which each live session was FIRST seen in its current Claude state. No
// backend exposes a real state-change time — a session object carries only
// created/lastActivity — so this observation is the only anchor the working
// timer has, and it must outlive the page or every reload restarts a
// long-running session's clock at 0:00.
//
// This store writes the key and ./visits reads it, so the constant lives there
// and is imported here. It used to be declared on both sides, which meant
// bumping the version in one place left the other reading an orphaned key with
// every test still green.

/** One session's state stamp, as persisted under `STATES_KEY`. */
interface StateStamp {
  state: string;
  at: number;
}

function loadStates(): Record<string, StateStamp> {
  const out: Record<string, StateStamp> = {};
  try {
    const raw = lsGet(STATES_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return out;
    for (const [name, rec] of Object.entries(parsed as Record<string, unknown>)) {
      if (!rec || typeof rec !== "object") continue;
      const { state, at } = rec as { state?: unknown; at?: unknown };
      if (typeof state === "string" && typeof at === "number") out[name] = { state, at };
    }
  } catch {
    /* private mode / corrupt entry */
  }
  return out;
}

function persistStates(states: Record<string, StateStamp>): void {
  lsSet(STATES_KEY, JSON.stringify(states));
}

export function createLobbyStore(opts: LobbyStoreOptions = {}): LobbyStore {
  const api = opts.api ?? lobbyApi;
  const pollMs = opts.pollMs ?? 5000;
  const syncHash = opts.syncHash ?? true;

  const [whoami, setWhoami] = createSignal<Whoami | null>(null);
  // Structural equality, not reference: a poll re-parses the same document into
  // a fresh object every 5s, and a bare signal would call that a change and
  // rebuild the whole sidebar under the user.
  const [layout, setLayout] = createSignal<Layout>(emptyLayout(), { equals: sameLayout });
  const [sessions, setSessions] = createStore<Session[]>([]);
  const [pending, setPending] = createSignal<Session[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [polls, setPolls] = createSignal(0);
  /** Poll health, for the connection status panel: when the last poll returned,
   *  when the current run of failures started, and how many there have been. */
  const [pollOk, setPollOk] = createSignal<number | null>(null);
  const [pollFailingSince, setPollFailingSince] = createSignal<number | null>(null);
  const [pollFails, setPollFails] = createSignal(0);
  const [selected, setSelected] = createSignal<SelectedSession | null>(
    opts.initialSelected ?? null,
  );
  const [toast, setToast] = createSignal<string | null>(null);

  const me = () => whoami()?.osUser ?? "";
  const collapse = createCollapseStore(me, opts.undo);

  /**
   * A kill inside its grace window: the timer that will land it, and the name
   * it will land on.
   *
   * The name is MUTABLE because a rename can arrive under a pending kill —
   * eight seconds is long enough for a fresh session's first title to land, and
   * since ADR-0022 that moves the name. `carryPendingKill` rewrites it, so the
   * timer fires a DELETE at whatever the session answers to by then rather than
   * at a name nothing knows, which would leave the session surviving its own
   * kill.
   */
  interface PendingKill {
    name: string;
    timer?: ReturnType<typeof setTimeout>;
    /** When the timer above fires, so the card can count down to it. */
    until: number;
  }

  /** Kills waiting out their window, keyed by the name they are waiting on. */
  const pendingKills = new Map<string, PendingKill>();
  /**
   * What this page life could bring a killed session back from: the record its
   * DELETE answered with (lib/lobby-api.ts killSession), or null from a server
   * that snapshots nothing.
   *
   * Page life only, deliberately. It is written when the kill lands and read by
   * an undo press one moment later; a reloaded tab has no record, and its
   * surviving entry refuses rather than claiming a resurrection it cannot do
   * (store/undo.kill.ts says the same from the other side).
   */
  const killRecords = new Map<string, RestoreSelection | null>();
  /**
   * The DELETEs that are out right now, keyed by name, each one the promise
   * `killNow` handed its caller.
   *
   * A kill is neither pending nor landed while its request is in flight, and
   * that gap is long enough to press Cmd+Z in: the grace timer drops the
   * pending record before it calls `killNow`, the session stays in the list
   * until the DELETE answers, and the DELETE itself waits on a whole-box
   * snapshot first (tmux-api/snapshots.go resurrectRecordFor). Without this
   * map an undo landing there read the session as still running, refused, and
   * dropped its own entry while the kill went on to succeed.
   */
  const killsInFlight = new Map<string, Promise<boolean>>();
  const [killingNames, setKillingNames] = createSignal<readonly string[]>([]);
  /** Republish the dim set. A signal rather than a bare Map so the sidebar
   *  repaints the card the moment a kill starts, lands or is taken back. */
  const publishKilling = (): void => {
    setKillingNames([...pendingKills.keys()]);
  };

  const states = loadStates();
  const workingSince = (name: string): number | undefined => {
    const rec = states[name];
    return rec && rec.state === "running" ? rec.at : undefined;
  };

  let graceUntil = 0;
  /**
   * The document this tab last PUT, held until the next poll that is allowed to
   * overwrite the local layout. PUT /api/layout takes the whole document with no
   * version check — last writer wins — so with two tabs open, tab B polling the
   * pre-move document and writing it back simply erases tab A's move. That
   * remains the backend's contract; what changes here is that it stops happening
   * in silence, which is what made a perfectly-executed drag look like it had
   * never worked. A server document that no longer matches what we wrote means
   * somebody else wrote in between.
   */
  let lastWritten: Layout | null = null;
  let holds = 0;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const burstTimers: ReturnType<typeof setTimeout>[] = [];
  /** the poll loop is live (from autoStart until dispose). */
  let polling = false;
  /** consecutive failed polls — the exponent of the backoff ladder. */
  let pollFailures = 0;
  const maxPollMs = Math.max(pollMs, MAX_POLL_INTERVAL_MS);
  /** a scheduled poll is out; a wake must not put a second one beside it. */
  let pollInFlight = false;
  /** monotonic tag per load, and the newest tag whose answer has been applied. */
  let loadSeq = 0;
  let appliedSeq = 0;

  function hold(): () => void {
    holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds = Math.max(0, holds - 1);
    };
  }

  function showToast(msg: string, kind: NotifyKind = "error"): void {
    setToast(msg);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(null), 3200);
    opts.notify?.(msg, kind);
  }

  // Merged view: server sessions + optimistic pending (not yet in the manifest).
  const mergedSessions = createMemo<Session[]>(() => {
    const names = new Set(sessions.map((s) => s.name));
    const extra = pending().filter((p) => !names.has(p.name));
    return [...sessions, ...extra];
  });

  // stabilizeModel keeps the groups whose content did not change, so the
  // sidebar's reference-keyed <For> keeps their DOM nodes. deriveSidebar
  // allocates fresh RenderGroups every run, and it re-runs on things that are
  // not a change at all — /sessions handing back the same sessions in a
  // different order, or somebody else's session appearing — each of which used
  // to re-create every group and card on the screen.
  // The docked scratch shell is not a thread: it has its own panel, so it is
  // kept out of the sidebar (vanilla parity). ✕ clears layout.dock, and it
  // reappears here as an ordinary card the very next derive.
  const sessionOrder = (): SessionOrder => opts.sessionOrder?.() ?? "manual";

  // applySessionOrder sits between the two on purpose: deriving decides which
  // sessions each group HAS, the ordering decides the sequence they come in,
  // and stabilize then hands back the group objects that came out the same
  // either way.
  const model = createMemo<SidebarModel>((prev) =>
    stabilizeModel(
      prev,
      applySessionOrder(
        deriveSidebar(
          layout(),
          hideDockedSession(mergedSessions(), layout(), opts.dockAllowed?.() ?? true),
          me(),
        ),
        sessionOrder(),
      ),
    ),
  );

  /** The names a group renders right now ("" = ungrouped). */
  const groupRender = (group: string): string[] =>
    model()
      .groups.find((g) => (group === "" ? g.kind === "ungrouped" : g.name === group))
      ?.sessions.map((s) => s.name) ?? [];

  /**
   * Names that are actually TAKEN: live sessions plus this tab's optimistic
   * pending ones. Deliberately NOT the layout's names — a layout entry outlives
   * the session it points at (removeSession runs only on an explicit UI kill),
   * and treating those orphans as taken burns the name with no way to free it.
   * Matches the vanilla page's `sessionExists`, which reads the live manifest.
   */
  function takenNames(): Set<string> {
    return new Set<string>(mergedSessions().map((s) => s.name));
  }

  /**
   * Move the selection to a session that was renamed under it.
   *
   * This is load-bearing again. A session is created with a minted id and keeps
   * it until its first title lands, at which point tmux-api renames it to
   * something readable (ADR-0022) — which for a fresh session is seconds into
   * the first turn, with nobody having asked. The tab is holding the OLD name
   * in the terminal's `?arg=` (built by `terminalFrameArgs`, handed to
   * TerminalNative), and ttyd spawns a fresh `tmux new-session -A -s <name>`
   * per websocket, so the next reconnect would CREATE the old name as an empty
   * session and leave the person looking at a blank shell while their
   * conversation ran on under the new name.
   *
   * Both retitle paths refresh immediately rather than waiting out a poll, so
   * the window where a tab holds a stale name is one round trip for a typed
   * title and one poll for a summary.
   *
   * What counts as "the same session under a new name" is `renamesBetween`,
   * which matches on tmux's session id and, for a session no poll ever listed
   * under its old name, on the birth name the server records.
   *
   * Re-selecting is also what drops the stale mount: App prunes a kept
   * SessionView whose name has left the session list, and the selection moving
   * is what makes that effect run (components/App.tsx, prune).
   */
  /**
   * Carry the per-browser records a rename would otherwise strand.
   *
   * ADR-0022 made renaming an ordinary background event again: a title lands
   * and tmux-api derives a name from it, seconds into a fresh session's first
   * turn, with nobody having asked. Anything keyed by the session NAME has to
   * follow. The six server-side stores do (`carryRenameAcrossStores`), and
   * store/visits.ts sidesteps it by keying on tmux's session id — but three
   * records live in this browser under the name, and this is the only place
   * that knows the rename happened at all.
   *
   * Watch mode is the one that MISBEHAVES rather than merely forgets, and it is
   * why this exists: the view remounts under the new name, re-takes the join
   * decision, and reads the session it is itself driving as one somebody else
   * is driving (store/watchmode.ts `carryWatch` has the mechanism). The other
   * two just lose something — the view a session was being read in, and an
   * unsent message.
   *
   * OWN SESSIONS ONLY. A foreign row's id comes from another user's tmux
   * server, where the same `$41` names an unrelated session, so matching ids
   * across the two accounts would move this user's records onto a stranger's
   * name. Same reason `followRenamedSelection` will not follow one.
   */
  function carryRenamedRecords(prev: readonly Session[], next: readonly Session[]): void {
    // The same namespace the views record under, so a decision made about bob's
    // session through a lens is carried against bob's session and not your own.
    const as = lensTarget(whoami(), ACT_AS);
    for (const [was, now] of renamesBetween(prev, next)) {
      carryWatch(was, now, as);
      carryViewMode(was, now);
      carryDraft(was, now);
      // The undo stack is the fourth record keyed by the name. Its entries
      // hold one in `session` or `sessions` and nowhere else (store/undo.ts
      // UndoEntryBase), so this rewrites what an entry cannot key by tmux's
      // session id: a layout position, or a title entry about a session from a
      // server that supplies no id. Own sessions only, like the three above,
      // and `as` is always "" here since a lens tab has no stack at all.
      opts.undo?.carry(was, now);
      // The fifth record keyed by the name, and the one with a deadline: a
      // kill waiting out its grace window fires a DELETE at whatever name this
      // says in a few seconds' time. A rename landing under it used to leave
      // the timer aimed at a name nothing answers to, and the session would
      // survive its own kill.
      carryPendingKill(was, now);
    }
  }

  /**
   * Which sessions changed name between two polls, as [old, new] pairs.
   *
   * TWO LINKS, and the second is the one that matters most. tmux's session id
   * survives a rename, so a session seen in BOTH lists is matched on that. But
   * a fresh session is renamed as soon as its first title lands (ADR-0022) —
   * seconds in, while GET /sessions is behind a 5-second cache — so it is quite
   * ordinary for the minted id never to appear in a list at all, and then there
   * is no earlier row to match. That is what `bornAs` is for: the server records
   * the name the session was created with, which is exactly the name this tab is
   * holding.
   *
   * A birth name is believed only when nothing in the new list still ANSWERS to
   * it. A session that is still listed has not been renamed, whatever some other
   * session claims to have been born as.
   *
   * OWN SESSIONS ONLY. A foreign row's id comes from another user's tmux server,
   * where the same `$41` names an unrelated session, so matching ids across the
   * two accounts would pair up sessions that have nothing to do with each other.
   */
  function renamesBetween(
    prev: readonly Session[],
    next: readonly Session[],
  ): Array<[string, string]> {
    const mine = (s: Session) => !s.owner || s.owner === me();
    const wasNamed = new Map<string, string>();
    for (const s of prev) if (s.id && mine(s)) wasNamed.set(s.id, s.name);
    const live = new Set(next.filter(mine).map((s) => s.name));
    const moved: Array<[string, string]> = [];
    for (const s of next) {
      if (!mine(s)) continue;
      const was = (s.id ? wasNamed.get(s.id) : undefined) ?? s.bornAs;
      if (was === undefined || was === s.name || live.has(was)) continue;
      moved.push([was, s.name]);
    }
    return moved;
  }

  function followRenamedSelection(prev: readonly Session[], next: readonly Session[]): void {
    const sel = selected();
    if (!sel || sel.owner) return; // foreign sessions are not ours to follow
    if (next.some((s) => s.name === sel.name)) return; // still there
    const moved = renamesBetween(prev, next).find(([was]) => was === sel.name);
    if (!moved) return; // genuinely gone, not renamed
    applySelection(moved[1], undefined);
  }

  /** Stamp state transitions and prune dead sessions (vanilla trackStateChanges). */
  function trackStates(next: Session[]): void {
    const live = new Set(next.map((s) => s.name));
    const now = Date.now();
    let dirty = false;
    for (const name of Object.keys(states)) {
      if (!live.has(name)) {
        delete states[name];
        dirty = true;
      }
    }
    for (const s of next) {
      const cur = s.state ?? "";
      const rec = states[s.name];
      if (!rec || rec.state !== cur) {
        states[s.name] = { state: cur, at: now };
        dirty = true;
      }
    }
    if (dirty) persistStates(states);
  }

  /**
   * Fill in the line a session was created with, for the ones with no title yet.
   *
   * A session's title arrives from Claude's summary seconds after the first
   * prompt, and its name says nothing (ADR-0019), so between the two the card
   * would read `New session`. The line the person typed is more recognisable
   * than that, so it stands in — as a `title` on the client's copy only, which
   * is what puts it on every surface that shows one without a second lookup.
   *
   * A real title arriving is the end of it: the record is dropped, so the
   * summary is never second-guessed and nothing lingers in storage.
   */
  function withPromptLines(list: Session[]): Session[] {
    return list.map((s) => {
      if (s.title) {
        forgetPromptLine(s.name);
        return s;
      }
      const line = promptLineFor(s.name);
      return line ? { ...s, title: line } : s;
    });
  }

  /** What one load did to the poll's backoff ladder. */
  type LoadOutcome = "ok" | "failed" | "skipped";

  /**
   * One pass over /whoami + /sessions + /layout.
   *
   * Every pass carries a monotonic tag and refuses to apply an answer older
   * than one already applied. Passes DO overlap — the visibility and online
   * wakes, the post-create burst and the poll itself all call in, and on a slow
   * link a request outlives the pass that follows it. Without the tag the last
   * answer to ARRIVE wins rather than the newest one: a slow poll repaints the
   * sidebar from a snapshot the user has already moved past, and its equally
   * stale layout reads as somebody else's write — announced as "Layout changed
   * elsewhere" when nothing changed anywhere.
   */
  async function load(): Promise<LoadOutcome> {
    // Mid-interaction (rename/drag/menu): don't rebuild the list under the user.
    if (holds > 0) return "skipped";
    const seq = ++loadSeq;
    let gotWhoami = whoami();
    if (!gotWhoami) {
      try {
        gotWhoami = await api.whoami();
        setWhoami(gotWhoami);
      } catch (e) {
        if (seq < appliedSeq) return "failed";
        appliedSeq = seq;
        setLoadError(e instanceof ApiError ? `Access denied (HTTP ${e.status})` : "Failed to load");
        setLoading(false);
        return "failed";
      }
    }
    const [sRes, lRes] = await Promise.allSettled([api.listSessions(), api.getLayout()]);
    // The session list is the poll's payload and the layout degrades on its own
    // (the sidebar still renders from live sessions), so /sessions is what says
    // whether the network is carrying us — and it alone drives the backoff.
    const outcome: LoadOutcome = sRes.status === "fulfilled" ? "ok" : "failed";
    if (seq < appliedSeq) return outcome; // a newer answer already landed
    appliedSeq = seq;
    if (sRes.status === "fulfilled") {
      const list = withPromptLines(sRes.value);
      trackStates(list);
      // Before setSessions, which is what makes `sessions` the OLD list here.
      // The carry runs FIRST: moving the selection is what mounts a view under
      // the new name, and that view reads the records this call moves.
      carryRenamedRecords(sessions, sRes.value);
      followRenamedSelection(sessions, sRes.value);
      // Reconcile by name rather than replace: a re-parsed but unchanged
      // payload must write nothing, or every memo downstream recomputes and
      // <For> re-creates every group and card (taking open menus with it).
      setSessions(reconcile(list, { key: "name" }));
      // After setSessions, so a reader waking on `polls` sees the new list.
      setPolls((n) => n + 1);
      // drop optimistic pending that the server now knows about
      const known = new Set(sRes.value.map((s) => s.name));
      const stillPending = pending().filter((p) => !known.has(p.name));
      // Pending names count as live. A create's session does not exist
      // server-side until the terminal's socket attaches and ttyd runs
      // tmux-user-attach, and GET /sessions is behind a 5-second cache, so the
      // burst polls at 700/1600/3000ms routinely report a list without it —
      // pruning against
      // that alone would delete the prompt line the card is there to show.
      prunePromptLines([...known, ...stillPending.map((p) => p.name)]);
      if (stillPending.length !== pending().length) setPending(stillPending);
      setLoadError(null);
    } else {
      setLoadError("Failed to load sessions");
    }
    // A stale poll must not revert an in-flight local layout change.
    if (lRes.status === "fulfilled" && Date.now() >= graceUntil) {
      if (lastWritten && !sameLayout(lRes.value, lastWritten)) {
        showToast("Layout changed elsewhere", "warning");
      }
      lastWritten = null;
      setLayout(lRes.value);
    }
    setLoading(false);
    return outcome;
  }

  async function refresh(): Promise<void> {
    await load();
  }

  /** The wait before the next poll: the base interval doubled per consecutive
   *  failure, capped at maxPollMs. */
  function pollDelay(): number {
    return Math.min(pollMs * 2 ** pollFailures, maxPollMs);
  }

  /**
   * Nobody is reading a backgrounded tab, so it has nothing to poll for — and
   * a tab left open all day costs far more requests than one being looked at.
   * `wake()` refreshes on visibilitychange, so pausing here loses no freshness:
   * the list is rebuilt the moment the tab is in front of someone again.
   */
  const isHidden = (): boolean =>
    typeof document !== "undefined" && document.visibilityState === "hidden";

  function scheduleNextPoll(outcome: LoadOutcome): void {
    if (!polling) return; // disposed while this poll was still out
    // The status panel reports this channel, and "how the poll is doing" was
    // knowable only from in here (ADR-0016). Recorded before the ladder moves
    // so `failingSince` marks the FIRST failure, not the latest one.
    if (outcome === "ok") {
      setPollOk(Date.now());
      setPollFailingSince(null);
    } else if (outcome === "failed" && pollFailingSince() === null) {
      setPollFailingSince(Date.now());
    }
    if (outcome !== "skipped") setPollFails(outcome === "ok" ? 0 : (n) => n + 1);

    if (outcome === "ok") pollFailures = 0;
    // Stop counting once the ladder has saturated: the delay is capped there
    // anyway, and an overnight outage should not leave 2 ** <hours> behind.
    else if (outcome === "failed" && pollDelay() < maxPollMs) pollFailures += 1;
    // "skipped" is neither: a poll held off mid-drag says nothing about the
    // network, so it leaves the ladder exactly where it was.

    // Leave the loop parked rather than timed; onVisible restarts it.
    if (isHidden()) return;

    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void pollTick();
    }, pollDelay());
  }

  /**
   * One turn of the poll loop, which schedules the next turn off its own ANSWER
   * rather than off a fixed interval. setInterval keeps firing into a network
   * that has not answered the previous request yet, so a link slow enough to
   * overrun 5s builds a queue of polls that all land together, out of order and
   * on top of each other — the load the connection was already too weak to
   * carry, multiplied.
   */
  async function pollTick(): Promise<void> {
    if (pollInFlight) return; // a wake landed on top of a running poll
    pollInFlight = true;
    let outcome: LoadOutcome = "failed";
    try {
      outcome = await load();
    } finally {
      pollInFlight = false;
      // In the finally so an unexpected throw costs one poll, not the loop.
      scheduleNextPoll(outcome);
    }
  }

  /**
   * Network back, or the tab in front of the user again — the two moments a
   * phone most wants to catch up. Poll now instead of sitting out a delay the
   * ladder earned while the network was down, and put the ladder back at the
   * base: whatever the backoff was measuring is over.
   */
  function wake(): void {
    // `online` can fire on a tab nobody is looking at; that is not a reason to
    // restart a loop deliberately parked by isHidden().
    if (!polling || isHidden()) return;
    pollFailures = 0;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
    void pollTick();
  }

  function applyLocalLayout(next: Layout): void {
    setLayout(next);
    graceUntil = Date.now() + LAYOUT_GRACE_MS;
    // Disarm the conflict check: only a document we PUT ourselves can be
    // compared against the server's. A local mirror of a change the BACKEND
    // made (rename rewrites the server layout on our behalf) is not one, and
    // reading it back would accuse the server of a conflict with itself.
    lastWritten = null;
  }

  /** PUT the layout; false when the write did not land (local state rolled back). */
  async function saveLayout(next: Layout): Promise<boolean> {
    const prev = layout();
    applyLocalLayout(next);
    try {
      await api.putLayout(next);
    } catch {
      setLayout(prev);
      graceUntil = 0;
      showToast("Couldn't save layout");
      await refresh();
      return false;
    }
    lastWritten = next;
    return true;
  }

  function updateHash(sel: SelectedSession | null): void {
    if (!syncHash || typeof window === "undefined") return;
    try {
      const hash = sel
        ? "#" + sel.name + (sel.owner && sel.owner !== me() ? "@" + sel.owner : "")
        : "";
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search + hash,
      );
    } catch {
      /* no history */
    }
  }

  /**
   * Point the app at a session WITHOUT announcing an activation. Used by paths
   * that merely have to keep the selection pointing at the right name — rename
   * being the one that matters: it re-selects the renamed session, and on a
   * phone an activation there would throw the user out of the list and into the
   * terminal in the middle of typing a name.
   */
  function applySelection(name: string, owner?: string): void {
    track("session.selected", { "tl.session": name, "tl.kind": owner ? "foreign" : "own" });
    setSelected({ name, ...(owner ? { owner } : {}) });
    updateHash({ name, owner });
    // auto-expand the group containing this session
    const g = model().groups.find((grp) => grp.sessions.some((s) => s.name === name));
    if (g) collapse.expand(g.kind === "ungrouped" ? ":ungrouped" : g.name);
  }

  /**
   * The user ASKED for this session — every activation path funnels here
   * (card tap, card Enter, command palette, create, a notification tap), which
   * is what lets the phone layout flip forward from one place.
   *
   * onActivate fires even when the name is UNCHANGED: re-tapping the session
   * you are already attached to is exactly how you get back to the terminal
   * after opening the list, and a Solid effect on selected() cannot see that
   * because nothing changed.
   */
  function select(name: string, owner?: string): void {
    applySelection(name, owner);
    opts.onActivate?.({ name, ...(owner ? { owner } : {}) });
  }

  /**
   * Point the app at no session.
   *
   * Nothing selected is what shows the new-session composer, so this is how
   * every "new session" route gets there: the sidebar's button, the per-project
   * `+`, Alt+Shift+N and the palette. The session the user was in stays mounted
   * and hidden (store/keepalive.ts), so coming back to it costs nothing.
   */
  function deselect(): void {
    if (selected() === null) return;
    setSelected(null);
    updateHash(null);
  }

  function quickRefreshBurst(): void {
    for (const ms of [700, 1600, 3000]) {
      burstTimers.push(setTimeout(() => void refresh(), ms));
    }
  }

  // Routed through the store, like every other server call a component makes,
  // rather than reaching for the module singleton — which is also what lets a
  // test observe them.
  async function prewarm(dir: string): Promise<void> {
    await api.prewarm(dir);
  }

  async function releasePrewarm(dir: string): Promise<void> {
    await api.releasePrewarm(dir);
  }

  /**
   * A session id that no live or pending session already holds.
   *
   * A 60-bit id colliding is not an event anyone will see, and `tmux
   * new-session -A` would attach the second create to the FIRST session's
   * conversation if one ever did. The check is one set lookup against the last
   * poll, and a fresh mint is the whole retry.
   */
  function freshSessionName(): string {
    const taken = takenNames();
    let n = newSessionId();
    for (let i = 0; i < 8 && taken.has(n); i++) n = newSessionId();
    return n;
  }

  /**
   * Create a session, giving it a fresh id for a name.
   *
   * The name is minted here rather than asked for: creation reaches no server
   * at all — the session comes into being when the terminal's WebSocket
   * attaches and ttyd runs `tmux new-session -A` — so the browser has to have a
   * name before anything else can. It is an opaque id and it never changes
   * (ADR-0019).
   *
   * Nothing is refused. An empty box is a real instruction — it makes a session
   * with no prompt, which reads `New session` until a summary arrives — and two
   * sessions may carry the same text, because nothing is derived from it.
   *
   * What happens to the text depends on `kind`; see CreateKind. Returns the id
   * the session was given, which is what the caller needs to send the first
   * prompt. A layout write that fails is toasted and drops the optimistic card,
   * but the session itself is still started by the attach.
   */
  async function create(text: string, group: string, kind: CreateKind = "prompt"): Promise<string> {
    const t = kind === "name" ? cleanTitle(text) : firstPromptLine(text);
    const n = freshSessionName();
    // Creation is a lobby-only act: tmux-api never sees it, so this is the only
    // record of it.
    track("session.created", { "tl.session": n, "tl.to": group || "ungrouped" });
    const nowSec = Math.floor(Date.now() / 1000);
    setPending((p) => [
      ...p,
      {
        name: n,
        // Carry the title on the optimistic card. The name is an id, so
        // without this the card reads as twelve random characters for the
        // second before the server has been told about the session.
        title: t,
        owner: me(),
        attached: 0,
        lastActivity: nowSec,
        // Creating a session attaches read-write, so it counts as driving it —
        // without this the optimistic card reads with no time at all for the
        // second before the server answers.
        lastDrive: nowSec,
        created: nowSec,
        state: "",
        // This IS the lobby's own create path, so the card says so. The server
        // stamps @tl_origin=user a moment later when the attach creates the
        // tmux session (devvm/tmux-user-attach), but the card exists before
        // that — and an unstamped card is a SYSTEM session, so a create the
        // user is watching would vanish into a collapsed group for the second
        // or two until the first poll that knows the session.
        origin: ORIGIN_USER,
      },
    ]);
    // The line the card reads until Claude's summary lands. Persisted rather
    // than left on the optimistic card, which the first poll that knows the
    // session removes — several seconds before any summary.
    if (kind === "prompt") rememberPromptLine(n, t);
    const saved = await saveLayout(addSessionToGroup(layout(), n, group));
    if (!saved) {
      // The layout PUT is the only record a create makes, so a write that did
      // not land created nothing. Keeping the optimistic card would strand a
      // phantom the poll can never resolve. Selecting still happens: attaching
      // the terminal is what actually brings the session into being, and that
      // path is unaffected when it is only the layout endpoint that is down.
      setPending((p) => p.filter((s) => s.name !== n));
    }
    select(n);
    // Stamping the title needs the session to EXIST, and only the terminal's
    // attach creates it. The refresh burst is already the "has it appeared
    // yet" poll, so the stamp rides along with it.
    //
    // Only for a NAME. Stamping a prompt's first line would set `@title`, and
    // the auto-title rule fires only while `@title` is unset — the placeholder
    // would become permanent and Claude's summary would never reach the card.
    if (kind === "name" && t !== "") void stampTitleWhenAlive(n, t);
    // Recorded even when the layout write did not land, unlike every layout
    // action on this store: a create that lost its PUT still created a session,
    // because the ttyd attach is what brings one into being, and that is the
    // half Cmd+Z has to be able to take away.
    opts.undo?.push({ kind: "create", session: n, group });
    quickRefreshBurst();
    return n;
  }

  /**
   * Stamp a title onto a session the lobby has just asked ttyd to create.
   *
   * Retries on the same cadence as quickRefreshBurst because the session does
   * not exist until the terminal's WebSocket lands, and a 404 here means "not yet"
   * rather than "no". Gives up quietly after the last attempt: the session is
   * running and usable, it is just showing its name.
   */
  async function stampTitleWhenAlive(name: string, title: string): Promise<void> {
    for (const ms of [700, 1600, 3000, 6000]) {
      await new Promise((r) => setTimeout(r, ms));
      try {
        await api.setSessionTitle(name, title);
        void refresh();
        return;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) continue; // not up yet
        return; // anything else: the title is not worth a second error
      }
    }
  }

  /**
   * Stamp a title (or clear it with ""), and wait for the refresh that brings
   * the derived name back. false = the write did not land, and it has toasted.
   *
   * The two actions below are this plus an undo entry, and the undo handler is
   * this ALONE (store/undo.titles.ts): an inverse that went through `rename`
   * would record itself on the stack and wipe the redo half the press is about
   * to fill. Takes an already-clean title, since the caller is what decides
   * whether an empty box means "clear" (lib/title.ts cleanTitle).
   */
  async function applyTitle(name: string, title: string): Promise<boolean> {
    // Clearing hands the session back to its summary, so the placeholder goes
    // too — leaving it would put the prompt line straight back on the card.
    if (title === "") forgetPromptLine(name);
    try {
      await api.setSessionTitle(name, title);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) showToast("Session no longer exists");
      else showToast("Rename failed");
      return false;
    }
    await refresh();
    return true;
  }

  /** What a retitle remembers about a session BEFORE it writes: the title it
   *  is replacing, and the two fields that find the session again once the
   *  write has moved its name. */
  interface TitleWas {
    id?: string;
    bornAs?: string;
    title: string;
  }

  function titleNow(name: string): TitleWas | null {
    const s = mergedSessions().find((x) => x.name === name);
    if (!s) return null;
    return {
      ...(s.id ? { id: s.id } : null),
      ...(s.bornAs ? { bornAs: s.bornAs } : null),
      title: s.title ?? "",
    };
  }

  /**
   * The name the session answers to after a write that may have renamed it.
   *
   * The same two links `renamesBetween` uses and in the same order: tmux's
   * session id, then the birth name the server records for a session renamed
   * away from a minted id. A session with neither cannot be followed from
   * here, because the pre-write list cannot be snapshotted: `reconcile`
   * rewrites the rows in place. The entry then keeps the name the retitle was
   * made against, and `carry` moves it when a poll reveals the rename.
   */
  function nameAfterTitle(was: TitleWas, name: string): string {
    const list = mergedSessions();
    const byId = was.id ? list.find((s) => s.id === was.id) : undefined;
    if (byId) return byId.name;
    const born = was.bornAs ? list.find((s) => s.bornAs === was.bornAs) : undefined;
    return born?.name ?? name;
  }

  /**
   * Record a retitle, AFTER its write landed.
   *
   * A session the list has never shown reads as having had no title, which is
   * the right guess: its undo clears the title, and clearing is the state a
   * session with none is already in.
   */
  function pushTitle(was: TitleWas | null, name: string, after: string): void {
    if (!opts.undo) return;
    opts.undo.push({
      kind: "title",
      session: was ? nameAfterTitle(was, name) : name,
      ...(was?.id ? { id: was.id } : null),
      before: was?.title ?? "",
      after,
    });
  }

  /**
   * Clear a session's title so its card shows its name again.
   *
   * Emptying the rename box is the only way back to a bare name, and it is the
   * state every session that predates titles is already in. The NAME is left
   * exactly where it is — an empty title derives nothing (ADR-0022), and a name
   * invented for a running session would be worse than a stale one.
   */
  async function clearTitle(name: string): Promise<boolean> {
    const was = titleNow(name);
    if (!(await applyTitle(name, ""))) return false;
    // Its own push, because clearing does not route through `rename` below.
    // It is also the one title change on this screen that cannot be re-typed
    // from memory, so it is the last one Cmd+Z should miss.
    pushTitle(was, name, "");
    return true;
  }

  /**
   * Retitle a session: set the text everyone reads, and the name tmux shows.
   *
   * The tmux name is derived from the title again (ADR-0022), so this DOES move
   * something: tmux-api renames the session and carries the six stores keyed by
   * the old name. The `refresh` below is what closes the gap — it brings back
   * the new name, and `followRenamedSelection` moves the selection onto it by
   * session id, which also re-navigates the terminal away from a name that no
   * longer exists. Two sessions may still read the same; the second gets a
   * `-2` suffix on its name and nothing else changes.
   */
  async function rename(name: string, title: string): Promise<boolean> {
    const t = cleanTitle(title);
    if (t === "") {
      // An empty title hands the session back to its summary.
      return clearTitle(name);
    }
    const was = titleNow(name);
    if (!(await applyTitle(name, t))) return false;
    // The CLEANED title, which is what the server stored: an entry holding the
    // raw text would redo a title nobody has, and then refuse its own
    // precondition the next press.
    pushTitle(was, name, t);
    return true;
  }

  /**
   * Kill a session — in GRACE_MS, unless Cmd+Z gets there first.
   *
   * Nothing reaches tmux-api on the press. The card stays in the list and goes
   * dim (`killing`), the timer below is the only thing in flight, and an undo
   * inside the window drops it with no server call at either end. The window
   * replaced the `Kill session "x"?` confirm on every entry point — the ⋯ menu,
   * the right swipe, the sidebar's Delete, alt+shift+w and the palette — so
   * this is the one place that decides what a kill costs.
   *
   * Past the window the DELETE has gone out and undo has to bring the session
   * back from the record it left instead (store/undo.kill.ts), which loses the
   * scrollback and the process tree.
   */
  async function kill(name: string): Promise<void> {
    const at = locate(layout(), name);
    const wasSelected = selected()?.name === name;
    // A second press on a session already on its way out: the window it is in
    // is the one to wait for, and a second entry would make the person press
    // Cmd+Z twice to take back one kill.
    if (!armKill(name)) return;
    opts.undo?.push({
      kind: "kill",
      session: name,
      group: at ? at.group : "",
      index: at ? at.index : -1,
      ...(wasSelected ? { wasSelected: true } : null),
    });
  }

  /**
   * Open a kill's grace window: the dimmed card, the deselect, and the DELETE
   * only when GRACE_MS is up. No undo entry.
   *
   * The plain write under `kill` above, and the second one here after `killNow`
   * (store/undo.titles.ts states the rule): the REDO of an undone kill comes
   * back through this, and going through `kill` would push a second entry and
   * clear the redo stack that press is walking down.
   *
   * false when a window was already open for that name. Not a failure — it is
   * the second press on a card already on its way out.
   */
  function armKill(name: string): boolean {
    if (pendingKills.has(name)) return false;
    // Deselected on the press, not when the kill lands: the person asked for
    // the session to go, and leaving its terminal in front of them for eight
    // seconds reads as a kill that missed. The entry remembers it was open, so
    // an undo hands it straight back.
    if (selected()?.name === name) deselect();
    const rec: PendingKill = { name, until: Date.now() + GRACE_MS };
    rec.timer = setTimeout(() => {
      // Out of the map first, so the killNow below finds no window to cancel.
      pendingKills.delete(rec.name);
      publishKilling();
      void killNow(rec.name);
    }, GRACE_MS);
    pendingKills.set(name, rec);
    publishKilling();
    return true;
  }

  /**
   * The kill itself: the DELETE, the layout PUT, the local prune and the
   * deselect. No window, and no undo entry.
   *
   * This is the plain write under `kill` above, and what an inverse has to
   * call: `kill` records an entry, so an undo that went through it would push
   * onto the stack and wipe the redo half the press is about to fill. Three
   * callers — the grace timer, the undo of a create, and the redo of a kill.
   *
   * false when the DELETE did not go through, having toasted. The record that
   * would put the session back goes into `killRecords` rather than to the
   * caller, because the caller that wants it is a later press.
   */
  function killNow(name: string): Promise<boolean> {
    // One DELETE per name at a time, and the promise stays reachable while it
    // is out. Both halves matter to undo. A press that lands in that window
    // used to read the session as "still running" — the timer had already
    // dropped the pending record and the prune only happens after the await —
    // so the entry was refused and dropped while the DELETE went on to land,
    // leaving the person no way back from a kill they had just taken back. The
    // undo handler awaits this promise instead (store/undo.kill.ts).
    //
    // The window is not small: the DELETE runs a whole-box `tmux-persist save`
    // before it kills (tmux-api/snapshots.go resurrectRecordFor).
    const already = killsInFlight.get(name);
    if (already) return already;
    const landing = sendKill(name).finally(() => {
      killsInFlight.delete(name);
    });
    killsInFlight.set(name, landing);
    return landing;
  }

  async function sendKill(name: string): Promise<boolean> {
    cancelKill(name); // landing it now, so its window is over either way
    let record: RestoreSelection | null = null;
    let killed = true;
    try {
      record = (await api.killSession(name)) ?? null;
    } catch (e) {
      // A 404 is not a failed kill, but it is not a kill either: no session
      // answers to that name here. The commonest way to get one is a name that
      // has MOVED — tmux-api renames a session as soon as its first title
      // lands (ADR-0022), and the session list is behind a cache — so the
      // session is very probably still running under another name. The local
      // cleanup below still runs, because the name really is not there; what
      // changes is the ANSWER, so undoing a create refuses instead of
      // reporting a kill that did not happen.
      if (!(e instanceof ApiError) || e.status !== 404) {
        showToast("Couldn't kill session");
        return false;
      }
      killed = false;
    }
    // Only for a session this really killed. A record for a 404 would be a
    // promise to resurrect something that never died.
    if (killed) killRecords.set(name, record);
    // Bounded by the stack's own depth, since a record whose entry has fallen
    // off the end of it can never be asked for again. A Map keeps insertion
    // order, so the first key is the oldest kill.
    while (killRecords.size > UNDO_CAP) {
      const oldest = killRecords.keys().next();
      if (oldest.done) break;
      killRecords.delete(oldest.value);
    }
    // The backend drops it from the server layout on a UI kill — but only when
    // tmux still had the session; a kill that 404s (already dead) leaves the
    // entry behind, and the next poll would pull it back. PUT it ourselves.
    await saveLayout(removeSessionFromLayout(layout(), name));
    setSessions((prev) => prev.filter((s) => s.name !== name));
    setPending((p) => p.filter((s) => s.name !== name));
    if (selected()?.name === name) deselect();
    await refresh();
    return killed;
  }

  /** Drop a kill still inside its window: the timer goes, the card un-dims,
   *  and no DELETE was ever sent. false when there was nothing to drop. */
  function cancelKill(name: string): boolean {
    const rec = pendingKills.get(name);
    if (!rec) return false;
    if (rec.timer) clearTimeout(rec.timer);
    pendingKills.delete(name);
    publishKilling();
    return true;
  }

  /**
   * The dimmed card's ↺ arrow: take back THIS session's kill.
   *
   * It presses the entry the kill pushed, wherever that entry now sits on the
   * stack, rather than the top of it. Anything at all can have happened in the
   * eight seconds since — a group collapsed, another card renamed, a second
   * kill — and pressing the top from a button drawn on one card undid that
   * other thing instead while this session went on dying, with no toast, since
   * a working undo says nothing.
   *
   * Going through the stack rather than straight to `cancelKill` is what keeps
   * the two affordances the same action: the entry comes off the undo stack
   * (so a later Cmd+Z cannot take the same kill back twice) and lands on the
   * redo stack (so Cmd+Shift+Z kills again, on a fresh window).
   *
   * The fallback underneath it is for a tab with no stack — a lens tab
   * (`?as=bob`) runs with undo off (store/undo.ts UndoStoreOptions), and it is
   * the one tab where the session belongs to somebody else. Retracting a
   * window that has sent nothing needs no history to do it, so the arrow works
   * there too rather than being drawn dead.
   */
  async function takeBackKill(name: string): Promise<UndoResult> {
    const stack = opts.undo;
    if (stack) {
      const r = await stack.undoEntry((e) => e.kind === "kill" && e.session === name);
      // ok, or a refusal with something to say. Only "nothing matched" falls
      // through, which is the silent no-op shape (reason null).
      if (r.ok || r.reason !== null) return r;
    }
    return cancelKill(name) ? { ok: true } : { ok: false, reason: null };
  }

  /** Move a pending kill onto the name its session now answers to. */
  function carryPendingKill(was: string, now: string): void {
    const rec = pendingKills.get(was);
    if (!rec) return;
    pendingKills.delete(was);
    rec.name = now;
    pendingKills.set(now, rec);
    publishKilling();
  }

  /**
   * Land every pending kill on the way out of the page.
   *
   * The window is a delay, not a maybe: somebody asked for those sessions to
   * go, so closing the tab or reloading has to complete the kill rather than
   * cancel it. `pagehide` is the last event a browser fires for both, and the
   * request has to be synchronous and `keepalive` — an ordinary fetch is
   * cancelled with the document before it can settle (lib/lobby-api.ts
   * killSessionKeepalive, which builds it through the same URL helper as every
   * other call so `?as=` rides along).
   *
   * No layout PUT beside it. The DELETE lands on a session tmux still has, and
   * the backend drops the layout entry itself for a UI kill; the PUT in
   * `killNow` is there for the kill that 404s.
   *
   * A HARD CRASH MISSES THIS — a killed renderer fires no events, and a browser
   * may drop keepalive requests on exit. The failure mode is a session that
   * survives a kill nobody saw fail and gets killed again when somebody
   * notices it, which is the cheap direction to be wrong in; the expensive one
   * is killing a session whose undo was still on screen.
   */
  function flushKills(): void {
    for (const rec of pendingKills.values()) {
      if (rec.timer) clearTimeout(rec.timer);
      api.killSessionKeepalive?.(rec.name);
    }
    pendingKills.clear();
    publishKilling();
  }

  /**
   * Write (or clear) the Ctrl+J dock. It rides the roamed layout, so the dock
   * follows the user across devices exactly as their grouping does; passing
   * undefined un-docks, which is all ✕ has to do — the shell keeps running and
   * the sidebar stops hiding it.
   */
  async function setDock(next: DockState | undefined): Promise<boolean> {
    const { dock: _drop, ...rest } = layout();
    return saveLayout(next ? { ...rest, dock: next } : rest);
  }

  /**
   * Adopt a session the lobby did not make, because somebody has just dragged
   * it out of System. Answers false when the adoption did not land, and the
   * caller then writes no layout at all.
   *
   * The order matters and it is the opposite of the usual optimistic one. With
   * the layout written first, a failed POST would leave the card sitting in a
   * project while tmux still called the session `test` — and deriveSidebar
   * honours an explicit project placement over the origin, so the next poll
   * would AGREE with the arrangement. The card would look rescued, go on not
   * pushing and not recording, and nothing would ever say otherwise. Asking the
   * server first costs one round trip on the rescue alone (an ordinary move
   * never reaches this) and leaves both halves either done or untouched.
   */
  async function adoptSystemSession(name: string): Promise<boolean> {
    const s = sessions.find((x) => x.name === name);
    if (!s || !isSystemSession(s)) return true;
    try {
      await api.setSessionOrigin(name, ORIGIN_USER);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) showToast("Session no longer exists");
      else showToast("Couldn't take this session out of System");
      return false;
    }
    // The origin the next poll would have brought back, applied now. Without
    // it the card springs straight back into System for the rest of the poll
    // interval: a system session is filed there whatever layout.ungrouped says,
    // which is the whole reason a harness's sessions do not sit in the list.
    setSessions((x) => x.name === name, "origin", ORIGIN_USER);
    return true;
  }

  async function move(name: string, group: string, anchor?: DropAnchor): Promise<void> {
    // System is not a place the layout can put anything: it is derived from
    // each session's origin, and ":system" is a name no project has. Writing it
    // would strip every reference to the card and file it nowhere, so a session
    // dropped back in would reappear in Ungrouped having quietly lost the
    // project it was in.
    if (group === SYSTEM_GROUP_NAME) return;
    // The rescue (design doc §Rescue), before anything is written down.
    if (!(await adoptSystemSession(name))) return;
    // A drop that names a POSITION cannot be honoured while a timestamp is
    // deciding positions: the layout is the only place a position can be
    // written, and the sort would put the card straight back on the next
    // derive. So the list hands ordering back to the user — after freezing what
    // is on screen into the layout, which is what keeps every card the finger
    // did not touch in the seat it already had. A move that names only a GROUP
    // (the card menu's "Move to…", a drop on a group header) asks for no
    // position at all, so it leaves the ordering alone.
    const wasOrder = sessionOrder();
    const before = layout();
    const handBack = wasOrder !== "manual" && !!anchor;
    const frozen = handBack ? captureVisibleOrder(before, model()) : before;
    // Swept-in members occupy rendered positions they have no raw entry for, so
    // nothing can be placed relative to them (nor after them) until they are
    // materialized — Ungrouped's leftovers, and a project's members that only
    // the session record assigned to it.
    const base = materializeGroup(frozen, group, groupRender(group));
    const next = anchor
      ? moveSessionToAnchor(base, name, group, anchor)
      : moveSession(base, name, group);
    // Before the write, not after: saveLayout applies the new layout locally
    // straight away, and a frame rendered while the ordering still ran would
    // sort the dropped card back where it came from.
    if (handBack) opts.setSessionOrder?.("manual");
    const ok = await saveLayout(next);
    // saveLayout rolls the layout back on a failed PUT; the ordering it changed
    // on the way in goes back with it, or the list is left in manual showing an
    // arrangement the server never took.
    if (!ok) {
      if (handBack) opts.setSessionOrder?.(wasOrder);
      return;
    }
    // Recorded AFTER the write, so a drag the server refused leaves nothing on
    // the stack. The FROM position is read out of `base` rather than out of the
    // layout: the freeze and the materialize both run before the move, and a
    // session the layout had never placed acquires its first raw entry there.
    const from = locate(base, name);
    const to = locate(next, name);
    // A drop that landed the card back in the seat it already had changed
    // nothing, and an entry for it would swallow a Cmd+Z press without moving
    // anything. The mode flip counts as a change even when the card did not.
    if (!to || (!handBack && sameLayout(before, next))) return;
    opts.undo?.push({
      kind: "move",
      session: name,
      ...(from ? { fromGroup: from.group } : null),
      fromIndex: from ? from.index : -1,
      toGroup: to.group,
      toIndex: to.index,
      ...(handBack ? { orderBefore: wasOrder } : null),
    });
  }

  /**
   * Change which order the session list comes in.
   *
   * A switch INTO manual freezes what is on screen into the layout first, the
   * same thing a positioned drop does and for the same reason: the layout is
   * the only place an order can be written, so without the freeze every card
   * jumps to whatever seat the raw arrays hold for it, which for a list nobody
   * has arranged lately is an order the user has never seen. The write goes
   * first and the mode second here, the opposite way round from `move`, because
   * the frozen arrangement is invisible until the mode is manual, so this
   * order is the one with no intermediate frame to render.
   *
   * Leaving manual freezes nothing: the arrangement stays in the document and
   * the sort decides the order instead.
   */
  async function setSessionOrderMode(next: SessionOrder): Promise<void> {
    const before = sessionOrder();
    if (next === before) return;
    let captured: OrderModeCapture | undefined;
    if (next === "manual") {
      const over = layout();
      const wrote = captureVisibleOrder(over, model());
      if (!sameLayout(over, wrote)) {
        // saveLayout rolled the layout back and toasted. Changing the mode on
        // top of that would leave the list in manual showing an arrangement
        // the server never took.
        if (!(await saveLayout(wrote))) return;
        captured = { over, wrote };
      }
    }
    opts.setSessionOrder?.(next);
    opts.undo?.push({
      kind: "orderMode",
      before,
      after: next,
      ...(captured ? { capturedLayout: captured } : null),
    });
  }

  async function reorderGroupsTo(from: number, to: number): Promise<void> {
    const cur = layout();
    const token = groupSeqTokens(cur)[from];
    const next = reorderGroups(cur, from, to);
    if (!(await saveLayout(next))) return;
    // No ordering mode rides along with this one, unlike `move` above:
    // `sidebar.order` orders the sessions WITHIN a group, so the group sequence
    // reads the same under all three orderings and a reorder of it never had a
    // reason to hand ordering back.
    if (token === undefined || sameLayout(cur, next)) return;
    opts.undo?.push({ kind: "reorderGroups", from, to, group: token });
  }

  async function createProject(name: string, dir?: string): Promise<boolean> {
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      showToast("Project names use letters, numbers, _ and - (max 32)");
      return false;
    }
    if (layout().projects.some((p) => p.name === n)) {
      showToast(`Project "${n}" already exists`);
      return false;
    }
    if (await saveLayout(addProject(layout(), n, dir))) {
      opts.undo?.push({ kind: "projectCreate", name: n, ...(dir ? { dir } : null) });
    }
    return true;
  }

  async function renameProjectAction(oldName: string, newName: string): Promise<boolean> {
    const n = newName.trim();
    if (!NAME_RE.test(n)) {
      showToast("Invalid project name");
      return false;
    }
    if (n === oldName) return true;
    if (layout().projects.some((p) => p.name === n)) {
      showToast(`Project "${n}" already exists`);
      return false;
    }
    // Collapse is keyed on the project NAME (a per-browser view preference, not
    // layout), so the key has to travel with the rename — and only once the
    // write has landed, or a rollback would leave the two disagreeing.
    const saved = await saveLayout(renameProject(layout(), oldName, n));
    if (saved) {
      collapse.rename(oldName, n);
      opts.undo?.push({ kind: "projectRename", from: oldName, to: n });
    }
    return saved;
  }

  async function deleteProjectAction(name: string): Promise<void> {
    const cur = layout();
    const doomed = cur.projects.find((p) => p.name === name);
    // Its seat among the groups, read before the delete takes it away. Undo
    // puts the project back THERE rather than beside Ungrouped, which is where
    // a project somebody has just named belongs and a returning one does not.
    const index = groupSeqTokens(cur).indexOf("p:" + name);
    if (!(await saveLayout(deleteProject(cur, name)))) return;
    collapse.remove(name);
    if (!doomed) return;
    opts.undo?.push({
      kind: "projectDelete",
      name,
      ...(doomed.dir ? { dir: doomed.dir } : null),
      index,
      // In the order it held them, so undo puts them back in their seats
      // instead of at the end of Ungrouped where the delete tipped them.
      sessions: [...doomed.sessions],
    });
  }

  /**
   * With no argument this is the blanket restore from the newest snapshot. With
   * a selection it restores exactly those sessions from exactly that snapshot —
   * what the restore picker sends.
   */
  async function restore(sel?: RestoreSelection): Promise<void> {
    try {
      await api.restoreSessions(sel);
      showToast(
        sel
          ? `Restoring ${sel.sessions.length} session${sel.sessions.length === 1 ? "" : "s"}…`
          : "Restoring saved sessions…",
        "info",
      );
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        showToast("Not allowed to restore");
      } else {
        showToast("Restore failed");
      }
      return;
    }
    await settleRestore();
  }

  /**
   * Take the placement a restore made server-side.
   *
   * tmux-api puts restored sessions back in their projects and re-stamps their
   * titles (tmux-api/assignments.go placeRestoredSessions), so the server's
   * layout is now ahead of ours. Disarm the write-grace: holding our copy would
   * hide the placement until the next poll, and the conflict check would blame
   * another tab for a change this click asked for.
   */
  async function settleRestore(): Promise<void> {
    graceUntil = 0;
    lastWritten = null;
    await refresh();
  }

  /**
   * Bring a killed session back from the record its kill left.
   *
   * The plain write under `restore` above: it throws rather than swallowing, so
   * the undo handler can turn a failed restore into a sentence a person reads,
   * and it reports nothing when it succeeds.
   *
   * EXCEPT WHILE IT RUNS, which makes this the one press on the undo stack that
   * says anything at all. Every other inverse is a layout PUT or a rename and
   * is done inside a second, so silence is right for them: undo that worked has
   * nothing to tell you (store/undo.ts). This one shells out to tmux-persist,
   * which recreates the session and starts claude cold on the conversation, and
   * it runs on a 30-second deadline of its own for that reason (lib/lobby-api.ts
   * RESTORE_TIMEOUT_MS). Seconds of nothing after Cmd+Z reads as a press that
   * missed, and the second press it invites undoes the entry underneath. So the
   * work gets a sticky toast the same way an upload does (clipboard/attach.ts),
   * cleared in `finally` — a sticky one has no timer to save it, and one left
   * behind by a failure would sit there for the rest of the page life.
   */
  async function resurrect(record: RestoreSelection): Promise<void> {
    const note = toasts.push({
      kind: "loading",
      // Named: a tab can hold several dimmed cards at once, and the person who
      // pressed Cmd+Z is owed which one this is about. A record always names
      // the one session its kill took (lib/lobby-api.ts killSession).
      message: `Bringing ${record.sessions.join(", ")} back…`,
    });
    try {
      await api.restoreSessions(record);
      // Inside the try, so the toast outlives the refresh: it is the card
      // coming back that ends the wait, not the POST answering.
      await settleRestore();
    } finally {
      toasts.dismiss(note);
    }
  }

  /**
   * Put a session's layout entry back at the slot a kill took it from.
   *
   * A gap-filler rather than the main event: the server places a restored
   * session itself, so this writes only when the document came back without
   * it. It also declines for a session that never came back under this name —
   * a restore whose name was taken returns a `-HHMM` suffixed session
   * (types/lobby.ts SnapshotRow), and this slot belongs to the name that was
   * killed.
   */
  async function placeSession(name: string, group: string, index: number): Promise<void> {
    const cur = layout();
    if (locate(cur, name)) return;
    if (!mergedSessions().some((s) => s.name === name)) return;
    await saveLayout(moveSession(cur, name, group, index));
  }

  const listSnapshots = (): Promise<SnapshotList> => api.listSnapshots();
  const getSnapshot = (ts: string): Promise<SnapshotRow[]> => api.getSnapshot(ts);

  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      wake();
      return;
    }
    // Going hidden: drop the turn already on the clock too, so backgrounding
    // costs at most the poll that is genuinely in flight.
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };
  const onOnline = () => wake();
  const onPageHide = () => flushKills();

  function dispose(): void {
    // Before clearing the timer: a poll still out there schedules the next turn
    // when it answers, and would otherwise restart the loop on a dead store.
    polling = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    if (toastTimer) clearTimeout(toastTimer);
    for (const t of burstTimers) clearTimeout(t);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisible);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onPageHide);
    }
    // Any grace window still open goes with the store. A disposed store is a
    // page being torn down or replaced, and `pagehide` is what lands those
    // kills; firing them from here as well would send the DELETE twice.
    for (const rec of pendingKills.values()) if (rec.timer) clearTimeout(rec.timer);
    pendingKills.clear();
    // Watch mode's stack is module-level (store/watchmode.ts has why), so a
    // disposed store has to take it back down or the next one built without a
    // stack would still record switches into this one's.
    if (opts.undo) setWatchUndo(null);
  }

  // The inverses of the layout actions above are in store/undo.layout.ts, one
  // per kind, and reach back in here through these ports. Registered from the
  // store that OWNS the actions, which is what keeps store/undo.ts ignorant of
  // the lobby and the dependency running one way (see its header). Only when
  // the app supplied a stack: registering handlers that nothing can push to
  // would just leave a dead entry pointing at a disposed store.
  if (opts.undo) {
    registerLayoutUndoHandlers({
      layout,
      save: saveLayout,
      order: sessionOrder,
      setOrder: (order) => opts.setSessionOrder?.(order),
      capture: () => captureVisibleOrder(layout(), model()),
      renameCollapse: (from, to) => collapse.rename(from, to),
      removeCollapse: (name) => collapse.remove(name),
    });
    registerTitleUndoHandlers({ sessions: mergedSessions, me, setTitle: applyTitle });
    // Kill and create (store/undo.kill.ts). The two are one pair of operations
    // read in opposite directions, so they share a registry and these ports.
    registerKillUndoHandlers({
      pending: (session) => pendingKills.has(session),
      cancelKill,
      killNow,
      killLater: armKill,
      killInFlight: (session) => killsInFlight.get(session),
      killRecord: (session) => killRecords.get(session),
      resurrect: async (record) => {
        await resurrect(record);
        // The record has been spent. Leaving it would offer to restore the
        // same snapshot over a session that is running again.
        for (const name of record.sessions) killRecords.delete(name);
      },
      // Own sessions only, like every other resolution here: a foreign row's
      // name belongs to another account's tmux server (`renamesBetween`).
      isLive: (session) =>
        mergedSessions().some((x) => x.name === session && (!x.owner || x.owner === me())),
      place: placeSession,
      select: (session) => select(session),
    });
    // Collapse and watch mode (store/undo.local.ts). Watch mode keeps its
    // choice in a localStorage key rather than in a store instance, so it has
    // no constructor to take the stack: this is where it is handed the one
    // App owns, and `dispose` below is where it is taken back.
    registerLocalUndoHandlers({
      collapseUser: me,
      isCollapsed: (group) => collapse.isCollapsed(group),
      setCollapsed: (group, on) => collapse.set(group, on),
      watchChoice: (session, as) => loadWatch(session, as),
      setWatchChoice: (session, choice, as) => applyWatch(session, choice, as),
    });
    setWatchUndo(opts.undo);
  }

  // Not gated on autoStart, unlike the poll's own two listeners below: a kill
  // waiting out its window has to land whether or not this store is polling,
  // and a store built with autoStart off is still a store somebody can kill a
  // session from.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHide);
  }

  if (opts.autoStart !== false) {
    polling = true;
    void pollTick();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
    }
  }

  return {
    whoami,
    me,
    model,
    layout,
    sessions,
    loading,
    loadError,
    polls,
    pollHealth: () => {
      const ok = pollOk();
      const failing = pollFailingSince();
      const at = Date.now();
      return {
        failures: pollFails(),
        lastOkMs: ok === null ? null : at - ok,
        downMs: failing === null ? null : at - failing,
      };
    },
    selected,
    toast,
    collapse,
    undo: opts.undo,
    workingSince,
    refresh,
    hold,
    select,
    deselect,
    create,
    setDock,
    rename,
    kill,
    killing: (name) => killingNames().includes(name),
    // Reads the signal before the map, so a card that renders a countdown is
    // subscribed to arming and disarming. The map itself is not reactive, and
    // the deadline inside it never changes once written, so there is nothing
    // else to track: the clock is the card's own tick.
    killingUntil: (name) =>
      killingNames().includes(name) ? pendingKills.get(name)?.until : undefined,
    takeBackKill,
    move,
    setSessionOrderMode,
    reorderGroupsTo,
    createProject,
    prewarm,
    releasePrewarm,
    renameProjectAction,
    deleteProjectAction,
    restore,
    listSnapshots,
    getSnapshot,
    dispose,
  };
}
