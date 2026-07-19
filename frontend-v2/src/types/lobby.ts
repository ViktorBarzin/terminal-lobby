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
