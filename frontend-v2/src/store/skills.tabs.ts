/**
 * Which tab the Skills panel is showing, and what belongs on it.
 *
 * The panel needs tabs because the lists are long: 38 own skills, 7 plugins, 21
 * of a peer's and every live session do not read as one column, which is what
 * moved this surface out of the Settings overlay in the first place. Keeping the
 * tab set and the filtering pure means the shape of the panel is testable
 * without mounting it.
 */
import type { Inventory, PeerBlock, PeerSkill, Plugin, Skill } from "../lib/skills-api";
import { installableCount, peersWorthShowing } from "./skills.logic";

/** A tab's identity. A peer tab carries the user it belongs to. */
export type TabId = "mine" | "plugins" | "sessions" | `peer:${string}`;

export interface Tab {
  id: TabId;
  label: string;
  /** The number in the tab, or 0 for none. */
  count: number;
  /** Set on a peer tab; "" otherwise. */
  peer: string;
}

/**
 * The tab strip: the caller's own skills first, then one tab per other account,
 * then plugins, then sessions.
 *
 * Peers come second because taking a skill from someone is the reason this panel
 * exists; plugins and sessions are the settings-shaped ends of it. A peer whose
 * skills could not be read still gets a tab, so "unreachable" is visible rather
 * than looking like an account with nothing in it.
 */
export function tabsFor(
  inv: Inventory | null,
  sessions: ReadonlyArray<unknown> = [],
): Tab[] {
  if (!inv) return [];
  const tabs: Tab[] = [
    { id: "mine", label: "Mine", count: inv.skills.length, peer: "" },
  ];
  for (const p of peersWorthShowing(inv.peers ?? [])) {
    tabs.push({
      id: `peer:${p.user}`,
      label: p.user,
      count: p.unreachable ? 0 : installableCount(p),
      peer: p.user,
    });
  }
  if ((inv.plugins ?? []).length > 0) {
    tabs.push({ id: "plugins", label: "Plugins", count: inv.plugins.length, peer: "" });
  }
  if (sessions.length > 0) {
    tabs.push({ id: "sessions", label: "Sessions", count: sessions.length, peer: "" });
  }
  return tabs;
}

/**
 * Which tab to show, given what the panel last had selected.
 *
 * A remembered tab that no longer exists — a peer who left the roster, plugins
 * all uninstalled — falls back to the first rather than rendering an empty
 * panel with a selected tab nobody can see.
 */
export function resolveTab(tabs: Tab[], wanted: TabId | ""): TabId | "" {
  const first = tabs[0];
  if (!first) return "";
  if (wanted && tabs.some((t) => t.id === wanted)) return wanted;
  return first.id;
}

/** matches is the filter box's rule: a case-insensitive substring of the name or
 *  the description. Both, because "what was the skill that does X" is as common
 *  a way to look as remembering its name. */
export function matches(
  s: { name: string; description?: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    s.name.toLowerCase().includes(q) ||
    (s.description ?? "").toLowerCase().includes(q)
  );
}

/** The caller's own skills on the Mine tab, filtered. */
export function mineRows(inv: Inventory | null, query: string): Skill[] {
  return (inv?.skills ?? []).filter((s) => matches(s, query));
}

/** One peer's skills, filtered. */
export function peerRows(
  inv: Inventory | null,
  peer: string,
  query: string,
): { block: PeerBlock | undefined; skills: PeerSkill[] } {
  const block = (inv?.peers ?? []).find((p) => p.user === peer);
  return { block, skills: (block?.skills ?? []).filter((s) => matches(s, query)) };
}

/** Plugins, filtered on the name (they have no description on the wire). */
export function pluginRows(inv: Inventory | null, query: string): Plugin[] {
  return (inv?.plugins ?? []).filter((p) => matches({ name: p.name }, query));
}

/** A one-line summary for the tab's empty state, which differs by reason: an
 *  account with nothing, a filter that matched nothing, or a peer we could not
 *  read. Saying which is the difference between "look elsewhere" and "try a
 *  different word". */
export function emptyReason(
  kind: "mine" | "peer" | "plugins",
  hasAny: boolean,
  query: string,
  unreachable = false,
): string {
  if (unreachable) return "Could not read that account's skills just now.";
  if (!hasAny) {
    return kind === "plugins"
      ? "No marketplace plugins installed."
      : kind === "peer"
        ? "That account has no skills."
        : "No skills in this account yet — take one from someone else's tab.";
  }
  return query.trim() ? `Nothing matches “${query.trim()}”.` : "";
}
