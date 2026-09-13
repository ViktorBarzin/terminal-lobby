import { isSessionId } from "../lib/session-id";

/**
 * Lobby wire types — mirror the tmux-api Go shapes EXACTLY (tmux-api/main.go
 * `Session`, tmux-api/layout.go `Layout`/`Project`/`DockState`). Field names are
 * the JSON keys on the wire; do not rename. Optional (`omitempty`) fields are
 * marked `?`.
 */

/** The Claude conversation's state inside a session (from @claude_state). */
export type ClaudeState = "running" | "awaiting" | "done";

/** How a viewer may attach a foreign session. */
export type AttachAccess = "ro" | "rw";

/**
 * Outstanding background work on a session, counted by kind (tmux-api
 * `Background`). Each key is omitted when zero, so an object with no keys never
 * reaches the wire — the whole field is dropped instead.
 *
 * Counted by kind rather than totalled because the kinds take wildly different
 * amounts of time: a background command is usually seconds, a workflow can be
 * half an hour.
 */
export interface BackgroundWork {
  agents?: number;
  commands?: number;
  workflows?: number;
}

/**
 * Which command a session is running (tmux-api `tool`, resolved from the
 * pane's process tree — NOT from pane_current_command, which reads "bash" for
 * both wrapper-launched agents). Absent when the server predates the field or
 * its /proc scan failed.
 */
export type SessionTool = "claude" | "codex" | "shell";

/** One session as returned by GET /api/sessions. */
export interface Session {
  name: string;
  /** tmux's own session id ($0, $1, …). The ONE identifier that survives a
   *  rename, which is what `store/visits.ts` keys read/unread records by: a
   *  session renamed by the one-time id migration, or by restore's collision
   *  path, keeps work the user had already read marked as read. It does NOT
   *  survive a tmux server restart, which is why it is not the session's name.
   *  Absent from a server that predates it. */
  id?: string;
  /** The name this session was FIRST created with, present only once it has
   *  been renamed away from a minted id (tmux-api sessionio.OptionBornAs).
   *
   *  It is what makes a rename followable when `id` cannot help. A session is
   *  renamed as soon as its first title lands (ADR-0022) — seconds in — and the
   *  session list is behind a 5-second cache, so a tab that created the session
   *  routinely never sees it under the id it minted. With no previous row to
   *  match an id against, this is the only link between the name that tab is
   *  holding and the session it belongs to. Absent for a session that never
   *  moved, and from a server that predates the field. */
  bornAs?: string;
  /** The display title a person chose — arbitrary text, up to 64 code points,
   *  from the session's @title option. Absent means the session has no title
   *  and its `name` is what gets shown, which is where every session that
   *  predates the feature sits. Distinct from `pane_title`, which is whatever
   *  is running in the pane describing itself. */
  title?: string;
  attached: number;
  /** At least one attached client is READ-WRITE. Distinct from `attached`,
   *  which counts watchers too: a session with two watchers and nobody
   *  typing is attached twice and driven by nobody. Watch mode joins a new
   *  device as a viewer only when this is true. */
  driven?: boolean;
  /** The session's GRID: the size of its tmux window in columns and rows,
   *  owned by whoever is driving it.
   *
   *  A tile that is WATCHING has no other way to learn it. It declines to claim
   *  the Grid — that refusal is the whole of Watch mode's promise — so its own
   *  terminal's size says nothing about the window it is showing, and a
   *  terminal fitted to the tile leaves tmux drawing the smaller window into a
   *  corner with its own dots around it. These two are what let a watcher
   *  render the session at the size its drivers gave it, centred
   *  (`terminal/fit.ts` `fitTarget`).
   *
   *  Both absent from a server that predates the fields, and from a session
   *  whose size tmux would not report: absent means no opinion, never 0x0. */
  cols?: number;
  rows?: number;
  /** tmux's #{session_activity}: output OR any attach, a read-only one included.
   *  NOT displayed anywhere — see `lastDrive`, which is what the sidebar shows. */
  lastActivity: number;
  /** When a human last had hands on this session: the newest moment a
   *  READ-WRITE client was attached. This is the sidebar's relative time.
   *  Watchers deliberately do not move it. Absent from a server that predates
   *  the field, in which case no time is shown rather than a misleading one. */
  lastDrive?: number;
  created: number;
  /** "" when no live Claude. */
  state?: ClaudeState | "";
  /** What the session is still waiting on, counted by kind. Absent when it is
   *  waiting on nothing, which is the ordinary case.
   *
   *  This is why `state` can read "running" with no turn in flight: a
   *  background agent, a workflow or a background command outlives the Stop
   *  that used to finish the turn, and the session will speak again with
   *  nobody prompting it. */
  bg?: BackgroundWork;
  /** Global project name the session is assigned to; "" = ungrouped. */
  project?: string;
  /** OS user the session runs as. Own sessions carry the caller; foreign the owner. */
  owner?: string;
  /** For a foreign session, how the caller may attach it. Empty for own sessions. */
  access?: AttachAccess | "";
  pane_current_command?: string;
  pane_title?: string;
  /** Which command the session runs; drives the sidebar tool mark. */
  tool?: SessionTool;
  /** Who made this session, from its `@tl_origin` tmux option: `user` when the
   *  lobby's own create path made it, `test` when a harness stamped it.
   *
   *  Absent means nobody said, and that is deliberately NOT the same as `user`:
   *  a mark can only mean something once the path a person uses leaves one, so
   *  everything unstamped is a system session (`isSystemSession` in
   *  components/lobby.logic.ts). Absent also covers a server that predates the
   *  field, which is why tmux-api stamps every live session `user` once at
   *  start — without that pass an upgrade would sweep the whole list into
   *  System. */
  origin?: string;
}

