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
 *    slot (the sentinel stays in the sequence for reordering/capture) — so the
 *    reorder CONTROLS must measure `visibleGroupSeqTokens`, not the raw token
 *    sequence, or they offer the user a step onto a slot nobody can see.
 *  - foreign sessions (owner ≠ me) are a separate Shared-with-me list, owner-major.
 *  - the dock session (hidden scratch shell) is never rendered and never touched.
 */
import type { Layout, LayoutProject, Session } from "../types/lobby";

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

/** The token a rendered group occupies in the sequence above. */
export function groupToken(g: RenderGroup): string {
  return g.kind === "ungrouped" ? "u" : "p:" + g.name;
}

/**
 * Does this group render? Projects always do (so they can be seen and dropped
 * into); the Ungrouped sentinel hides while empty. The sidebar's filter and the
 * move-up/down bounds read this one predicate deliberately — measuring the menu
 * in token space while the user reads visible space is what made an edge
 * group's Move item enabled and its first click a no-op.
 */
export function isGroupVisible(g: RenderGroup): boolean {
  return g.kind === "project" || g.sessions.length > 0;
}

/** The group sequence as the USER sees it: tokens minus the hidden sentinel. */
export function visibleGroupSeqTokens(model: SidebarModel): string[] {
  return model.groups.filter(isGroupVisible).map(groupToken);
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
  // Live own sessions referenced by no group, in a stable order (creation time
  // asc, then name) so the sidebar doesn't jitter.
  const leftovers = [...ownByName.values()]
    .filter((s) => !referenced.has(s.name))
    .sort((a, b) => a.created - b.created || a.name.localeCompare(b.name));
  // A leftover that names a project of its own goes there rather than to
  // Ungrouped. tmux-api stamps `project` on the session record; the layout is
  // the arrangement the user made of it, so the layout wins wherever it has an
  // opinion — but a session it has never placed used to fall through to
  // Ungrouped even while the project it named sat beside it reading 0.
  for (const s of leftovers) {
    const claimed = s.project ? projectMembers.get(s.project) : undefined;
    (claimed ?? ungroupedMembers).push(s);
  }

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

/** Where a card was dropped: the card it landed on, and which side of it. */
export interface DropAnchor {
  /** name of the card the drop landed on. */
  name: string;
  side: "above" | "below";
}

/**
 * Fold the RENDERED Ungrouped order back into layout.ungrouped, appending the
 * leftovers (live own sessions referenced by no group, which deriveSidebar
 * sweeps in after layout.ungrouped) in the order they render.
 *
 * Render-order preserving by construction: the sweep puts the leftovers after
 * every resolved entry, so appending them keeps the same live sequence. This is
 * how a leftover acquires the raw position it has never had — needed before an
 * anchored insert, because an anchor with no raw index cannot be resolved.
 */
export function materializeUngrouped(layout: Layout, renderedUngrouped: string[]): Layout {
  const have = new Set(layout.ungrouped);
  const missing = renderedUngrouped.filter((n) => !have.has(n));
  if (missing.length === 0) return layout;
  return { ...layout, ungrouped: [...layout.ungrouped, ...missing] };
}

/**
 * The same fold for ANY group ("" = ungrouped). A project has swept-in members
 * too — the sessions whose own record names it that the layout has never placed
 * — and they render in positions no raw index backs, so an anchored drop among
 * them resolves against nothing and silently appends. Same construction, same
 * guarantee: the sweep renders after every resolved entry, so appending the
 * missing names preserves the order already on screen.
 */
export function materializeGroup(layout: Layout, group: string, rendered: string[]): Layout {
  if (group === "") return materializeUngrouped(layout, rendered);
  const project = layout.projects.find((p) => p.name === group);
  if (!project) return layout;
  const have = new Set(project.sessions);
  const missing = rendered.filter((n) => !have.has(n));
  if (missing.length === 0) return layout;
  return {
    ...layout,
    projects: layout.projects.map((p) =>
      p.name === group ? { ...p, sessions: [...p.sessions, ...missing] } : p,
    ),
  };
}

/**
 * Move `name` into `targetGroup` ("" = ungrouped) immediately above/below the
 * card it was dropped on.
 *
 * The rendered order and the raw layout arrays deliberately diverge (see the
 * header): dead refs are filtered OUT of the render and leftovers swept IN, so a
 * rendered index is not a layout index and splicing by one silently corrupts the
 * other. Resolving the anchor here, against the raw list the splice targets,
 * is what keeps a drop landing where the indicator promised. An anchor that is
 * not in the target list appends.
 */
export function moveSessionToAnchor(
  layout: Layout,
  name: string,
  targetGroup: string,
  anchor: DropAnchor,
): Layout {
  const list =
    targetGroup === ""
      ? layout.ungrouped
      : (layout.projects.find((p) => p.name === targetGroup)?.sessions ?? []);
  // moveSession strips `name` before splicing, so the anchor's index has to be
  // read from the list in that same post-strip shape.
  const at = list.filter((s) => s !== name).indexOf(anchor.name);
  if (at < 0) return moveSession(layout, name, targetGroup);
  return moveSession(layout, name, targetGroup, anchor.side === "below" ? at + 1 : at);
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

/**
 * Add a new (empty) project directly ABOVE the Ungrouped slot. No-op if the
 * name is already taken.
 *
 * `ungroupedIndex` counts the projects that sit above the sentinel, so a
 * project appended to `projects` always landed BELOW Ungrouped — the user named
 * a project and it appeared under the loose sessions, off where they were not
 * looking. Slotting it in at the sentinel and pushing the sentinel down one
 * keeps every existing group in the order the user put it in.
 */
export function addProject(layout: Layout, name: string, dir?: string): Layout {
  if (layout.projects.some((p) => p.name === name)) return layout;
  const project: LayoutProject = { name, sessions: [] };
  if (dir) project.dir = dir;
  const at = clamp(layout.ungroupedIndex ?? 0, 0, layout.projects.length);
  return {
    ...layout,
    projects: [...layout.projects.slice(0, at), project, ...layout.projects.slice(at)],
    ungroupedIndex: at + 1,
  };
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

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Structural equality for two layouts.
 *
 * Every poll re-parses GET /api/layout into a FRESH object, so reference
 * equality says "changed" on data that is byte-identical — and the sidebar's
 * <For> (reference-keyed) then tears down and re-creates every group. This is
 * the layout signal's `equals`, so an unchanged document is a no-op.
 */
export function sameLayout(a: Layout, b: Layout): boolean {
  if (a === b) return true;
  if (a.version !== b.version || a.ungroupedIndex !== b.ungroupedIndex) return false;
  if (!sameList(a.ungrouped, b.ungrouped)) return false;
  if (a.projects.length !== b.projects.length) return false;
  for (let i = 0; i < a.projects.length; i++) {
    const p = a.projects[i]!;
    const q = b.projects[i]!;
    if (p.name !== q.name || (p.dir ?? "") !== (q.dir ?? "")) return false;
    if (!sameList(p.sessions, q.sessions)) return false;
  }
  const ad = a.dock;
  const bd = b.dock;
  if (!ad !== !bd) return false;
  if (ad && bd) {
    if (ad.session !== bd.session || ad.visible !== bd.visible || (ad.dir ?? "") !== (bd.dir ?? "")) {
      return false;
    }
  }
  return true;
}

function sameSessions(a: Session[], b: Session[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** Same group, member for member — including the project fields the header reads. */
function sameGroup(a: RenderGroup, b: RenderGroup): boolean {
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    (a.project?.dir ?? "") === (b.project?.dir ?? "") &&
    sameSessions(a.sessions, b.sessions)
  );
}

/**
 * Re-use the PREVIOUS render model's objects wherever the freshly-derived one
 * says exactly the same thing.
 *
 * deriveSidebar allocates a new SidebarModel — and a new RenderGroup per group —
 * on every recompute, and the sidebar's <For> keys on reference: without this,
 * every recompute tore down and re-created every group and card node. It did not
 * take a real change to trigger one. /sessions spans OS users, so the same
 * sessions come back in a different ORDER; any session appearing or dying
 * anywhere (someone else's included) shifts the array; and each of those makes
 * the memo re-run. The user paid for it with an open menu, a half-typed name, a
 * drag, or the second click of a double-click landing on a node that no longer
 * existed.
 *
 * Session objects are NOT compared field by field: the store reconciles them by
 * name, so an unchanged session keeps its identity and a changed one updates in
 * place through the same proxy — which is exactly the granular repaint we want
 * (a moving timer must not cost a new DOM node either).
 */
export function stabilizeModel(
  prev: SidebarModel | undefined,
  next: SidebarModel,
): SidebarModel {
  if (!prev) return next;
  const groups =
    prev.groups.length === next.groups.length
      ? next.groups.map((g, i) => (sameGroup(prev.groups[i]!, g) ? prev.groups[i]! : g))
      : next.groups;
  const foreign = sameSessions(prev.foreign, next.foreign) ? prev.foreign : next.foreign;
  const groupsUnchanged =
    groups.length === prev.groups.length && groups.every((g, i) => g === prev.groups[i]);
  if (groupsUnchanged && foreign === prev.foreign) return prev;
  return { groups, foreign };
}

// ---- Display helpers -----------------------------------------------------

/**
 * Ported verbatim from the vanilla app (frontend/index.html relativeTime),
 * plus a floor at zero: `epochSec` is stamped by the server clock and
 * `Date.now()` reads the viewer's, so a viewer whose clock trails the server's
 * sees freshly-active sessions in its own future and would render "-239s ago".
 * `!epochSec` stays a blank cell — that is the no-timestamp case, not age 0.
 */
export function relativeTime(epochSec: number): string {
  if (!epochSec) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - epochSec);
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

/**
 * Human phrase for a session's Claude state (tooltip / a11y).
 *
 * `unseen` gets its own wording rather than a second attribute, so the one
 * distinction the app-icon badge counts reaches a tooltip and a screen reader
 * as words. A colour and an opacity carry it for everyone else, and neither
 * survives being read aloud.
 */
export function stateLabel(state: string | undefined, unseen = false): string {
  switch (state) {
    case "running":
      return "Working";
    case "awaiting":
      return "Awaiting input";
    case "done":
      return unseen ? "Done, not seen yet" : "Done";
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
