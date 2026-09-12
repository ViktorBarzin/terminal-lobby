/**
 * tmux-api client — the lobby's data + mutation surface. Every call is
 * same-origin (the ingress injects X-Authentik-Username) and goes under the
 * /api prefix (apiUrl). Shapes mirror tmux-api/*.go. Errors throw an
 * ApiError carrying the HTTP status so callers can branch (409 taken, 404 gone).
 */
import { noteNetworkId } from "../diagnostics/network";
import type {
  ChannelState,
  MachinePoint,
  MachineReport,
  MachineResource,
  MachineTier,
} from "../diagnostics/status";
import { NET_HEADER, apiUrl } from "./config";
import {
  emptyLayout,
  type Layout,
  type LayoutProject,
  type RestoreSelection,
  type Session,
  type SnapshotList,
  type SnapshotRow,
  type Whoami,
  NAME_RE,
} from "../types/lobby";

import { REQUEST_TIMEOUT_MS, withDeadline } from "./http";
export { REQUEST_TIMEOUT_MS, withDeadline };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The deadline for POST /restore, which is not like the others: it shells out
 * to `tmux-persist restore <user>` and recreates every dead session in the
 * caller's manifest one tmux command at a time. A long manifest can outrun the
 * ordinary cap, and cutting it off there would report "Restore failed" for work
 * the server goes on to finish.
 */
export const RESTORE_TIMEOUT_MS = 30000;

async function req(
  path: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  // `signal` after the spread on purpose: a caller's own signal is merged into
  // the deadline by withDeadline, never dropped by it.
  const res = await fetch(apiUrl(path), {
    credentials: "same-origin",
    ...init,
    signal: withDeadline(timeoutMs, init?.signal),
  });
  // Which network this request went over, stamped by tmux-api on a response the
  // app was making anyway (netinfo.go). Read here rather than at one call site
  // so the freshest answer comes from whichever request happened last — in
  // practice the 5s /sessions poll. Costs nothing and adds no request.
  noteNetworkId(res.headers.get(NET_HEADER));
  // And how busy the BOX is, on exactly the same ride (tmux-api/health.go).
  // One more header on a response already in flight, read in the one place
  // every lobby call passes through, which is what lets the sixth channel cost
  // no request of its own in the common case. Nothing it does can throw: a
  // header about how busy the box is must never become the reason a session
  // list fails to load. See the machine-health section at the foot of this file.
  noteMachineHeader(res.headers.get(MACHINE_HEADER));
  return res;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await req(path, init);
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** GET /api/whoami → {authentik, osUser}. */
export function whoami(): Promise<Whoami> {
  return json<Whoami>("/whoami", { cache: "no-store" });
}

/**
 * GET /api/users → every mapped OS user, sorted. Already served for the share
 * and add-member pickers; the Settings act-as picker is a third reader.
 * Degrades to an empty list, which simply leaves the picker with nothing to
 * offer rather than breaking Settings.
 *
 * Deliberately NOT part of the injectable LobbyApi surface: only the Settings
 * picker reads it, from the concrete client, so adding it to the interface
 * would mean a stub in every store fake for a call none of them make.
 */
export async function listUsers(): Promise<string[]> {
  try {
    const arr = await json<string[]>("/users", { cache: "no-store" });
    return Array.isArray(arr) ? arr.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/**
 * GET /api/new-commands → {key: canRun} for the new-session dropdown.
 *
 * Degrades to {} on anything at all, which the callers read as "no opinion" and
 * so leaves every option enabled. Not part of the injectable LobbyApi surface,
 * for the same reason listUsers is not: two components read it from the
 * concrete client, and putting it in the interface would mean a stub in every
 * store fake for a call none of them make.
 */
export async function availableCommands(): Promise<Record<string, boolean>> {
  try {
    const m = await json<Record<string, boolean>>("/new-commands", { cache: "no-store" });
    if (!m || typeof m !== "object" || Array.isArray(m)) return {};
    return Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "boolean"));
  } catch {
    return {};
  }
}

/** GET /api/sessions → own + foreign sessions. */
export async function listSessions(): Promise<Session[]> {
  const arr = await json<Session[]>("/sessions", { cache: "no-store" });
  return Array.isArray(arr) ? arr : [];
}

/** GET /api/layout, normalized like the vanilla fetchLayout (defensive defaults). */
export async function getLayout(): Promise<Layout> {
  const l = await json<Partial<Layout>>("/layout", { cache: "no-store" });
  return normalizeLayout(l);
}

/** Normalize a raw layout doc: arrays defaulted, ungroupedIndex clamped, dock
 *  validated-or-dropped. Exported for testing. */
export function normalizeLayout(raw: Partial<Layout> | null | undefined): Layout {
  const base = emptyLayout();
  if (!raw || typeof raw !== "object") return base;
  const projects: LayoutProject[] = Array.isArray(raw.projects)
    ? raw.projects
        .filter((p): p is LayoutProject => !!p && typeof p.name === "string")
        .map((p) => ({
          name: p.name,
          sessions: Array.isArray(p.sessions)
            ? p.sessions.filter((s) => typeof s === "string")
            : [],
          ...(typeof p.dir === "string" && p.dir ? { dir: p.dir } : {}),
        }))
    : [];
  const ungrouped = Array.isArray(raw.ungrouped)
    ? raw.ungrouped.filter((s) => typeof s === "string")
    : [];
  const ui = Number.isInteger(raw.ungroupedIndex)
    ? Math.max(0, Math.min(raw.ungroupedIndex as number, projects.length))
    : 0;
  const l: Layout = {
    version: base.version,
    projects,
    ungrouped,
    ungroupedIndex: ui,
  };
  const d = raw.dock;
  if (d && typeof d === "object" && typeof d.session === "string" && NAME_RE.test(d.session)) {
    l.dock = {
      session: d.session,
      visible: d.visible !== false,
      ...(typeof d.dir === "string" && d.dir ? { dir: d.dir } : {}),
    };
  }
  return l;
}

/** PUT /api/layout — whole-document, last-writer-wins. Throws on non-204. */
export async function putLayout(layout: Layout): Promise<void> {
  const res = await req("/layout", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(layout),
  });
  if (!res.ok) throw new ApiError(res.status, `layout PUT HTTP ${res.status}`);
}

