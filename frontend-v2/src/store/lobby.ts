import { createMemo, createSignal, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { SessionsReport } from "../diagnostics/status";
import {
  addProject,
  addSessionToGroup,
  deleteProject,
  deriveSidebar,
  materializeGroup,
  moveGroup,
  moveSession,
  moveSessionToAnchor,
  removeSessionFromLayout,
  renameProject,
  reorderGroups,
  sameLayout,
  stabilizeModel,
  type DropAnchor,
  type SidebarModel,
} from "../components/lobby.logic";
import {
  applySessionOrder,
  captureVisibleOrder,
  type SessionOrder,
} from "../components/order.logic";
import { createCollapseStore, type CollapseStore } from "./collapse";
import type { DropSpot } from "../mobile/reorder";
import { ApiError, lobbyApi, type LobbyApi } from "../lib/lobby-api";
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
  /** name of the session card currently being dragged (HTML5 DnD), or null. */
  dragName: Accessor<string | null>;
  setDragName: (name: string | null) => void;
  /** group token ("p:<name>" | "u") of the group header being dragged, or null. */
  dragGroup: Accessor<string | null>;
  setDragGroup: (token: string | null) => void;
  /** Where a FINGER-dragged row would land, or null. The mouse has the
   *  browser's own dragover for this; a touch drag has to publish it, because
   *  the row that shows the indicator is never the row being dragged. */
  dropSpot: Accessor<DropSpot | null>;
  setDropSpot: (spot: DropSpot | null) => void;
  collapse: CollapseStore;
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
  /** Retitle a session. The name never moves (ADR-0019). */
  rename(name: string, title: string): Promise<boolean>;
  kill(name: string): Promise<void>;
  /** Move into `group`; with an anchor, immediately above/below that card. */
  move(name: string, group: string, anchor?: DropAnchor): Promise<void>;
  moveGroupBy(groupName: string, dir: -1 | 1): Promise<void>;
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
}

const LAYOUT_GRACE_MS = 4000;

/**
 * Ceiling for the poll's failure backoff. The ladder doubles the base interval
 * per consecutive failure (5s → 10s → 20s) and stops here: far enough back to
 * stop hammering a link already failing to carry the poll, near enough that a
 * lobby left open through an outage catches up within half a minute of the
 * network returning — even in a browser that never fires `online`.
 */
const MAX_POLL_INTERVAL_MS = 30000;

/**
 * Vanilla's STATES_KEY (frontend/index.html `trackStateChanges`): epoch ms at
 * which each live session was FIRST seen in its current Claude state. No
 * backend exposes a real state-change time — a session object carries only
 * created/lastActivity — so this observation is the only anchor the working
 * timer has, and it must outlive the page or every reload restarts a
 * long-running session's clock at 0:00.
 */
const STATES_KEY = "tl:session-states:v1";

interface StateStamp {
  state: string;
  at: number;
}

