/**
 * PURE session ORDERING — which order the sidebar's cards come in, and what a
 * drag does while something other than the user is deciding that.
 *
 * The sidebar has always had exactly one order: the arrangement saved in the
 * layout, rearranged by dragging. That serves someone who has curated their
 * list and nobody else — a session started a minute ago lands wherever the
 * layout puts it, which for a name it has never seen is the END of its group.
 * So the order is a MODE (Viktor, 2026-08-22): `manual` is the layout as
 * before, `created` and `active` are derived from the session's own stamps, and
 * both run NEWEST FIRST. `created` is the default, for existing users with a
 * full layout as much as for new ones.
 *
 * Two contracts this module exists to keep:
 *
 *  - the ordering acts WITHIN a group, never across the list. Grouping is the
 *    arrangement the user made; the ordering is a view over each group's
 *    members. Shared-with-me is left alone entirely — it has no manual order to
 *    switch away from and it is owner-major so you can tell whose is whose.
 *  - reference identity is load-bearing. deriveSidebar's model feeds a
 *    reference-keyed <For> through `stabilizeModel`, so anything that did not
 *    have to change is handed back as the same object.
 */
import type { Layout, Session } from "../types/lobby";
import type { SidebarModel } from "./lobby.logic";

/** Which order the session list is in. */
export type SessionOrder = "manual" | "created" | "active";

/** The orderings, in the order the picker offers them. */
export const SESSION_ORDERS: readonly SessionOrder[] = ["created", "active", "manual"];

/**
 * The default, and deliberately not `manual`.
 *
 * A saved layout is not evidence that somebody chose their arrangement over a
 * fresh list — most of it is where sessions happened to be appended. Newest
 * first is the answer that needs no curation, so it is what everyone gets until
 * they say otherwise, whether or not they already have a layout.
 */
export const DEFAULT_SESSION_ORDER: SessionOrder = "created";

export function isSessionOrder(v: unknown): v is SessionOrder {
  return v === "manual" || v === "created" || v === "active";
}

/**
 * What the picker calls each ordering.
 *
 * `hint` is not decoration: "Created" does not say which end the new sessions
 * come out of, and a list that guessed wrong is a list you have to scroll to
 * check. Both time orderings run newest-first and both say so.
 *
 * `short` is for the header button, which is a 40px box on a phone and loses
 * its label entirely below 520px — so it has to be a word, not a sentence.
 */
export const SESSION_ORDER_TEXT: Record<
  SessionOrder,
  { label: string; hint: string; short: string }
> = {
  created: { label: "Created", hint: "newest first", short: "Newest" },
  active: { label: "Last active", hint: "newest first", short: "Active" },
  manual: { label: "Manual", hint: "drag to arrange", short: "Manual" },
};

/**
 * When a human last had hands on this session.
 *
 * `lastDrive`, never `lastActivity`. tmux bumps `#{session_activity}` on ANY
 * attach, a read-only one included (tmux-api `lastdrive.go`, measured
 * 2026-08-18: `tmux attach -r` on an idle session moved it by 1s), so ordering
 * on it would fire a session to the top of the list for being WATCHED — and it
 * would disagree with the relative time printed on the card, which reads
 * `lastDrive` for exactly the same reason.
 *
 * Creation time is the fallback, mirroring what tmux-api itself does when it
 * seeds `@last_drive` (`drivesToStamp`: creating a session attaches read-write,
 * so creation is a truthful lower bound). A server that predates the field
 * sends no stamp at all, and without this every one of its sessions would tie.
 */
export function lastActiveAt(s: Session): number {
  return s.lastDrive || s.created;
}

/** Newest first, with a deterministic tail so the list cannot jitter. */
function compare(order: SessionOrder, a: Session, b: Session): number {
  if (order === "active") {
    const d = lastActiveAt(b) - lastActiveAt(a);
    if (d !== 0) return d;
  }
  // /sessions returns the same sessions in a different order run to run (it
  // spans OS users), and sessions created in the same second are ordinary — a
  // restore makes a whole layout's worth at once. Name is the last word.
  return b.created - a.created || a.name.localeCompare(b.name);
}

/**
 * One group's members in `order`. `manual` hands the array straight back
 * (same reference — see the header), anything else returns a fresh sorted copy
 * and leaves the caller's array untouched.
 */
export function sortSessions(sessions: Session[], order: SessionOrder): Session[] {
  if (order === "manual") return sessions;
  return [...sessions].sort((a, b) => compare(order, a, b));
}

function sameOrder(a: Session[], b: Session[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * Apply an ordering to every group of a derived model, keeping the group
 * sequence and the Shared-with-me list exactly as they were.
 *
 * Hands back the SAME model — and the same RenderGroup objects — wherever the
 * sort had nothing to do, so a group that was already newest-first costs no DOM.
 */
export function applySessionOrder(model: SidebarModel, order: SessionOrder): SidebarModel {
  if (order === "manual") return model;
  let changed = false;
  const groups = model.groups.map((g) => {
    const sessions = sortSessions(g.sessions, order);
    if (sameOrder(sessions, g.sessions)) return g;
    changed = true;
    return { ...g, sessions };
  });
  return changed ? { groups, foreign: model.foreign } : model;
}

/**
 * Freeze what is ON SCREEN into the layout: every group's `sessions` array
 * becomes the order its cards are painted in.
 *
 * This is what a positioned drop does before it lands while a time ordering is
 * active. A drop names a place ("above this card") and the layout is the only
 * place a position can be written, so the list has to hand ordering back to the
 * user for the drop to mean anything at all — and capturing first is what makes
 * that switch invisible. Every other card keeps the seat it already had, and
 * the only thing that moves is the one the finger moved. Capturing the WHOLE
 * document rather than the group dragged in is the same argument one step out:
 * manual is a decision about the list, so leaving the other groups to snap back
 * to their stale arrays would move cards nobody touched.
 *
 * Names the render does not show are kept, after the visible ones: a
 * dead-but-assigned ref is how an OOM restore puts a session back in its
 * project, and losing it here would quietly regroup somebody's work. The one
 * exception is a name that renders in a DIFFERENT group — deriveSidebar
 * resolves each name to exactly one group, and PUT /api/layout rejects a
 * duplicate outright, so the stale copy goes rather than turning a drag into a
 * "Couldn't save layout".
 */
export function captureVisibleOrder(layout: Layout, model: SidebarModel): Layout {
  const rendered = new Map<string, string[]>();
  for (const g of model.groups) {
    rendered.set(g.kind === "ungrouped" ? "" : g.name, g.sessions.map((s) => s.name));
  }
  const renderedAnywhere = new Set<string>();
  for (const list of rendered.values()) for (const n of list) renderedAnywhere.add(n);

  const capture = (raw: string[], group: string): string[] => {
    const shown = rendered.get(group);
    if (!shown) return raw; // a group the model does not carry: leave it be
    const here = new Set(shown);
    const kept = raw.filter((n) => !here.has(n) && !renderedAnywhere.has(n));
    return [...shown, ...kept];
  };

  return {
    ...layout,
    projects: layout.projects.map((p) => ({ ...p, sessions: capture(p.sessions, p.name) })),
    ungrouped: capture(layout.ungrouped, ""),
  };
}