/**
 * DELETE /api/sessions/{name} — kill a session (200/404).
 *
 * The answer is what it takes to put the session back: tmux-api snapshots
 * before it kills and replies `{"resurrect": {snapshot, sessions}}`, whose
 * inner half is exactly POST /restore's body (types/lobby.ts RestoreSelection),
 * so undo posts back what it was handed. That is what makes a kill undoable
 * once its grace window has elapsed (store/undo.kill.ts).
 *
 * A server with no record to give sends the field empty, and one older than
 * this feature still answers 204 with no body at all. Both read null here,
 * which the undo handler reports as a kill it cannot take back rather than
 * pretending.
 *
 * A 404 THROWS, like every other non-2xx, and the caller decides what it
 * means: no session of that name is there, which is not the same as one this
 * call killed. The store treats the two differently — it still drops the local
 * layout entry, since the name really is gone, and it reports the kill as not
 * having happened, so undoing a create whose session tmux-api has since
 * renamed (ADR-0022) refuses instead of reporting a kill that landed on
 * nothing while the session went on running (store/lobby.ts sendKill).
 */
export async function killSession(name: string): Promise<RestoreSelection | null> {
  const res = await req(`/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(res.status, `kill HTTP ${res.status}`);
  return await asRestoreSelection(res);
}

/** The response body's resurrect record, or null when there is not one — a 204,
 *  an empty body, a kill nothing snapshotted, a server that answers something
 *  else. Nothing here is worth failing a kill that has already happened over. */
async function asRestoreSelection(res: Response): Promise<RestoreSelection | null> {
  if (res.status === 204) return null;
  try {
    const body: unknown = await res.json();
    if (!body || typeof body !== "object") return null;
    const rec = (body as { resurrect?: unknown }).resurrect;
    if (!rec || typeof rec !== "object") return null;
    const { snapshot, sessions } = rec as { snapshot?: unknown; sessions?: unknown };
    if (typeof snapshot !== "string" || snapshot === "") return null;
    if (!Array.isArray(sessions)) return null;
    const names = sessions.filter((s): s is string => typeof s === "string");
    return names.length > 0 ? { snapshot, sessions: names } : null;
  } catch {
    return null; // no body, or not JSON
  }
}

/**
 * The same DELETE, fired on the way out of the page.
 *
 * `keepalive` is the whole point: a kill inside its grace window still has to
 * land when the tab is closed or reloaded (store/lobby.ts flushKills), and an
 * ordinary fetch is cancelled with the document before it can settle. Built
 * through `apiUrl` like every other call, so `?as=` rides along, and there is
 * no deadline on it — the page is going away, so nothing here could act on a
 * timeout anyway.
 *
 * Nothing to await and nothing to report: `pagehide` runs synchronously and the
 * document is gone by the time an answer could arrive. The record a kill would
 * normally hand back is lost with it, which is why an undo after a reload
 * refuses instead of resurrecting.
 */
export function killSessionKeepalive(name: string): void {
  try {
    void fetch(apiUrl(`/sessions/${encodeURIComponent(name)}`), {
      method: "DELETE",
      credentials: "same-origin",
      keepalive: true,
    });
  } catch {
    /* a browser that refuses the request on unload: see the header */
  }
}

/**
 * What `@tl_origin` reads on a session the lobby's own create path made — the
 * only value this client ever writes, and the one the store stamps on an
 * optimistic card so a freshly created session is not read as a stray.
 *
 * The string exists in three places and cannot be shared between them: here,
 * `ORIGIN_USER` in components/lobby.logic.ts (which stays free of imports from
 * the client layer), and `originUser` in tmux-api/origin.go. A fourth spelling
 * would 400 at the server and read as a system session forever on the client,
 * so test/rescue.test.ts asserts the two client copies against each other.
 */
export const ORIGIN_USER = "user";

/**
 * POST /api/sessions/{name}/origin {origin} — the rescue
 * (docs/plans/2026-09-06-test-session-origin-design.md).
 *
 * Dragging a card out of the System group adopts the session: it stops being a
 * system session on the SERVER, which is what makes it push, record and survive
 * a reload as a person's own. The arrangement alone cannot say it — the sidebar
 * files a session by the origin tmux reports, so a layout that disagreed would
 * lose the argument on the next poll.
 *
 * Throws on anything but 204, 404 included, and that is the difference from
 * killSession: a kill that 404s got what it wanted, whereas an adoption of a
 * session that is no longer there did not happen at all, and the caller has a
 * layout write to hold back on the strength of it.
 */
export async function setSessionOrigin(name: string, origin: string): Promise<void> {
  const res = await req(`/sessions/${encodeURIComponent(name)}/origin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin }),
  });
  if (!res.ok) throw new ApiError(res.status, `set origin HTTP ${res.status}`);
}

