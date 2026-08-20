/**
 * skills-api client. Per-user skill manager backend on the devvm (:7688),
 * same-origin behind the ingress which injects X-Authentik-Username. Shapes
 * mirror skills-api/handlers.go and skillscan's Skill/Plugin.
 *
 * Every call maps a non-2xx to a SkillsApiError carrying the status, because the
 * panel says different things for each: 409 is "you already have one of those,
 * here is the diff", 404 is "that skill is gone — someone removed it since the
 * list was drawn", 403 is "not your account to touch".
 */
import {
  skillActionUrl,
  skillDiffUrl,
  skillViewUrl,
  skillsUrl,
} from "./config";

export class SkillsApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SkillsApiError";
  }
}

/** One of the caller's own skills. Mirrors skillscan.Skill + skillRow. */
export interface Skill {
  name: string;
  description?: string;
  files: number;
  executable: number;
  bytes: number;
  hash: string;
  enabled: boolean;
  symlink?: boolean;
  /** Set when this skill was installed from another user. */
  from?: string;
  sourceHash?: string;
  installedAt?: string;
  /** This copy no longer matches the hash recorded at install: edited here. */
  locallyModified?: boolean;
  /** The user it came from has changed theirs since: there is something to pull. */
  updateAvailable?: boolean;
}

/** A marketplace plugin. Switched on and off as a whole, never copied. */
export interface Plugin {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  enabled: boolean;
  latest?: string;
  stale?: boolean;
}

export type Verdict = "absent" | "same" | "differs";

/** One of another user's skills, with how it stands against the caller's own. */
export interface PeerSkill extends Skill {
  verdict: Verdict;
}

export interface PeerBlock {
  user: string;
  skills?: PeerSkill[];
  /** That account's skills could not be read this time. */
  unreachable?: boolean;
}

export interface Inventory {
  user: string;
  skills: Skill[];
  plugins: Plugin[];
  peers: PeerBlock[];
}

export interface SkillFile {
  rel: string;
  exec?: boolean;
  bytes: number;
}

export interface SkillView {
  owner: string;
  name: string;
  skillmd: string;
  files?: SkillFile[];
  stat?: {
    files: number;
    executable: number;
    bytes: number;
    hash: string;
    description?: string;
  };
}

export interface SkillDiff {
  owner: string;
  name: string;
  verdict: Verdict;
  diff: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // A dropped connection and a refused one are the same thing to the panel:
    // it could not ask. Status 0 distinguishes it from anything the server said.
    throw new SkillsApiError(0, e instanceof Error ? e.message : "network error");
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).trim();
    throw new SkillsApiError(res.status, text || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function fetchInventory(): Promise<Inventory> {
  return request<Inventory>(skillsUrl());
}

export function fetchView(owner: string, name: string): Promise<SkillView> {
  return request<SkillView>(skillViewUrl(owner, name));
}

export function fetchDiff(owner: string, name: string): Promise<SkillDiff> {
  return request<SkillDiff>(skillDiffUrl(owner, name));
}

/** Install a peer's skill. `replace` backs the caller's own copy up first;
 *  without it a taken name answers 409 and nothing changes. */
export function installSkill(
  owner: string,
  name: string,
  replace = false,
): Promise<{ name: string; from: string; backup: string }> {
  return post(skillActionUrl("install"), { owner, name, replace });
}

/** Switch a skill or plugin on or off. `id` is "<name>@skills-dir" for a loose
 *  skill, "<plugin>@<marketplace>" for a plugin. */
export function toggleSkill(id: string, enabled: boolean): Promise<unknown> {
  return post(skillActionUrl("toggle"), { id, enabled });
}

/** Back a skill up and drop it. */
export function removeSkill(name: string): Promise<{ name: string; backup: string }> {
  return post(skillActionUrl("remove"), { name });
}

/** What a permanent delete did. Mirrors skillscan.DeleteResult. */
export interface DeleteResult {
  wasSymlink?: boolean;
  target?: string;
  purgedBackups: number;
  bytes: number;
}

/** Delete a skill for good: the directory, every backup of it, its enabled state
 *  and its provenance. Distinct from removeSkill, which keeps a backup. */
export function deleteSkill(name: string): Promise<{ name: string; deleted: DeleteResult }> {
  return post(skillActionUrl("delete"), { name });
}

/** Uninstall a marketplace plugin and reclaim its cache. */
export function uninstallPlugin(
  plugin: string,
): Promise<{ plugin: string; freed: number; output: string }> {
  return post(skillActionUrl("plugin-uninstall"), { plugin });
}

/** One installable skill found in a source repo. */
export interface SourceSkill {
  name: string;
  path: string;
  description?: string;
}

/** One plugin a source repo's marketplace manifest offers. */
export interface SourcePlugin {
  name: string;
  description?: string;
}

/** What one read-only look at a repo concluded. A repo can be both kinds. */
export interface SourceInfo {
  owner: string;
  repo: string;
  ref?: string;
  skills?: SourceSkill[];
  marketplace?: string;
  plugins?: SourcePlugin[];
  /** How many were left out of the lists above, so the panel can say so. */
  skillsCut?: number;
  pluginsCut?: number;
  knownOwner: boolean;
}

/** Look at a repo without installing anything: what it offers, and whether it is
 *  a skills repo, a plugin marketplace, or both. */
export function inspectSource(source: string): Promise<SourceInfo> {
  return post(skillActionUrl("source/inspect"), { source });
}

/** Install the chosen names from a repo, by running the ecosystem's own
 *  installer as you (docs/adr/0012). */
export function installFromSource(
  source: string,
  kind: "skills" | "plugins",
  names: string[],
): Promise<{ source: string; kind: string; names: string[]; output: string }> {
  return post(skillActionUrl("source/install"), { source, kind, names });
}

/** Update one marketplace plugin by running the caller's own claude CLI. */
export function updatePlugin(plugin: string): Promise<{ plugin: string; output: string }> {
  return post(skillActionUrl("plugin-update"), { plugin });
}

/** Respawn one session's Claude with --continue so it loads the new skill set.
 *  409 when that session is mid-turn. */
export function restartSession(session: string): Promise<{ session: string; restarted: boolean }> {
  return post(skillActionUrl("restart"), { session });
}
