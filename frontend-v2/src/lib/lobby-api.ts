/**
 * tmux-api client — the lobby's data + mutation surface. Every call is
 * same-origin (the ingress injects X-Authentik-Username) and goes under the
 * /api prefix (apiUrl). Shapes mirror tmux-api/*.go. Errors throw an
 * ApiError carrying the HTTP status so callers can branch (409 taken, 404 gone).
 */
import { noteNetworkId } from "../diagnostics/network";
// keyOf, for the one thing this file needs a session IDENTITY for: deciding
// which member a contested session belongs to. It is the key keepalive mounts a
// live view under, so two members that would mount one slot are one member here
// — which is the exclusivity rule stated in the terms that make it true.
import { keyOf } from "../store/keepalive";
import { NET_HEADER, apiUrl } from "./config";
import {
  emptyLayout,
  emptyWorkspaces,
  type Layout,
  type LayoutProject,
  type RestoreSelection,
  type Session,
  type SnapshotList,
  type SnapshotRow,
  type Whoami,
  type Workspace,
  type WorkspaceMember,
  type Workspaces,
  MIN_WORKSPACE_MEMBERS,
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

// --- workspaces (which sessions sit on screen together) -----------------------
//
// A Workspace is several sessions shown at once as Tiles, arranged as a tree of
// rows and columns. ADR-0027 splits that object across two stores and only the
// server half travels here: the workspace's id and its ordered members. The tree
// and the tile sizes stay in this browser under `tl:workspaces:v1`
// (store/workspaces.ts), because a four-column arrangement describes a 32-inch
// monitor and is meaningless on a laptop.
//
// Both calls follow the layout pair above rather than inventing manners of their
// own: same `req`, same whole-document GET/PUT, same last-writer-wins, same
// ApiError carrying the status. A store that behaves differently from the one
// next to it is a store whose behaviour has to be rediscovered.
//
// Deliberately NOT part of the injectable `LobbyApi` surface, for the same
// reason `listUsers` and `availableCommands` are not: adding them to the
// interface would mean a stub in every existing store fake for a call none of
// them make. Callers import the two functions from here, and a caller that
// needs to substitute them takes them as its own dependencies — the way
// `createWorkspacesStore` already takes `parseTree` and `sessionsOf`.

/**
 * GET /api/workspaces → which of this user's sessions belong on screen
 * together, normalized (see `normalizeWorkspaces`).
 *
 * THROWS on anything but a 2xx, and that is the point of not writing it like
 * `listUsers`, which degrades to an empty list. An empty document is a real
 * answer — it is where every user sits until their first split, and where
 * closing back to one tile returns them — and it means "unmark every member in
 * the sidebar, and this device may forget the arrangements it holds for them".
 * A tmux-api that is restarting means nothing of the sort. Handing back an empty
 * document for a request that failed would make those two indistinguishable, so
 * the caller is told and keeps what it already had on screen.
 */
export async function getWorkspaces(): Promise<Workspaces> {
  const w = await json<Partial<Workspaces>>("/workspaces", { cache: "no-store" });
  return normalizeWorkspaces(w);
}

/**
 * Rebuild a workspaces document FROM NAMED FIELDS ONLY. Exported for testing.
 *
 * WHY THE UNKNOWN FIELDS GO. tmux-api unmarshals this document into a struct, so
 * a field it has never heard of is silently dropped on the way in and absent on
 * the way out — no error, nothing in a log. That is how the Ctrl+J dock used to
 * vanish four seconds after it was opened, before `DockState` became a real
 * field in layout.go. This function is the client agreeing to the same terms:
 * what is not declared on both sides does not exist, and a shape the server will
 * throw away cannot be read back here either, where it would look durable for
 * exactly as long as the tab stays open.
 *
 * The field this concretely covers is the tree. Geometry is per-device by
 * ADR-0027 and the server deliberately never grows a field for it, so a client
 * that tucked a `tree` into a workspace entry would watch it disappear on the
 * next read and have no way to tell that from a device that had never seen the
 * workspace. Dropping it here makes depending on it impossible rather than
 * merely unwise.
 *
 * THE REPAIRS MIRROR THE SERVER'S OWN `healWorkspaces`, first mention winning
 * each time: a session listed in two workspaces (or twice in one) stays with the
 * first, a repeated id keeps its first entry, and a workspace left below
 * `MIN_WORKSPACE_MEMBERS` is dropped. A GET from a current server arrives
 * already healed, so the copy earns its keep only in front of a server older
 * than that heal. Mirroring rather than inventing is the part that matters: a
 * client that resolved a contested session differently from the server would
 * show a grouping the server overwrites on its next read, and the person would
 * see a click open the wrong workspace with nothing on screen to explain it.
 *
 * Names, owners and ids are checked against `NAME_RE`, the client's copy of the
 * server's `sessionNameRe`, the way `normalizeLayout` already checks
 * `dock.session`. The `typeof` test in front of it is load-bearing rather than
 * belt and braces: `RegExp.test` coerces, so a member whose name arrived as `7`
 * or `null` would pass the pattern as "7" or "null" and become a tile pointing
 * at nothing.
 *
 * A SESSION IS THE PAIR, so exclusivity is decided on `keyOf`, the same key
 * keepalive mounts one live view under. One NAME under two owners is two
 * members and both survive — emo's `auth` and yours are different terminals and
 * may sit side by side — while the same owner and name twice is the repeat the
 * rule is about. An owner of `""` is read as absent, matching the `omitempty`
 * the server writes it back with.
 *
 * What this does NOT mirror: the server resolves an omitted owner to the caller
 * before comparing, so it catches a document naming your own session bare in one
 * place and in full in the next. This file does not know who the caller is, so
 * it would keep both. Nothing in the app mints that shape (members are built
 * from tile keys, which carry no owner for your own sessions) and a server that
 * has one refuses the write and heals it on read, so the divergence is
 * unreachable rather than merely unlikely.
 *
 * `version` comes out as the one this client speaks, like `normalizeLayout`'s.
 * A document from a future server is therefore read as v1 and written back as
 * v1, where `validateWorkspaces` refuses it out loud — better than this client
 * quietly PUTting a shape it does not understand.
 */
export function normalizeWorkspaces(raw: Partial<Workspaces> | null | undefined): Workspaces {
  const base = emptyWorkspaces();
  if (!raw || typeof raw !== "object") return base;
  if (!Array.isArray(raw.workspaces)) return base;

  const ids = new Set<string>();
  /** Sessions already spoken for, by `keyOf`, so exclusivity is decided in one
   *  pass. */
  const claimed = new Set<string>();
  const workspaces: Workspace[] = [];

  for (const w of raw.workspaces) {
    if (!w || typeof w !== "object") continue;
    if (typeof w.id !== "string" || !NAME_RE.test(w.id) || ids.has(w.id)) continue;

    const members: WorkspaceMember[] = [];
    const mine = new Set<string>();
    for (const entry of Array.isArray(w.members) ? w.members : []) {
      const member = memberFrom(entry);
      if (!member) continue;
      const key = keyOf(member);
      if (claimed.has(key) || mine.has(key)) continue;
      mine.add(key);
      members.push(member);
    }

    // Claim the members only once the workspace is known to survive. A group
    // being dropped for having too few must not take its sessions with it, or it
    // would strip them from the real workspace further down the list.
    if (members.length < MIN_WORKSPACE_MEMBERS) continue;
    for (const member of members) claimed.add(keyOf(member));
    ids.add(w.id);
    workspaces.push({ id: w.id, members });
  }

  return { version: base.version, workspaces };
}

/**
 * One member rebuilt from its two named fields, or `null` for anything the
 * server would not store: a member that is not an object (the shape before the
 * owner existed sent bare strings), a name outside the session charset, an
 * owner that is not a string or not an OS user name.
 *
 * The rebuild is what drops the unknown fields, one level deeper than the
 * workspace entry: tmux-api unmarshals a member into a two-field struct, so a
 * `title` tucked into one is gone on the way in and absent on the way out, and
 * keeping it here would show state that survives in this tab and nowhere else.
 *
 * An owner of `""` becomes an absent owner rather than a dropped member, which
 * is how the server reads it too — `omitempty` writes the same document back
 * either way, and a member is not worth losing over a spelling of "mine".
 */
function memberFrom(entry: WorkspaceMember): WorkspaceMember | null {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.name !== "string" || !NAME_RE.test(entry.name)) return null;
  if (entry.owner === undefined || entry.owner === "") return { name: entry.name };
  if (typeof entry.owner !== "string" || !NAME_RE.test(entry.owner)) return null;
  return { name: entry.name, owner: entry.owner };
}

/**
 * PUT /api/workspaces — whole-document, last-writer-wins. Throws on non-204.
 *
 * ONE WRITE CARRIES EVERY CHANGE, because the document is whole and the server
 * refuses one where two workspaces claim the same session. Dragging a session
 * from workspace A into workspace B is therefore not two calls: A reflowing and
 * B gaining a tile ride in the same body, and there is no intermediate state to
 * send. Splitting it would put a document the server rejects on the wire.
 *
 * A refusal throws with its status, unlike `setSessionGrid`'s hint, because the
 * caller has an optimistic arrangement on screen that the server has just
 * declined to remember. 400 is the interesting one: the document broke
 * exclusivity, left a group below two members, or carried a name outside the
 * session charset. The tiles are still on screen and still attached either way —
 * what was lost is the promise that the other tab, and the next device, will see
 * the same grouping.
 */
export async function putWorkspaces(workspaces: Workspaces): Promise<void> {
  const res = await req("/workspaces", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(workspaces),
  });
  if (!res.ok) throw new ApiError(res.status, `workspaces PUT HTTP ${res.status}`);
}
