import { createMemo, createSignal, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
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
  renameSessionInLayout,
  reorderGroups,
  sameLayout,
  stabilizeModel,
  type DropAnchor,
  type SidebarModel,
} from "../components/lobby.logic";
import { createCollapseStore, type CollapseStore } from "./collapse";
import { ApiError, lobbyApi, type LobbyApi } from "../lib/lobby-api";
import {
  emptyLayout,
  NAME_RE,
  type Layout,
  type RestoreSelection,
  type Session,
  type SnapshotList,
  type SnapshotRow,
  type Whoami,
} from "../types/lobby";
import { track } from "../telemetry/track";

export interface SelectedSession {
  name: string;
  owner?: string;
}

export interface LobbyStore {
  whoami: Accessor<Whoami | null>;
  me: Accessor<string>;
  model: Accessor<SidebarModel>;
  layout: Accessor<Layout>;
  sessions: Session[];
  loading: Accessor<boolean>;
  loadError: Accessor<string | null>;
  selected: Accessor<SelectedSession | null>;
  toast: Accessor<string | null>;
  /** name of the session card currently being dragged (HTML5 DnD), or null. */
  dragName: Accessor<string | null>;
  setDragName: (name: string | null) => void;
  /** group token ("p:<name>" | "u") of the group header being dragged, or null. */
  dragGroup: Accessor<string | null>;
  setDragGroup: (token: string | null) => void;
  collapse: CollapseStore;
  /** epoch ms a session was first observed running (working-timer anchor). */
  workingSince: (name: string) => number | undefined;