function loadStates(): Record<string, StateStamp> {
  const out: Record<string, StateStamp> = {};
  try {
    const raw = localStorage.getItem(STATES_KEY);
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
  try {
    localStorage.setItem(STATES_KEY, JSON.stringify(states));
  } catch {
    /* private mode / no storage */
  }
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
  const [dragName, setDragName] = createSignal<string | null>(null);
  const [dropSpot, setDropSpot] = createSignal<DropSpot | null>(null);
  const [dragGroup, setDragGroup] = createSignal<string | null>(null);

  const me = () => whoami()?.osUser ?? "";
  const collapse = createCollapseStore(me);

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
        deriveSidebar(layout(), hideDockedSession(mergedSessions(), layout()), me()),
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
   * Nothing renames any more — a name is an opaque id fixed at creation
   * (ADR-0019) — with ONE exception, and it is the one this exists for.
   * tmux-api's migration renames every session that predates ids, once, on the
   * release that ships them (tmux-api/migrate_ids.go). A tab open at that
   * moment holds a name that is about to stop existing, and it holds it in the
   * iframe's `?arg=`: ttyd spawns a fresh `tmux new-session -A -s <name>` per
   * websocket, so the next reconnect would CREATE the old name as an empty
   * session and leave the person looking at a blank shell while their
   * conversation ran on under the id.
   *
   * tmux's session id is the only thing that survives a rename, so it is what
   * identifies "the same session under a new name". Matching on anything else
   * (creation time, position) would eventually follow the wrong one.
   *
   * Re-selecting is also what drops the stale mount: App prunes a kept
   * SessionView whose name has left the session list, and the selection moving
   * is what makes that effect run (components/App.tsx, prune).
   */
  function followRenamedSelection(prev: readonly Session[], next: readonly Session[]): void {
    const sel = selected();
    if (!sel || sel.owner) return; // foreign sessions are not ours to follow
    if (next.some((s) => s.name === sel.name)) return; // still there
    const id = prev.find((s) => s.name === sel.name)?.id;
    if (!id) return; // never saw an id for it — a server that predates the field
    const moved = next.find((s) => s.id === id);
    if (!moved) return; // genuinely gone, not renamed
    applySelection(moved.name, undefined);
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
      // server-side until the iframe attaches and ttyd runs tmux-user-attach,
      // and GET /sessions is behind a 5-second cache, so the burst polls at
      // 700/1600/3000ms routinely report a list without it — pruning against
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
      const hash = sel ? "#" + sel.name + (sel.owner && sel.owner !== me() ? "@" + sel.owner : "") : "";
      window.history.replaceState(null, "", window.location.pathname + window.location.search + hash);
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
   * at all — the session comes into being when the terminal iframe attaches and
   * ttyd runs `tmux new-session -A` — so the browser has to have a name before
   * anything else can. It is an opaque id and it never changes (ADR-0019).
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
  async function create(
    text: string,
    group: string,
    kind: CreateKind = "prompt",
  ): Promise<string> {
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
    // Stamping the title needs the session to EXIST, and only the iframe's
    // attach creates it. The refresh burst is already the "has it appeared
    // yet" poll, so the stamp rides along with it.
    //
    // Only for a NAME. Stamping a prompt's first line would set `@title`, and
    // the auto-title rule fires only while `@title` is unset — the placeholder
    // would become permanent and Claude's summary would never reach the card.
    if (kind === "name" && t !== "") void stampTitleWhenAlive(n, t);
    quickRefreshBurst();
    return n;
  }

  /**
   * Stamp a title onto a session the lobby has just asked ttyd to create.
   *
   * Retries on the same cadence as quickRefreshBurst because the session does
   * not exist until the iframe's WebSocket lands, and a 404 here means "not yet"
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
   * Clear a session's title so its card shows its name again.
   *
   * Emptying the rename box is the only way back to a bare name, and it is the
   * state every session that predates titles is already in. The NAME is left
   * exactly where it is — deriving one from an empty title would mean renaming
   * a running session to something arbitrary.
   */
  async function clearTitle(name: string): Promise<boolean> {
    // Clearing hands the session back to its summary, so the placeholder goes
    // too — leaving it would put the prompt line straight back on the card.
    forgetPromptLine(name);
    try {
      await api.setSessionTitle(name, "");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) showToast("Session no longer exists");
      else showToast("Rename failed");
      return false;
    }
    await refresh();
    return true;
  }

  /**
   * Retitle a session: set the text everyone reads.
   *
   * Only the title moves. The name is an opaque id fixed at creation
   * (ADR-0019), so nothing downstream is keyed by anything this touches: no
   * layout to mirror, no per-browser record to carry, and no re-navigation of
   * the terminal iframe. Two sessions may end up reading the same, which is
   * fine now that no name is derived from the text.
   */
  async function rename(name: string, title: string): Promise<boolean> {
    const t = cleanTitle(title);
    if (t === "") {
      // An empty title hands the session back to its summary.
      return clearTitle(name);
    }
    try {
      await api.setSessionTitle(name, t);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) showToast("Session no longer exists");
      else showToast("Rename failed");
      return false;
    }
    await refresh();
    return true;
  }

  async function kill(name: string): Promise<void> {
    try {
      await api.killSession(name);
    } catch {
      showToast("Couldn't kill session");
      return;
    }
    // The backend drops it from the server layout on a UI kill — but only when
    // tmux still had the session; a kill that 404s (already dead) leaves the
    // entry behind, and the next poll would pull it back. PUT it ourselves.
    await saveLayout(removeSessionFromLayout(layout(), name));
    setSessions((prev) => prev.filter((s) => s.name !== name));
    setPending((p) => p.filter((s) => s.name !== name));
    if (selected()?.name === name) {
      setSelected(null);
      updateHash(null);
    }
    await refresh();
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

  async function move(name: string, group: string, anchor?: DropAnchor): Promise<void> {
    // A drop that names a POSITION cannot be honoured while a timestamp is
    // deciding positions: the layout is the only place a position can be
    // written, and the sort would put the card straight back on the next
    // derive. So the list hands ordering back to the user — after freezing what
    // is on screen into the layout, which is what keeps every card the finger
    // did not touch in the seat it already had. A move that names only a GROUP
    // (the card menu's "Move to…", a drop on a group header) asks for no
    // position at all, so it leaves the ordering alone.
    const wasOrder = sessionOrder();
    const handBack = wasOrder !== "manual" && !!anchor;
    const frozen = handBack ? captureVisibleOrder(layout(), model()) : layout();
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
    if (!ok && handBack) opts.setSessionOrder?.(wasOrder);
  }

  async function moveGroupBy(groupName: string, dir: -1 | 1): Promise<void> {
    await saveLayout(moveGroup(layout(), groupName, dir));
  }

  async function reorderGroupsTo(from: number, to: number): Promise<void> {
    await saveLayout(reorderGroups(layout(), from, to));
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
    await saveLayout(addProject(layout(), n, dir));
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
    if (saved) collapse.rename(oldName, n);
    return saved;
  }

  async function deleteProjectAction(name: string): Promise<void> {
    if (await saveLayout(deleteProject(layout(), name))) collapse.remove(name);
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
    // tmux-api places restored sessions back in their projects, so the server's
    // layout is now ahead of ours. Disarm the write-grace: holding our copy
    // would hide the placement until the next poll, and the conflict check
    // would blame another tab for a change this click asked for.
    graceUntil = 0;
    lastWritten = null;
    await refresh();
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
    }
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
    dragName,
    setDragName,
    dropSpot,
    setDropSpot,
    dragGroup,
    setDragGroup,
    collapse,
    workingSince,
    refresh,
    hold,
    select,
    deselect,
    create,
    setDock,
    rename,
    kill,
    move,
    moveGroupBy,
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
