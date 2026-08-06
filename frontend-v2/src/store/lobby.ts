import { createMemo, createSignal, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  addProject,
  addSessionToGroup,
  deleteProject,
  deriveSidebar,
  materializeUngrouped,
  moveGroup,
  moveSession,
  moveSessionToAnchor,
  removeSessionFromLayout,
  renameProject,
  renameSessionInLayout,
  reorderGroups,
  sameLayout,
  type DropAnchor,
  type SidebarModel,
} from "../components/lobby.logic";
import { createCollapseStore, type CollapseStore } from "./collapse";
import { ApiError, lobbyApi, type LobbyApi } from "../lib/lobby-api";
import { emptyLayout, NAME_RE, type Layout, type Session, type Whoami } from "../types/lobby";
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
  restore(): Promise<void>;
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
  let holds = 0;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const burstTimers: ReturnType<typeof setTimeout>[] = [];

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

  const model = createMemo<SidebarModel>(() => deriveSidebar(layout(), mergedSessions(), me()));

  const ungroupedRender = (): string[] =>
    model()
      .groups.find((g) => g.kind === "ungrouped")
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

  async function refresh(): Promise<void> {
    // Mid-interaction (rename/drag/menu): don't rebuild the list under the user.
    if (holds > 0) return;
    let gotWhoami = whoami();
    if (!gotWhoami) {
      try {
        gotWhoami = await api.whoami();
        setWhoami(gotWhoami);
      } catch (e) {
        setLoadError(e instanceof ApiError ? `Access denied (HTTP ${e.status})` : "Failed to load");
        setLoading(false);
        return;
      }
    }
    const [sRes, lRes] = await Promise.allSettled([api.listSessions(), api.getLayout()]);
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
      setLayout(lRes.value);
    }
    setLoading(false);
  }

  function applyLocalLayout(next: Layout): void {
    setLayout(next);
    graceUntil = Date.now() + LAYOUT_GRACE_MS;
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
    // Ungrouped's leftovers occupy rendered positions they have no raw entry
    // for, so nothing can be placed relative to them (nor after them) until
    // they are materialized.
    const base = group === "" ? materializeUngrouped(layout(), ungroupedRender()) : layout();
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

  async function restore(): Promise<void> {
    try {
      await api.restoreSessions();
      showToast("Restoring saved sessions…", "info");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        showToast("Not allowed to restore");
      } else {
        showToast("Restore failed");
      }
      return;
    }
    await refresh();
  }

  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      void refresh();
    }
  };

  function dispose(): void {
    if (pollTimer) clearInterval(pollTimer);
    if (toastTimer) clearTimeout(toastTimer);
    for (const t of burstTimers) clearTimeout(t);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisible);
    }
  }

  if (opts.autoStart !== false) {
    void refresh();
    pollTimer = setInterval(() => void refresh(), pollMs);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
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
    dispose,
  };
}