/**
 * POST /api/sessions/{name}/title {title} — 204/404/400.
 *
 * Every retitle. The server derives the tmux name from the title and renames
 * the session (ADR-0022), so the caller should refresh afterwards rather than
 * assume the name it sent still resolves. Three callers: stamping
 * a title onto a session the lobby has just created (creation reaches no
 * server, so this is the first the API hears of it), editing one from a card,
 * and clearing one back to nothing so the session takes the next summary.
 */
export async function setSessionTitle(name: string, title: string): Promise<void> {
  const res = await req(`/sessions/${encodeURIComponent(name)}/title`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new ApiError(res.status, `set title HTTP ${res.status}`);
}

/**
 * POST /api/sessions/{name}/grid {cols, rows} — the device reading this session
 * says what size it is, so a pinned tmux window can follow it.
 *
 * WHY THIS EXISTS. tmux sizes a window from its clients, and a session any
 * read-only attach has pinned re-reads them on exactly three events: a client
 * attaching, detaching or resizing. Switching back to a session the lobby kept
 * mounted is none of the three — the ttyd client never detached and its pty is
 * the size it always was — so the window keeps whatever the last device to
 * attach left it at. Measured 2026-09-06: a desktop reading `f1` at 231x62 sat
 * inside a 60-column window because a phone had joined, and reloading the page
 * was the only fix, because a reload is an attach.
 *
 * A HINT, like `prewarm`: the server answers 204 whether it moved anything or
 * not, leaves an unpinned session to tmux, and refuses when nobody is driving.
 * Every failure here is swallowed. The terminal is readable either way — just
 * at the wrong width — so none of it is worth interrupting anyone for.
 *
 * NEVER CALL THIS WHILE WATCHING. A read-only client taking the size is the one
 * thing the pin exists to prevent, and the server cannot tell two devices of the
 * same person apart: they arrive with one identity header and neither carries
 * the tmux client it belongs to. The caller declining is what keeps the promise.
 */
export async function setSessionGrid(name: string, cols: number, rows: number): Promise<void> {
  try {
    await req(`/sessions/${encodeURIComponent(name)}/grid`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cols, rows }),
    });
  } catch {
    /* best effort, see above */
  }
}

