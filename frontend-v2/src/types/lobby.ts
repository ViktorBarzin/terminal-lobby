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
   *  rename, which is how a tab whose selected session was retitled elsewhere
   *  follows it instead of holding a name whose attach would create a fresh
   *  empty session. Absent from a server that predates it. */
  id?: string;
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
 *  This is the NAME — the identifier — not the title: a person types a title and
 *  `lib/slug.ts` derives something matching this from it. */
export const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

/**
 * What to SHOW for a session: its title when it has one, otherwise its name.
 *
 * Every user-facing surface goes through this — cards, the tab title, the
 * command palette, the dock, push bodies, confirmations, aria-labels. The name
 * still travels underneath as the identifier; it is only the display that
 * changes.
 */
export function sessionLabel(s: Pick<Session, "name" | "title">): string {
  return s.title && s.title.length > 0 ? s.title : s.name;
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
