/**
 * Pure logic behind the Skills settings group: what a row says about itself, what
 * action a peer's skill offers, and which sessions can pick up a change.
 *
 * Separated from the store the way dock.logic / preview.logic are, so the rules
 * that decide what a person reads are testable without mounting anything.
 */
import type { PeerBlock, PeerSkill, Plugin, Skill } from "../lib/skills-api";

export type Tone = "muted" | "accent" | "warn";

export interface RowStatus {
  /** Short right-hand label for the row. */
  label: string;
  tone: Tone;
  /** Longer form for the expanded row; "" when the label says it all. */
  detail?: string;
}

/**
 * What one of the caller's own skills says about itself.
 *
 * The order matters: an update the owner published is the thing worth acting on,
 * so it wins over provenance alone. A local edit is reported rather than fixed —
 * it is somebody's deliberate change, and the panel's job is to say so before an
 * update would replace it.
 */
export function skillStatus(s: Skill): RowStatus {
  if (s.updateAvailable && s.from) {
    return {
      label: `from ${s.from} · update`,
      tone: "accent",
      detail: s.locallyModified
        ? `${s.from} changed their copy, and yours has local edits — updating backs yours up first.`
        : `${s.from} has changed their copy since you installed it.`,
    };
  }
  if (s.locallyModified && s.from) {
    return {
      label: `from ${s.from} · edited`,
      tone: "muted",
      detail: `Installed from ${s.from} and changed here since.`,
    };
  }
  if (s.from) return { label: `from ${s.from}`, tone: "muted" };
  if (s.symlink) return { label: "own · linked", tone: "muted", detail: "This entry is a symlink." };
  return { label: "own", tone: "muted" };
}

/** What a marketplace plugin row says: its version, and whether a newer one is
 *  advertised by the marketplace it came from. */
export function pluginStatus(p: Plugin): RowStatus {
  if (p.stale && p.latest) {
    return { label: `${p.version} · ${p.latest}`, tone: "accent", detail: `Version ${p.latest} is available.` };
  }
  return { label: p.version || "unknown", tone: "muted" };
}

/**
 * What a peer's skill offers.
 *
 * "same" offers nothing: the two copies are byte-identical, so installing would
 * change nothing. "differs" is a replace, which is a decision — it needs the diff
 * first — and "absent" is a plain install.
 */
export function peerAction(s: PeerSkill): "install" | "replace" | "none" {
  if (s.verdict === "absent") return "install";
  if (s.verdict === "differs") return "replace";
  return "none";
}

/** The label a peer row carries beside its name. */
export function peerLabel(s: PeerSkill): RowStatus {
  switch (s.verdict) {
    case "same":
      return { label: "same as yours", tone: "muted" };
    case "differs":
      return { label: "differs", tone: "warn", detail: "You have a different skill of this name." };
    default:
      return { label: "", tone: "muted" };
  }
}

/** How many of a peer's skills are actually takeable — the count worth showing
 *  in the group heading. A skill identical to yours is not one of them. */
export function installableCount(peer: PeerBlock): number {
  return (peer.skills ?? []).filter((s) => peerAction(s) !== "none").length;
}

/** Peers with something to offer, in a stable order. A peer whose skills could
 *  not be read is kept: "unreachable" is information, not an empty list. */
export function peersWorthShowing(peers: PeerBlock[]): PeerBlock[] {
  return [...peers]
    .filter((p) => p.unreachable || (p.skills ?? []).length > 0)
    .sort((a, b) => a.user.localeCompare(b.user));
}

export interface SessionRow {
  name: string;
  state: string;
  /** Whether a restart may be offered: a session mid-turn must finish first. */
  restartable: boolean;
}

/**
 * Which of the caller's sessions are running an older skill set, and which of
 * those may be restarted.
 *
 * Every live session is affected — a skill is read when Claude starts — so the
 * list is all of them, with the mid-turn ones marked. Running first, so it is
 * obvious why some have no button, then by name for a stable order.
 */
export function restartTargets(
  sessions: ReadonlyArray<{ name: string; state?: string }>,
): SessionRow[] {
  return sessions
    .map((s) => {
      const state = s.state || "idle";
      return { name: s.name, state, restartable: state !== "running" };
    })
    .sort((a, b) => {
      if (a.restartable !== b.restartable) return a.restartable ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
}

/** Human size for a row: skills are small, so KB with no decimals is enough. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The one-line summary under an expanded row: what you would be taking on. */
export function fileSummary(s: Skill): string {
  const parts = [`${s.files} file${s.files === 1 ? "" : "s"}`];
  if (s.executable > 0) parts.push(`${s.executable} executable`);
  parts.push(humanBytes(s.bytes));
  return parts.join(" · ");
}