/**
 * POST/DELETE /api/sessions/prewarm — ask for, or release, a Claude session
 * started ahead of the create it is for.
 *
 * Claude's own boot is ~2.4s of the ~2.7s a new session used to take, and
 * opening a create input happens seconds before the name is typed, with the
 * directory already known. So the boot is started on the guess and the ordinary
 * attach adopts it, which turns the wait into a ~9ms tmux rename.
 *
 * A HINT, never a promise: the server answers 204 whether it warmed anything or
 * refused (unknown directory, too many outstanding guesses), and every failure
 * here is swallowed. The create this precedes works either way — just without
 * the head start — so nothing about it is worth interrupting the user for.
 */
export async function prewarm(dir: string): Promise<void> {
  try {
    await req("/sessions/prewarm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir }),
    });
  } catch {
    /* best-effort */
  }
}

/** Release a guess that came to nothing, so its ~530MB is not held until the
 *  server's TTL collects it. Called when the create input closes without
 *  creating; the TTL remains the backstop for a closed tab. */
export async function releasePrewarm(dir: string): Promise<void> {
  try {
    await req("/sessions/prewarm", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir }),
    });
  } catch {
    /* best-effort */
  }
}

/** POST /api/restore — recreate saved-but-dead sessions. Runs on the longer
 *  RESTORE_TIMEOUT_MS deadline: the server recreates them one tmux command at
 *  a time.
 *
 *  With no argument this is the blanket restore from the newest snapshot, as
 *  before. With a selection it restores exactly those sessions from exactly
 *  that snapshot — what the restore picker sends. */
export async function restoreSessions(sel?: RestoreSelection): Promise<void> {
  const init: RequestInit = sel
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sel),
      }
    : { method: "POST" };
  const res = await req("/restore", init, RESTORE_TIMEOUT_MS);
  if (!res.ok) throw new ApiError(res.status, `restore HTTP ${res.status}`);
}

/** GET /api/snapshots → the caller's snapshot series, newest first, annotated
 *  against what is running now, and — from a server that supports it — the
 *  newest snapshot's rows already resolved, so opening the picker is one
 *  request instead of two that cannot overlap. */