  refresh(): Promise<void>;
  /** Pause polling while the user is mid-interaction (rename/drag/menu) so a
   *  poll can't rebuild the list under them. Returns a release function. */
  hold(): () => void;
  select(name: string, owner?: string): void;
  create(name: string, group: string): Promise<boolean>;
  rename(oldName: string, newName: string): Promise<boolean>;
  kill(name: string): Promise<void>;
  /** Move into `group`; with an anchor, immediately above/below that card. */
  move(name: string, group: string, anchor?: DropAnchor): Promise<void>;
  moveGroupBy(groupName: string, dir: -1 | 1): Promise<void>;
  reorderGroupsTo(from: number, to: number): Promise<void>;
  createProject(name: string, dir?: string): Promise<boolean>;
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
  api?: LobbyApi;
  pollMs?: number;
  autoStart?: boolean;
  initialSelected?: SelectedSession | null;
  /** update the URL hash on select (default true; off in tests). */
  syncHash?: boolean;
  /** surface a store message to the app's toast stack (in ADDITION to the
   *  legacy `toast()` signal). Omitted in tests. */
  notify?: (message: string, kind: NotifyKind) => void;
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
  const [selected, setSelected] = createSignal<SelectedSession | null>(
    opts.initialSelected ?? null,
  );
  const [toast, setToast] = createSignal<string | null>(null);
  const [dragName, setDragName] = createSignal<string | null>(null);
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
  const model = createMemo<SidebarModel>((prev) =>
    stabilizeModel(prev, deriveSidebar(layout(), mergedSessions(), me())),
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
      trackStates(sRes.value);
      // Reconcile by name rather than replace: a re-parsed but unchanged
      // payload must write nothing, or every memo downstream recomputes and
      // <For> re-creates every group and card (taking open menus with it).
      setSessions(reconcile(sRes.value, { key: "name" }));
      // drop optimistic pending that the server now knows about
      const known = new Set(sRes.value.map((s) => s.name));
      const stillPending = pending().filter((p) => !known.has(p.name));
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

  function scheduleNextPoll(outcome: LoadOutcome): void {
    if (!polling) return; // disposed while this poll was still out
    if (outcome === "ok") pollFailures = 0;
    // Stop counting once the ladder has saturated: the delay is capped there
    // anyway, and an overnight outage should not leave 2 ** <hours> behind.
    else if (outcome === "failed" && pollDelay() < maxPollMs) pollFailures += 1;
    // "skipped" is neither: a poll held off mid-drag says nothing about the
    // network, so it leaves the ladder exactly where it was.
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
    if (!polling) return;
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

  function select(name: string, owner?: string): void {
    track("session.selected", { "tl.session": name, "tl.kind": owner ? "foreign" : "own" });
    setSelected({ name, ...(owner ? { owner } : {}) });
    updateHash({ name, owner });
    // auto-expand the group containing this session
    const g = model().groups.find((grp) => grp.sessions.some((s) => s.name === name));
    if (g) collapse.expand(g.kind === "ungrouped" ? ":ungrouped" : g.name);
  }

  function quickRefreshBurst(): void {
    for (const ms of [700, 1600, 3000]) {
      burstTimers.push(setTimeout(() => void refresh(), ms));
    }
  }

  async function create(name: string, group: string): Promise<boolean> {
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      showToast("Session names use letters, numbers, _ and - (max 32)");
      return false;
    }
    if (takenNames().has(n)) {
      showToast(`"${n}" already exists`);
      return false;
    }
    // Creation is a lobby-only act: tmux-api never sees it (the session comes
    // into being when the terminal attaches), so this is the only record of it.
    track("session.created", { "tl.session": n, "tl.to": group || "ungrouped" });
    const nowSec = Math.floor(Date.now() / 1000);
    setPending((p) => [
      ...p,
      { name: n, owner: me(), attached: 0, lastActivity: nowSec, created: nowSec, state: "" },
    ]);
    const saved = await saveLayout(addSessionToGroup(layout(), n, group));
    if (!saved) {
      // The layout PUT is the only record a create makes, so a write that did
      // not land created nothing. Keeping the optimistic card would strand a
      // phantom the poll can never resolve — and pending names count as taken,
      // so it would burn the name too. Selecting still happens: attaching the
      // terminal is what actually brings the session into being, and that path
      // is unaffected when it is only the layout endpoint that is down.
      setPending((p) => p.filter((s) => s.name !== n));
    }
    select(n);
    quickRefreshBurst();
    return saved;
  }

  async function rename(oldName: string, newName: string): Promise<boolean> {
    const n = newName.trim();
    if (!NAME_RE.test(n)) {
      showToast("Invalid session name");
      return false;
    }
    if (n === oldName) return true;
    try {
      await api.renameSession(oldName, n);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) showToast(`"${n}" is taken`);
      else if (e instanceof ApiError && e.status === 404) showToast("Session no longer exists");
      else showToast("Rename failed");
      return false;
    }
    // The backend already renamed the server layout; mirror locally for an
    // instant repaint, then reconcile.
    applyLocalLayout(renameSessionInLayout(layout(), oldName, n));
    setPending((p) => p.map((s) => (s.name === oldName ? { ...s, name: n } : s)));
    if (selected()?.name === oldName) select(n, selected()?.owner);
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

  async function move(name: string, group: string, anchor?: DropAnchor): Promise<void> {
    // Swept-in members occupy rendered positions they have no raw entry for, so
    // nothing can be placed relative to them (nor after them) until they are
    // materialized — Ungrouped's leftovers, and a project's members that only
    // the session record assigned to it.
    const base = materializeGroup(layout(), group, groupRender(group));
    await saveLayout(
      anchor ? moveSessionToAnchor(base, name, group, anchor) : moveSession(base, name, group),
    );
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
    selected,
    toast,
    dragName,
    setDragName,
    dragGroup,
    setDragGroup,
    collapse,
    workingSince,
    refresh,
    hold,
    select,
    create,
    rename,
    kill,
    move,
    moveGroupBy,
    reorderGroupsTo,
    createProject,
    renameProjectAction,
    deleteProjectAction,
    restore,
    listSnapshots,
    getSnapshot,
    dispose,
  };
}
