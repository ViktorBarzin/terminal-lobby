/**
 * PURE lobby-sidebar derivation + layout transforms — no DOM, no Solid, no
 * fetch. This is the testable core behind the sidebar: it turns the per-user
 * Layout + the live session list into the ordered render model, and applies the
 * reorder / group / CRUD mutations as whole-Layout transforms (the shape PUT
 * /api/layout persists, last-writer-wins).
 *
 * Contracts reproduced from the feature inventory (Category 2/3):
 *  - groups render in `groupSeq` order: the projects interleaved with the
 *    Ungrouped section at its slot (ungroupedIndex).
 *  - a project's members are its layout.sessions filtered to LIVE own sessions,
 *    in that order (dead-but-assigned refs are kept in the layout — an OOM
 *    restore regroups them — but not rendered).
 *  - Ungrouped members are layout.ungrouped (live) followed by any live own
 *    session referenced by no group. Ungrouped hides while empty but keeps its
 *    slot (the sentinel stays in the sequence for reordering/capture).
 *  - foreign sessions (owner ≠ me) are a separate Shared-with-me list, owner-major.
 *  - the dock session (hidden scratch shell) is never rendered and never touched.
 */
import type { ClaudeState, Layout, LayoutProject, Session } from "../types/lobby";

export type GroupKind = "project" | "ungrouped";

export interface RenderGroup {
  kind: GroupKind;
  /** project name; "" for ungrouped. */
  name: string;
  /** the layout project (undefined for ungrouped). */
  project?: LayoutProject;
  /** live sessions in render order. */
  sessions: Session[];
}