export async function listSnapshots(): Promise<SnapshotList> {
  return json<SnapshotList>("/snapshots", { cache: "no-store" });
}

/** GET /api/snapshots/{ts} → one snapshot resolved against the live session
 *  set: per row, what restoring it would do and whether it starts ticked.
 *  Resolution is server-side so this and the vanilla lobby cannot drift. */
export async function getSnapshot(ts: string): Promise<SnapshotRow[]> {
  const rows = await json<SnapshotRow[]>(`/snapshots/${encodeURIComponent(ts)}`, {
    cache: "no-store",
  });
  return Array.isArray(rows) ? rows : [];
}

/** The full client surface, bundled so a store/test can inject a fake. */
export interface LobbyApi {
  whoami(): Promise<Whoami>;
  listSessions(): Promise<Session[]>;
  getLayout(): Promise<Layout>;
  putLayout(layout: Layout): Promise<void>;
  /**
   * Kill a session, answering the record that puts it back where the server
   * snapshots first (see the function). `void` is in the union so a client or a
   * test double that has nothing to say satisfies this unchanged.
   */
  killSession(name: string): Promise<RestoreSelection | null | void>;
  /** The kill that has to survive the page (see `killSessionKeepalive`).
   *  Optional: a double without it simply flushes nothing on the way out. */
  killSessionKeepalive?(name: string): void;
  setSessionTitle(name: string, title: string): Promise<void>;
  setSessionOrigin(name: string, origin: string): Promise<void>;
  restoreSessions(sel?: RestoreSelection): Promise<void>;
  listSnapshots(): Promise<SnapshotList>;
  getSnapshot(ts: string): Promise<SnapshotRow[]>;
  prewarm(dir: string): Promise<void>;
  releasePrewarm(dir: string): Promise<void>;
}

export const lobbyApi: LobbyApi = {
  whoami,
  listSessions,
  getLayout,
  putLayout,
  killSession,
  killSessionKeepalive,
  setSessionTitle,
  setSessionOrigin,
  restoreSessions,
  listSnapshots,
  getSnapshot,
  prewarm,
  releasePrewarm,
};

// ---- machine health --------------------------------------------------------

/*
 * Whether the BOX is the reason a terminal feels slow — the sixth channel's
 * half of the wire (ADR-0027; tmux-api/health.go on the other side).
 *
 * IT LIVES WITH THE CLIENT BECAUSE IT ARRIVES WITH THE CLIENT. The verdict is a
 * tmux-api fact riding tmux-api's responses, and `req` above is the one place
 * that sees every one of them. diagnostics/network.ts is the sibling to read:
 * same shape, same reason, same module-state-and-listeners arrangement, because
 * the consumer of a header stamped on somebody else's request cannot be a
 * component and has nobody to be pushed from. The channel it feeds is in
 * diagnostics/status-store.ts, which subscribes here.
 *
 * TWO WAYS IN, AND ONLY THE SECOND COSTS ANYTHING.
 *  - `X-TL-Machine`, on responses the app already asks for. The lobby polls
 *    /sessions every five seconds, so while anyone is looking at the tab the
 *    verdict costs no request of its own. That is the hot path, and it is the
 *    whole reason this feature adds zero requests in the common case.
 *  - `GET /machine`, which the Right now panel switches on while it is open,
 *    for the two things a header cannot do: carry the hour the sparkline draws,
 *    and keep asking independently of a session poll that backs off to 30s
 *    under failure and parks entirely when the tab is hidden.
 *
 * NOTHING HERE THROWS, AND NOTHING HERE BLANKS A GOOD READING. A header that
 * did not parse, a response carrying none, a request that failed — none of
 * those is news about the box. Throwing on any of them would fail the call the
 * header rode on, and a header about how busy the box is must never be the
 * reason a session list does not load.
 */