/** A per-user layout project (sidebar grouping + ordering). */
export interface LayoutProject {
  name: string;
  sessions: string[];
  dir?: string;
}

/** The Ctrl+J scratch-shell dock (preserved verbatim on PUT; not rendered here). */
export interface DockState {
  session: string;
  visible: boolean;
  dir?: string;
}

/** The whole per-user sidebar arrangement (GET/PUT /api/layout). */
export interface Layout {
  version: number;
  projects: LayoutProject[];
  ungrouped: string[];
  ungroupedIndex: number;
  dock?: DockState;
}

/** GET /api/whoami. */
export interface Whoami {
  authentik: string;
  /** The OS user this tab ACTS AS — the act-as target when switched, else the
   *  caller. Everything the lobby shows belongs to them. */
  osUser: string;
  /** The actual caller, present ONLY while acting as someone else. Its presence
   *  is the SPA's "am I switched?" test, so the chip and the tinted frame never
   *  have to trust the tab's own URL. */
  realUser?: string;
  /** Whether the CALLER administers this box (roster.yaml `tier: admin`, via
   *  /etc/ttyd-admins). Gates whether Settings offers the picker at all; the
   *  server refuses regardless, this only avoids showing a control that could
   *  never work. */
  admin?: boolean;
  /** Whether this box runs multi-user: a user map exists, so there are other
   *  accounts to share with, add to a project, or act as. Absent from a server
   *  built before the flag, which `lib/mode.ts` reads as multi-user so an older
   *  backend behaves exactly as it does today. */
  multiUser?: boolean;
}

export const LAYOUT_VERSION = 1;

/** Session name charset (tmux-api sessionNameRe). Shared client-side validation.
 *  This is the NAME — the identifier — not the title. `lib/session-id.ts` mints
 *  one for every session the lobby creates, and a 12-character id satisfies this
 *  unchanged, which is why nothing that validates a name had to move for
 *  ADR-0019. Names from before ids, and shells someone named by hand, also live
 *  in here. */
export const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

/** What an untitled session with a minted id reads as. */
export const NEW_SESSION_LABEL = "New session";

/**
 * What to SHOW for a session: its title, or what stands in for one.
 *
 * Every user-facing surface goes through this — cards, the tab title, the
 * command palette, the dock, push bodies, confirmations, aria-labels. The name
 * still travels underneath as the identifier; it is only the display that
 * changes.
 *
 * With no title, what shows depends on whether the name says anything. A
 * minted id (ADR-0019) does not, so `New session` is shown instead: it is the
 * honest description of a session whose summary has not landed yet, and twelve
 * random characters are worse than saying nothing. A name that was never
 * minted here still reads — sessions from before the migration, a shell
 * somebody named by hand, and t3-bridge's cwd-derived names.
 *
 * The line a session was created with is NOT read here. The store fills it into
 * `title` as the poll lands (store/prompt-line.ts), so every surface that shows
 * a title shows it, and this stays a pure function of the wire shape.
 */
export function sessionLabel(s: Pick<Session, "name" | "title">): string {
  if (s.title && s.title.length > 0) return s.title;
  return isSessionId(s.name) ? NEW_SESSION_LABEL : s.name;
}

