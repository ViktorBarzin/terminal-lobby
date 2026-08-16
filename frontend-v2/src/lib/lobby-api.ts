/**
 * tmux-api client — the lobby's data + mutation surface. Every call is
 * same-origin (the ingress injects X-Authentik-Username) and goes under the
 * /api prefix (apiUrl). Shapes mirror tmux-api/*.go. Errors throw an
 * ApiError carrying the HTTP status so callers can branch (409 taken, 404 gone).
 */
import { apiUrl } from "./config";
import {
  emptyLayout,
  type Layout,
  type LayoutProject,
  type RestoreSelection,
  type Session,
  type SnapshotList,
  type SnapshotRow,
  type Whoami,
} from "../types/lobby";

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
 * How long any tmux-api call may take before it is abandoned.
 *
 * Without a deadline a fetch on a half-open connection never settles at all —
 * which is exactly what a phone hands us when the radio drops a socket without
 * an RST. The promise stays pending forever, and every caller awaiting it stays
 * with it: the lobby's poll simply stops producing polls, showing a stale list
 * and no error to explain it. 8s is past the p99 of these endpoints (all of
 * them are a tmux shell-out or a small JSON file) while still well inside the
 * poll's own 5s-and-backing-off cadence.
 */
export const REQUEST_TIMEOUT_MS = 8000;

/**
 * The deadline for POST /restore, which is not like the others: it shells out
 * to `tmux-persist restore <user>` and recreates every dead session in the
 * caller's manifest one tmux command at a time. A long manifest can outrun the
 * ordinary cap, and cutting it off there would report "Restore failed" for work
 * the server goes on to finish.
 */
export const RESTORE_TIMEOUT_MS = 30000;

/**
 * The signal a request runs under: a timeout deadline, merged with the caller's
 * own signal when it has one, so neither can be lost by adding the other.
 *
 * Merged by hand rather than with `AbortSignal.any`, which reached Safari only
 * in 17.4 — too new to put in the path of every lobby call on a phone (and
 * jsdom has yet to ship it either). Exported for testing.
 */
export function withDeadline(ms: number, caller?: AbortSignal | null): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  if (!caller) return deadline;
  const merged = new AbortController();
  const forward = (from: AbortSignal) => merged.abort(from.reason);
  if (caller.aborted) forward(caller);
  else if (deadline.aborted) forward(deadline);
  else {
    caller.addEventListener("abort", () => forward(caller), { once: true });
    deadline.addEventListener("abort", () => forward(deadline), { once: true });
  }
  return merged.signal;
}

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
          sessions: Array.isArray(p.sessions) ? p.sessions.filter((s) => typeof s === "string") : [],
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
  if (d && typeof d === "object" && typeof d.session === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(d.session)) {
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

/** DELETE /api/sessions/{name} — kill a session (204/404). */
export async function killSession(name: string): Promise<void> {
  const res = await req(`/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new ApiError(res.status, `kill HTTP ${res.status}`);
}

/** POST /api/sessions/{name}/rename {name} — 204/404/409(taken)/400(invalid).
 *  Kept for the name-only rename; the lobby retitles through `retitleSession`. */
export async function renameSession(oldName: string, newName: string): Promise<void> {
  const res = await req(`/sessions/${encodeURIComponent(oldName)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) throw new ApiError(res.status, `rename HTTP ${res.status}`);
}

/**
 * PATCH /api/sessions/{name} {title, name} — 204/404/409(taken)/400(invalid).
 *
 * The retitle. Rename and stamp travel together so they cannot half-apply,
 * leaving a session renamed but holding its old title or titled under a name
 * the rename never reached. `newName` is derived here (lib/slug.ts) rather than
 * server-side, because a create has to be able to pick a name with no server
 * involved at all, and both sides run the same slug rules.
 *
 * A 409 means the derived name is taken; the session keeps its old title.
 */
export async function retitleSession(
  oldName: string,
  newName: string,
  title: string,
): Promise<void> {
  const res = await req(`/sessions/${encodeURIComponent(oldName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName, title }),
  });
  if (!res.ok) throw new ApiError(res.status, `retitle HTTP ${res.status}`);
}

/**
 * POST /api/sessions/{name}/title {title} — 204/404/400.
 *
 * A title with no rename. Two callers: stamping a title onto a session the
 * lobby has just created (creation reaches no server, so this is the first the
 * API hears of it), and clearing a title back to nothing so the card shows the
 * session's name again.
 */
export async function setSessionTitle(name: string, title: string): Promise<void> {
  const res = await req(`/sessions/${encodeURIComponent(name)}/title`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new ApiError(res.status, `set title HTTP ${res.status}`);
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
 *  against what is running now. */
export async function listSnapshots(): Promise<SnapshotList> {
  return json<SnapshotList>("/snapshots", { cache: "no-store" });
}

/** GET /api/snapshots/{ts} → one snapshot resolved against the live session
 *  set: per row, what restoring it would do and whether it starts ticked.
 *  Resolution is server-side so this and the vanilla lobby cannot drift. */
export async function getSnapshot(ts: string): Promise<SnapshotRow[]> {
  const rows = await json<SnapshotRow[]>(`/snapshots/${encodeURIComponent(ts)}`, { cache: "no-store" });
  return Array.isArray(rows) ? rows : [];
}

/** GET /api/dirs → candidate directories for the project dir picker. */
export async function listDirs(): Promise<string[]> {
  try {
    const arr = await json<unknown>("/dirs", { cache: "no-store" });
    if (Array.isArray(arr)) return arr.filter((d): d is string => typeof d === "string");
    // /dirs may return {dirs, truncated}
    if (arr && typeof arr === "object" && Array.isArray((arr as { dirs?: unknown[] }).dirs)) {
      return (arr as { dirs: unknown[] }).dirs.filter((d): d is string => typeof d === "string");
    }
  } catch {
    /* dir picker degrades to a free-text field */
  }
  return [];
}

/** The full client surface, bundled so a store/test can inject a fake. */
export interface LobbyApi {
  whoami(): Promise<Whoami>;
  listSessions(): Promise<Session[]>;
  getLayout(): Promise<Layout>;
  putLayout(layout: Layout): Promise<void>;
  killSession(name: string): Promise<void>;
  renameSession(oldName: string, newName: string): Promise<void>;
  retitleSession(oldName: string, newName: string, title: string): Promise<void>;
  setSessionTitle(name: string, title: string): Promise<void>;
  restoreSessions(sel?: RestoreSelection): Promise<void>;
  listSnapshots(): Promise<SnapshotList>;
  getSnapshot(ts: string): Promise<SnapshotRow[]>;
  listDirs(): Promise<string[]>;
}

export const lobbyApi: LobbyApi = {
  whoami,
  listSessions,
  getLayout,
  putLayout,
  killSession,
  renameSession,
  retitleSession,
  setSessionTitle,
  restoreSessions,
  listSnapshots,
  getSnapshot,
  listDirs,
};
