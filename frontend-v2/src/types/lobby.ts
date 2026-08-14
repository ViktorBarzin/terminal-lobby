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
  attached: number;
  lastActivity: number;
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
  osUser: string;
}

export const LAYOUT_VERSION = 1;

/** Session name charset (tmux-api sessionNameRe). Shared client-side validation. */
export const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

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

/** GET /api/snapshots. */
export interface SnapshotList {
  snapshots: Snapshot[];
  /** -1 when /proc/meminfo could not be read — the UI then says nothing rather
   *  than implying there is room. */
  memAvailableMb: number;
  perSessionMb: number;
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
}

/** POST /api/restore body for a picker restore. */
export interface RestoreSelection {
  snapshot: string;
  sessions: string[];
}