/**
 * What a message calls a session when it has ONE chance to say which one, and
 * the reader cannot ask again: an OS notification, which arrives on a locked
 * phone with no list beside it.
 *
 * `sessionLabel` answers `New session` for every untitled minted id, so a
 * banner about one cannot tell two of them apart. The id is the only thing that
 * can, and this is also where it becomes readable at all: a name is invisible
 * everywhere else now (ADR-0019's last consequence). tmux-api's `pushLabel` is
 * the same rule server-side, so a pushed banner and a page-fired one read
 * alike.
 *
 * The kill confirm was the other reader until the grace window replaced it
 * (store/lobby.ts GRACE_MS): a kill is undone with Cmd+Z now, so nothing asks
 * about one first and no message has to name the session it is about to take.
 */
export function sessionConfirmLabel(s: Pick<Session, "name" | "title">): string {
  return s.title && s.title.length > 0 ? s.title : s.name;
}

/**
 * What a rename box OPENS on: the session's own title, and "" when it has none.
 *
 * Not `sessionLabel`. Offering `New session` for editing invites someone to
 * save the placeholder as a real title, and stamping a title is what stops
 * Claude's summary from ever landing (tmux-api/autotitle.go). An empty box says
 * the same thing honestly, and typing nothing into it changes nothing.
 */
export function sessionTitleDraft(s: Pick<Session, "name" | "title"> | undefined): string {
  if (!s) return "";
  if (s.title && s.title.length > 0) return s.title;
  // No title. A minted id says nothing, so the box opens empty; a name from
  // before ids — or one t3-bridge derived from a directory — is what the card
  // reads, so it is a fair thing to start editing.
  return isSessionId(s.name) ? "" : s.name;
}

export function emptyLayout(): Layout {
  return { version: LAYOUT_VERSION, projects: [], ungrouped: [], ungroupedIndex: 0 };
}

// --- session snapshots (restore picker) ---------------------------------------
// tmux-persist keeps a SERIES of snapshots per user rather than one live
// manifest: a partial loss (tmux server alive, the processes inside sessions
// killed) used to be overwritten by the next 5-minute save before anyone could
// restore from it.

/** One version in the picker's list. */
export interface Snapshot {
  ts: string;
  count: number;
  /** The snapshot the plain restore uses, and the one the picker opens on. */
  newest: boolean;
  /** How many more sessions this holds than are running — the column that
   *  points at an older version after a loss. */
  deltaVsLive: number;
  /** The most recent snapshot at the high-water mark. A label only: the picker
   *  never auto-selects it. */
  lastFull: boolean;
}

/** GET /api/snapshots — everything the picker needs to open, in one call. */
export interface SnapshotList {
  snapshots: Snapshot[];
  /** -1 when /proc/meminfo could not be read — the UI then says nothing rather
   *  than implying there is room. */
  memAvailableMb: number;
  perSessionMb: number;
  /** The snapshot `rows` was resolved from. Absent on a server that predates
   *  the one-call open, or when there are no snapshots yet. */
  newestTs?: string;
  /** That snapshot already resolved against live state, so the picker renders
   *  from this response. Absent means fetch it with getSnapshot, as before. */
  rows?: SnapshotRow[];
}

/** One session inside a snapshot, already resolved against what is live. */
export interface SnapshotRow {
  name: string;
  /** What a person reads for this row. A name is an opaque id (ADR-0019), so
   *  without this the picker is a list of 12-character strings. Absent when the
   *  session was never titled — then the name is all there is. */
  title?: string;
  cwd: string;
  uuid?: string;
  state: "missing" | "live_same" | "live_other_conv" | "live_no_claude";
  action: "new" | "suffixed" | "in_place" | "skip";
  /** The session name this row would produce — the same name, or a -HHMM
   *  suffixed one when the name is taken by a different conversation. */
  target: string;
  /** Whether the row starts ticked. False for anything already live, and for a
   *  session deliberately killed after this snapshot. */
  default: boolean;
  /** Set when a deliberate kill is why `default` is false. */
  killedAt?: number;
  /** The project restoring this row would put the session in, resolved
   *  server-side (tmux-api `assignments.go`). Absent/"" means Ungrouped. */
  project?: string;
}

/** POST /api/restore body for a picker restore. */
export interface RestoreSelection {
  snapshot: string;
  sessions: string[];
}