export interface SidebarModel {
  /** ordered groups, including the ungrouped sentinel at its slot. */
  groups: RenderGroup[];
  /** shared-with-me (foreign) sessions, owner-major then name. */
  foreign: Session[];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

/** Is this session owned by `me` (own sessions carry owner=me; missing = own). */
export function isOwn(s: Session, me: string): boolean {
  return !s.owner || s.owner === me;
}

/**
 * The ordered group sequence as tokens: "p:<projectName>" per project and "u"
 * for the ungrouped sentinel, inserted at ungroupedIndex. Used for reordering.
 */
export function groupSeqTokens(layout: Layout): string[] {
  const n = layout.projects.length;
  const ui = clamp(layout.ungroupedIndex ?? 0, 0, n);
  const seq: string[] = [];
  for (let i = 0; i <= n; i++) {
    if (i === ui) seq.push("u");
    if (i < n) seq.push("p:" + layout.projects[i]!.name);
  }
  return seq;
}

/** Rebuild {projects order, ungroupedIndex} from a reordered token sequence. */
function applySeqTokens(layout: Layout, tokens: string[]): Layout {
  const byName = new Map(layout.projects.map((p) => [p.name, p]));
  const projects: LayoutProject[] = [];
  let ungroupedIndex = tokens.length - 1;
  tokens.forEach((t, i) => {
    if (t === "u") ungroupedIndex = projects.length;
    else {
      const p = byName.get(t.slice(2));
      if (p) projects.push(p);
    }
    void i;
  });
  return { ...layout, projects, ungroupedIndex: clamp(ungroupedIndex, 0, projects.length) };
}

/** Derive the sidebar render model from the layout + live sessions. */
export function deriveSidebar(
  layout: Layout,
  sessions: Session[],
  me: string,
): SidebarModel {
  const own = sessions.filter((s) => isOwn(s, me));
  const foreign = sessions.filter((s) => !isOwn(s, me));
  const dockName = layout.dock?.session;
  const ownByName = new Map(
    own.filter((s) => s.name !== dockName).map((s) => [s.name, s] as const),
  );
  const referenced = new Set<string>();

  const resolve = (names: string[]): Session[] => {
    const out: Session[] = [];
    for (const name of names) {
      const s = ownByName.get(name);
      if (s && !referenced.has(name)) {
        referenced.add(name);
        out.push(s);
      }
    }
    return out;
  };

  // Resolve project members first so referenced is populated before ungrouped
  // sweeps up the leftovers.
  const projectMembers = new Map<string, Session[]>();
  for (const p of layout.projects) projectMembers.set(p.name, resolve(p.sessions));

  const ungroupedMembers = resolve(layout.ungrouped);
  // Live own sessions referenced by no group land in Ungrouped, in a stable
  // order (creation time asc, then name) so the sidebar doesn't jitter.
  const leftovers = [...ownByName.values()]
    .filter((s) => !referenced.has(s.name))
    .sort((a, b) => a.created - b.created || a.name.localeCompare(b.name));
  ungroupedMembers.push(...leftovers);

  const groups: RenderGroup[] = [];
  for (const t of groupSeqTokens(layout)) {
    if (t === "u") {
      groups.push({ kind: "ungrouped", name: "", sessions: ungroupedMembers });
    } else {
      const name = t.slice(2);
      const project = layout.projects.find((p) => p.name === name);
      groups.push({
        kind: "project",
        name,
        project,
        sessions: projectMembers.get(name) ?? [],
      });
    }
  }

  foreign.sort((a, b) => (a.owner ?? "").localeCompare(b.owner ?? "") || a.name.localeCompare(b.name));
  return { groups, foreign };
}

// ---- Layout transforms (whole-doc, immutable) ---------------------------

function stripEverywhere(layout: Layout, name: string): Layout {
  return {
    ...layout,
    projects: layout.projects.map((p) => ({
      ...p,
      sessions: p.sessions.filter((s) => s !== name),
    })),
    ungrouped: layout.ungrouped.filter((s) => s !== name),
  };
}

/**
 * Move `name` into `targetGroup` ("" = ungrouped) at `index` (clamped; -1 or
 * omitted appends). Removes any prior reference first so a session is listed at
 * most once (the PUT validator rejects duplicates).
 */
export function moveSession(
  layout: Layout,
  name: string,
  targetGroup: string,
  index = -1,
): Layout {
  const base = stripEverywhere(layout, name);
  const insert = (list: string[]): string[] => {
    const at = index < 0 || index > list.length ? list.length : index;
    return [...list.slice(0, at), name, ...list.slice(at)];
  };
  if (targetGroup === "") {
    return { ...base, ungrouped: insert(base.ungrouped) };
  }
  return {
    ...base,
    projects: base.projects.map((p) =>
      p.name === targetGroup ? { ...p, sessions: insert(p.sessions) } : p,
    ),
  };
}

/** Reorder the group sequence by moving the token at fromSeq to toSeq. */
export function reorderGroups(layout: Layout, fromSeq: number, toSeq: number): Layout {
  const tokens = groupSeqTokens(layout);
  if (fromSeq < 0 || fromSeq >= tokens.length) return layout;
  const to = clamp(toSeq, 0, tokens.length - 1);
  const [moved] = tokens.splice(fromSeq, 1);
  tokens.splice(to, 0, moved!);
  return applySeqTokens(layout, tokens);
}

/** Move a group (project name, or "" for ungrouped) up/down by one slot. */
export function moveGroup(layout: Layout, groupName: string, dir: -1 | 1): Layout {
  const tokens = groupSeqTokens(layout);
  const token = groupName === "" ? "u" : "p:" + groupName;
  const from = tokens.indexOf(token);
  if (from === -1) return layout;
  return reorderGroups(layout, from, from + dir);
}

/** Append a new (empty) project. No-op if the name is already taken. */
export function addProject(layout: Layout, name: string, dir?: string): Layout {
  if (layout.projects.some((p) => p.name === name)) return layout;
  const project: LayoutProject = { name, sessions: [] };
  if (dir) project.dir = dir;
  return { ...layout, projects: [...layout.projects, project] };
}

export function renameProject(layout: Layout, oldName: string, newName: string): Layout {
  if (oldName === newName) return layout;
  if (layout.projects.some((p) => p.name === newName)) return layout;
  return {
    ...layout,
    projects: layout.projects.map((p) =>
      p.name === oldName ? { ...p, name: newName } : p,
    ),
  };
}

/** Delete a project: its sessions fall back to Ungrouped; slot is removed. */
export function deleteProject(layout: Layout, name: string): Layout {
  const idx = layout.projects.findIndex((p) => p.name === name);
  if (idx === -1) return layout;
  const doomed = layout.projects[idx]!;
  const projects = layout.projects.filter((p) => p.name !== name);
  // Ungrouped slot shifts left if it sat after the removed project.
  let ungroupedIndex = layout.ungroupedIndex;
  if (ungroupedIndex > idx) ungroupedIndex -= 1;
  return {
    ...layout,
    projects,
    ungrouped: [...layout.ungrouped, ...doomed.sessions],
    ungroupedIndex: clamp(ungroupedIndex, 0, projects.length),
  };
}

/** Add a session name to a group (used by create). "" = ungrouped. */
export function addSessionToGroup(layout: Layout, name: string, group: string): Layout {
  return moveSession(layout, name, group);
}

export function renameSessionInLayout(layout: Layout, oldName: string, newName: string): Layout {
  const relabel = (list: string[]) => list.map((s) => (s === oldName ? newName : s));
  const l: Layout = {
    ...layout,
    projects: layout.projects.map((p) => ({ ...p, sessions: relabel(p.sessions) })),
    ungrouped: relabel(layout.ungrouped),
  };
  if (l.dock?.session === oldName) l.dock = { ...l.dock, session: newName };
  return l;
}

export function removeSessionFromLayout(layout: Layout, name: string): Layout {
  return stripEverywhere(layout, name);
}

// ---- Display helpers -----------------------------------------------------

/** Ported verbatim from the vanilla app (frontend/index.html relativeTime). */
export function relativeTime(epochSec: number): string {
  if (!epochSec) return "";
  const diff = Math.floor(Date.now() / 1000) - epochSec;
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

/** m:ss (or h:mm:ss) elapsed for the running-session working timer. */
export function formatWorking(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Human phrase for a session's Claude state (tooltip / a11y). */
export function stateLabel(state: string | undefined): string {
  switch (state) {
    case "running":
      return "Working";
    case "awaiting":
      return "Awaiting input";
    case "done":
      return "Done";
    default:
      return "";
  }
}

export interface StateCounts {
  running: number;
  awaiting: number;
  done: number;
}

/** Count Claude states across a group (collapsed-header chips). */
export function countStates(sessions: Session[]): StateCounts {
  const c: StateCounts = { running: 0, awaiting: 0, done: 0 };
  for (const s of sessions) {
    if (s.state === "running") c.running++;
    else if (s.state === "awaiting") c.awaiting++;
    else if (s.state === "done") c.done++;
  }
  return c;
}

export const CLAUDE_STATES: ClaudeState[] = ["running", "awaiting", "done"];