/** The header tmux-api stamps its verdict on, so the sixth channel rides the
 *  poll the client already runs (health.go, and netinfo.go's pattern). */
export const MACHINE_HEADER = "X-TL-Machine";

/**
 * Built through `apiUrl` like every other call. API_BASE alone is EMPTY unless
 * a `?api=` override is present — the service prefix lives in apiUrl — so a URL
 * built by hand asks the SITE ROOT. That shipped once already, in the /health
 * probe, which 404ed and reported "the API is not answering" on a perfectly
 * healthy box: a diagnostic manufacturing the fault it exists to report. The
 * browser sees /api/sessions/machine; tmux-api serves /machine, the ingress
 * having stripped the prefix.
 */
const MACHINE_PATH = "/machine";

/**
 * How often the panel's direct read asks.
 *
 * The same five seconds the session poll uses, which bounds how stale the
 * figures can be at half of the server's ten-second sampling interval. Matching
 * the sampler at ten would be cheaper and wrong: the phase between the two is
 * arbitrary, so the panel would show numbers up to ten seconds old at the one
 * moment somebody is watching them move.
 */
export const MACHINE_POLL_MS = 5000;

/**
 * The states the box can report. `down` is absent on purpose, and a verdict
 * claiming it is refused rather than clamped: red means "you are disconnected"
 * everywhere in this UI, a box that answered a request is not disconnected, and
 * tmux-api never sends it. machineChannel clamps anything that reaches it by
 * another route, so this is the outer of two guards rather than a second
 * opinion about what red means.
 */
const isMachineState = (v: unknown): v is Exclude<ChannelState, "down"> =>
  v === "working" || v === "degraded" || v === "unknown";

const isMachineTier = (v: unknown): v is MachineTier =>
  v === "fine" || v === "busy" || v === "very-busy";

const isMachineResource = (v: unknown): v is MachineResource =>
  v === "cpu" || v === "io" || v === "memory" || v === "load";

/** A figure off the wire, or zero. Strict about the fields that decide a colour
 *  and tolerant about the ones that are only printed: a renamed or null figure
 *  should cost its own number, not the whole row. */
function wireNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Which reading this is: /proc/pressure, or the load-average fallback a kernel
 * without it leaves. The row's own words branch on it — "Fine" against "Fine,
 * by load average" — so it is the one string here that changes what a person
 * reads.
 *
 * THE CONTRACT IS "load", and tmux-api sends it (`healthSourceLoad`,
 * health.go). "fallback" is read as the same thing because that is what the Go
 * constant held while both halves of this feature were being written. It is a
 * BRIDGE, not a second spelling to keep alive: a client and a server from
 * either side of that rename still agree about which instrument answered.
 * Deleting it costs nothing once no deployed tmux-api predates the rename.
 */
function wireMachineSource(v: unknown): MachineReport["source"] {
  if (v === "psi") return "psi";
  if (v === "load" || v === "fallback") return "load";
  return "unknown";
}

/**
 * Validate-or-drop one verdict — the same bytes whether they came off the
 * header or out of the endpoint's `verdict` field, which is what keeps those
 * two from drifting.
 *
 * Null is what leaves the channel `unknown`, never healthy, which is the
 * invariant the whole status model rests on (diagnostics/status.ts).
 */