// --- workspaces (which sessions sit on screen together) -----------------------
// A Workspace is several sessions shown at once as Tiles, arranged as a tree of
// rows and columns (CONTEXT.md "Workspace"). ADR-0027 splits that object across
// two stores, and ONLY THE SERVER HALF IS ON THIS WIRE: the workspace's id and
// its ordered members, one document per OS user beside layout/<user>.json.
//
// The tree and the tile sizes are deliberately not here and never reach
// tmux-api. They are per device, under the browser's own `tl:workspaces:v1` key
// (store/workspaces.ts), because a four-column arrangement describes a 32-inch
// monitor, is meaningless on a laptop and is unrenderable on a phone, which sees
// no workspaces at all. Membership roams instead, because it changes what the
// sidebar does, because two tabs on one machine have to agree about the
// exclusivity rule below, and because a kill must not silently drop it.

/**
 * One workspace: an id the client mints, and the sessions in it (tmux-api
 * `Workspace`). Unnamed by design — a workspace is created implicitly by the
 * first split and is identified by its members, so there is no name field and
 * nothing to prompt anyone for.
 */
export interface Workspace {
  /** Minted by the client, in the session-name charset (`NAME_RE`) because
   *  that is what the server validates it against. */
  id: string;
  /**
   * The sessions in it, in the order the user arranged them.
   *
   * The order is load-bearing rather than decorative: a device that has never
   * seen this workspace has no geometry for it and auto-arranges evenly in THIS
   * order, so a fresh laptop and a fresh phone lay the same workspace out the
   * same way, and the first drag makes the arrangement that device's own.
   *
   * A member may name a session that is not alive. A KILL KEEPS MEMBERSHIP —
   * only a deliberate close or a drag-out removes a session from a workspace —
   * so a restored session finds its tile again, the way
   * `assignments/<user>.json` already gives back project placement. The
   * frontend renders live sessions only.
   *
   * At least two of them (`MIN_WORKSPACE_MEMBERS`), and a session may appear in
   * at most one workspace across the whole document — where a session is the
   * pair below, not the name.
   */
  members: WorkspaceMember[];
}

/**
 * One session in a workspace: its name, and the OS user who owns it when that
 * is not you (tmux-api `WorkspaceMember`).
 *
 * THE OWNER IS WHAT MAKES A FOREIGN SESSION TILEABLE. Any session you can open
 * belongs in a workspace, shared and foreign included — one emo shared with you
 * sitting beside two of your own — and a bare name cannot say whose session it
 * is: a tmux name is unique only inside one user's server, which is why the
 * global project store identifies a session by `(owner, name)` (tmux-api
 * `SessionRef`) and why keepalive mounts one live view per owner AND name.
 *
 * This is deliberately the same shape as keepalive's `Selected` and the tree's
 * `SessionParts`, so the conversions are the ones that already exist rather
 * than a third vocabulary: `keyOf(member)` gives the key a tile and a mounted
 * slot are keyed by, and `sessionOf(key)` gives the member back. Nothing splits
 * the key by hand.
 */
export interface WorkspaceMember {
  name: string;
  /**
   * The session's OS user. ABSENT — never `""` — for a session of your own.
   *
   * Absent means the caller, which keeps the ordinary document short: a
   * workspace of your own sessions would otherwise carry your own name on every
   * entry. It matters that it is absent rather than empty because both sides
   * compare members for equality: `{name}` and `{name, owner: ""}` would be two
   * spellings of one session, and the arrangement built from one would stop
   * matching the membership written as the other. `normalizeWorkspaces` reads an
   * explicit `""` as absent for that reason, as tmux-api's `omitempty` does.
   */
  owner?: string;
}

/**
 * The whole per-user membership document (GET/PUT /api/sessions/workspaces).
 *
 * Plural because the Go struct is (tmux-api `Workspaces`): this is the
 * document, not a list. Whole-document PUT, last-writer-wins, exactly like
 * Layout — moving a session from one workspace to another is one write carrying
 * both halves, because the server refuses a document where two workspaces claim
 * the same session.
 */
export interface Workspaces {
  version: number;
  workspaces: Workspace[];
}

/** The document version this client speaks (tmux-api `workspacesVersion`). The
 *  server refuses any other. */
export const WORKSPACES_VERSION = 1;

/**
 * One tile is not a workspace (tmux-api `minWorkspaceMembers`).
 *
 * Closing a workspace down to a single tile ends it and shows that session on
 * its own, so a stored group of one describes a state the UI cannot be in: it
 * is a client that failed to finish a removal. The server rejects such a
 * document on write and drops the entry on read.
 */
export const MIN_WORKSPACE_MEMBERS = 2;

export function emptyWorkspaces(): Workspaces {
  return { version: WORKSPACES_VERSION, workspaces: [] };
}
