/**
 * Session-navigation pure logic (feature-inventory Cat.2 "Alt-hold numbered
 * chips + Alt+1..9/Alt+0 attach-Nth" and the dev-flow next/prev/next-awaiting
 * hops). Ported from the vanilla frontend/index.html runAppCommand branches
 * (index.html:9037-9111) + syncAltBadges labelling (9127). No DOM, no Solid.
 *
 * The flat order is the VISIBLE sidebar order (paint order — own groups in
 * groupSeq order, then the Shared-with-me foreign list), the same order the
 * Alt-hold badges land on, so Alt+N and the Nth badge always agree.
 */
import type { SidebarModel } from "../components/lobby.logic";

/** Command prefix for the "attach the Nth sidebar card" family. */
export const ATTACH_PREFIX = "session.attach.";

/** A navigable session target: name + optional foreign owner. */
export interface OrderedSession {
  name: string;
  owner?: string;
}

/**
 * The 0-based session index a `session.attach.N` command targets, or null when
 * the command is not an attach command / N is not a positive integer.
 * "session.attach.1" -> 0 ... "session.attach.10" -> 9 (Alt+0 -> the 10th).
 */
export function attachIndex(cmd: string): number | null {
  if (!cmd.startsWith(ATTACH_PREFIX)) return null;
  const n = Number(cmd.slice(ATTACH_PREFIX.length));
  if (!Number.isInteger(n) || n < 1) return null;
  return n - 1;
}

/**
 * The chip label for the card at flat index `i`: "1".."9" then "0" on the tenth
 * (so the tenth card reads "0", matching Alt+0 -> session.attach.10).
 */
export function badgeLabel(index: number): string {
  return index === 9 ? "0" : String(index + 1);
}

/**
 * Flatten the sidebar model into the paint-order session list: own group members
 * (in groupSeq order) followed by the foreign Shared-with-me list.
 */
export function flatSessionOrder(model: SidebarModel): OrderedSession[] {
  const out: OrderedSession[] = [];
  for (const g of model.groups) {
    for (const s of g.sessions) out.push({ name: s.name });
  }
  for (const s of model.foreign) {
    out.push(s.owner ? { name: s.name, owner: s.owner } : { name: s.name });
  }
  return out;
}

/**
 * The next/previous session relative to `current` in the flat order, wrapping.
 * With no current (or current not in the list): dir 1 -> first, dir -1 -> last.
 */
export function cycleTarget(
  order: OrderedSession[],
  current: string | null,
  dir: 1 | -1,
): OrderedSession | null {
  if (!order.length) return null;
  const i = current ? order.findIndex((s) => s.name === current) : -1;
  if (i < 0) return dir === 1 ? order[0]! : order[order.length - 1]!;
  return order[(i + dir + order.length) % order.length]!;
}

/**
 * The next session whose Claude is `awaiting` input, in flat order starting
 * AFTER `current` (wraps; may return `current` itself if it is the only awaiting
 * one). null when none are awaiting.
 */
export function nextAwaitingTarget(
  order: OrderedSession[],
  stateOf: (name: string) => string | undefined,
  current: string | null,
): OrderedSession | null {
  if (!order.length) return null;
  const start = current ? order.findIndex((s) => s.name === current) : -1;
  for (let k = 1; k <= order.length; k++) {
    const s = order[(start + k + order.length) % order.length]!;
    if (stateOf(s.name) === "awaiting") return s;
  }
  return null;
}