export function parseMachineReport(raw: unknown): MachineReport | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isMachineState(o.state)) return null;
  return {
    state: o.state,
    // A verdict that reached degraded without saying how busy gets the quieter
    // of the two sentences, which is all the threshold it crossed supports —
    // status.ts makes the same choice at the other end, for the same reason.
    tier: isMachineTier(o.tier) ? o.tier : o.state === "working" ? "fine" : "busy",
    // Unset on the wire exactly when the verdict is `unknown`: there is no
    // window to name a resource over yet, and machineChannel returns before
    // reading it there. The type has no "none" to fall back to.
    worst: isMachineResource(o.worst) ? o.worst : "cpu",
    cpuPct: wireNum(o.cpuPct),
    ioPct: wireNum(o.ioPct),
    memPct: wireNum(o.memPct),
    load1: wireNum(o.load1),
    // Floored at one core because the panel divides by it, and an Infinity
    // where a number belongs is the sort of thing a reader remembers.
    nproc: Math.max(1, Math.round(wireNum(o.nproc))),
    memAvailableMb: wireNum(o.memAvailableMb),
    memTotalMb: wireNum(o.memTotalMb),
    windowSeconds: wireNum(o.windowSeconds),
    // Only an explicit `false` claims a full ten-minute window. Anything else
    // leaves the reading marked partial, which is the direction that cannot
    // overstate what was actually measured.
    partialWindow: o.partialWindow !== false,
    source: wireMachineSource(o.source),
  };
}

/**
 * The hour behind the verdict, as tmux-api's `series()` marshals it.
 *
 * An entry with no readable RESOURCE is dropped rather than drawn, because the
 * line is the part of the row a reader takes in without reading it and a point
 * invented from junk says "the box was fine then" about a moment nobody
 * measured. Its figures are tolerated at zero, like the verdict's: a point that
 * knows which resource it is about is still a point.
 */
export function parseMachineSeries(raw: unknown): MachinePoint[] {
  if (!Array.isArray(raw)) return [];
  const out: MachinePoint[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const o = entry as Record<string, unknown>;
    if (!isMachineResource(o.res)) continue;
    out.push({ at: wireNum(o.at), res: o.res, pct: wireNum(o.pct), ofLimit: wireNum(o.ofLimit) });
  }
  return out;
}

let machineReport: MachineReport | null = null;
let machinePoints: readonly MachinePoint[] = [];
const machineListeners = new Set<(r: MachineReport | null) => void>();

/** The last verdict this tab was told, or null before there is one. */
export function currentMachineReport(): MachineReport | null {
  return machineReport;
}

/** The hour behind it. Empty until a direct read has fetched one, because no
 *  header could carry a series. */
export function currentMachineSeries(): readonly MachinePoint[] {
  return machinePoints;
}

/** Hear about readings as they land; returns the unsubscribe. */
export function onMachineReport(fn: (r: MachineReport | null) => void): () => void {
  machineListeners.add(fn);
  return () => void machineListeners.delete(fn);
}

/**
 * Record a verdict that parsed, and tell everyone listening.
 *
 * A reading that did not parse is IGNORED rather than stored. Silence says
 * nothing about the box, and most responses in the life of a tab carry no
 * header at all — every call to a service that is not tmux-api, and every
 * answer from a tmux-api too old to stamp one. Treating those as "no longer
 * busy" would flicker the row green on whichever request happened to land last.
 */
function noteMachineReport(report: MachineReport | null, series?: readonly MachinePoint[]): void {
  if (!report) return;
  machineReport = report;
  // The hour is published with the verdict it arrived with, so the graph and
  // the figures beside it are never drawn from two different moments. A header
  // passes none and leaves the hour exactly as it was.
  if (series) machinePoints = series;
  for (const fn of machineListeners) {
    try {
      fn(report);
    } catch {
      /* one bad subscriber must not stop the others hearing about a reading */
    }
  }
}

/** The header off one response, whatever it turns out to contain. */
export function noteMachineHeader(value: string | null | undefined): void {
  if (!value) return;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return; // not JSON at all, and not worth failing the response it rode on
  }
  noteMachineReport(parseMachineReport(raw));
}

/**
 * Ask for a reading directly — the panel's poll, and Run check's sixth probe.
 *
 * THE BODY IS `{verdict, series}`, nested (tmux-api/machine.go). The verdict is
 * the same bytes the header carries, so one parser serves both paths and they
 * cannot drift; reading the verdict's fields off the envelope instead finds no
 * `state` there and drops every reading from a server that is answering
 * correctly.
 *
 * IT NEVER REJECTS, and that is load-bearing rather than tidy. `runCheck` turns
 * a thrown probe into a `down` row, and `down` is the one state this channel
 * cannot have: a box that did not answer a direct read is a row that is not
 * reporting, and if the API really is unreachable the session-list row is
 * already saying so on its own line. So every failure becomes null, which
 * machineChannel renders as `unknown`.
 */
export async function fetchMachine(
  f: typeof fetch = fetch.bind(globalThis),
  signal?: AbortSignal,
): Promise<MachineReport | null> {
  try {
    const res = await f(apiUrl(MACHINE_PATH), {
      credentials: "same-origin",
      cache: "no-store",
      signal: withDeadline(REQUEST_TIMEOUT_MS, signal),
    });
    if (!res.ok) return null; // a 404 is a server older than this endpoint
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const { verdict, series } = body as { verdict?: unknown; series?: unknown };
    const report = parseMachineReport(verdict);
    if (!report) return null;
    noteMachineReport(report, parseMachineSeries(series));
    return report;
  } catch {
    return null;
  }
}

/** What the poll reads off the document. Its own shape rather than a slice of
 *  `Document`, so a test can hand it two functions and a string. */
interface MachinePollDoc {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface MachinePollOptions {
  fetch?: typeof fetch;
  doc?: MachinePollDoc;
}

/**
 * Read the machine directly for as long as somebody is watching it, and stop.
 *
 * WHY IT IS SWITCHED ON RATHER THAN LEFT RUNNING. The header already keeps the
 * row fresh for nothing, so the only moment worth spending requests on is the
 * one where a person has the panel open and is watching the number move. The
 * caller owns the lifetime and gets the teardown back, the way
 * diagnostics/network.ts's `startNetworkWatch` hands one back.
 *
 * IT PARKS WHILE THE TAB IS HIDDEN, for the reason store/lobby.ts parks its own
 * poll and with less excuse than that one: nobody is reading a panel they
 * cannot see, and a phone in a pocket would otherwise spend twelve requests a
 * minute on a number nobody will look at. Coming back asks straight away rather
 * than waiting out an interval, because what is on screen is as old as the time
 * the tab spent in the pocket.
 *
 * ONE READ AT A TIME. The next ask is armed off the ANSWER, not on an interval,
 * which is store/lobby.ts's reasoning about its own poll: setInterval keeps
 * firing into a request that has not come back, so a link slow enough to
 * overrun the period builds a queue of reads that all land together.
 *
 * Each call is its own poller with its own teardown. There is one panel, so
 * there is nothing to reference-count, and two callers asking twice is a
 * clearer failure than a shared counter that leaks.
 */
export function startMachineFastPoll(opts: MachinePollOptions = {}): () => void {
  const f = opts.fetch;
  const doc = opts.doc ?? (typeof document === "undefined" ? undefined : document);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hidden = (): boolean => doc?.visibilityState === "hidden";

  const arm = (): void => {
    if (stopped || timer !== undefined || hidden()) return;
    timer = setTimeout(ask, MACHINE_POLL_MS);
  };

  const ask = (): void => {
    timer = undefined;
    if (stopped || hidden()) return;
    void fetchMachine(f).then(arm, arm);
  };

  const onVisibility = (): void => {
    if (stopped) return;
    if (hidden()) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      return;
    }
    if (timer === undefined) ask();
  };

  doc?.addEventListener("visibilitychange", onVisibility);
  // Someone has just opened the panel. Waiting out an interval first would
  // leave the sparkline empty for the opening seconds of every visit, which is
  // most visits.
  ask();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    doc?.removeEventListener("visibilitychange", onVisibility);
  };
}

/** Test seam: forget the reading, the hour behind it, and every subscriber. */
export function resetMachineState(): void {
  machineReport = null;
  machinePoints = [];
  machineListeners.clear();
}
