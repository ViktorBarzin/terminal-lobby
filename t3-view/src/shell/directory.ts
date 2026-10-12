/**
 * Which lobby sessions are T3 threads, under which ids and in which projects.
 *
 * Thread ids are rename-proof keys. A session is renamed from its title a few
 * seconds into its first turn (ADR-0022), so its name is not an id. The key is
 * the session's birth name (bornAs, the minted id it was created with, which
 * tmux-api stamps at the first rename), or for a session named by hand the
 * name it had when this directory first saw it, carried across renames by
 * tmux's own session id ($N). That is the rule the lobby's own frontend keys
 * terminals by (frontend-v2 store/keepalive.ts keyOf). A session T3 created
 * keeps the thread id T3 minted for it (aliases.ts). Someone else's session
 * is `<owner>~<key>`, since two users can have sessions of the same name.
 *
 * Grouping follows the lobby's sidebar (frontend-v2 lobby.logic.ts
 * deriveSidebar): the layout's projects first, then a session's own `project`
 * for one the layout never placed, then Ungrouped. System and Caller sessions
 * (made by a harness or agent-api) go to one System project, and sessions
 * shared with this user to one project per owner. Only Claude sessions are
 * threads: pi and codex keep the Solid view.
 */
import { type OrchestrationProjectShell, ProjectId, ThreadId } from "@t3tools/contracts";

import type { LobbyLayout, LobbySession } from "../lobby/api.ts";

export interface DirectoryEntry {
  readonly threadId: ThreadId;
  /** The session's tmux name now: what every lobby route takes. */
  readonly name: string;
  /** Set for a session another user owns. */
  readonly owner?: string;
  /** "ro" or "rw" for someone else's session; undefined for the user's own. */
  readonly access?: string;
  readonly projectId: ProjectId;
  readonly session: LobbySession;
}

export interface DirectoryProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  /** The layout project's name, for placing a new session; undefined for a synthesised group. */
  readonly layoutName?: string;
  /** The directory a new session starts in. */
  readonly dir: string;
}

export const UNGROUPED_PROJECT = ProjectId.make("ungrouped");
export const SYSTEM_PROJECT = ProjectId.make("system");
const projectIdOf = (name: string): ProjectId => ProjectId.make(`project:${name}`);
const sharedProjectOf = (owner: string): ProjectId => ProjectId.make(`shared:${owner}`);

/** A session made by something other than the lobby's own create path (origin.go). */
function isSystem(s: LobbySession): boolean {
  if (s.caller !== undefined) return true;
  return s.origin !== "user" || /^(qa-|t3e2e-|tlp-t)/.test(s.name);
}

export class SessionDirectory {
  readonly #osUser: string;
  readonly #home: string;
  /** tmux session id -> key, for following a hand-named session's renames. */
  readonly #keyByTmuxId = new Map<string, string>();
  #entries = new Map<ThreadId, DirectoryEntry>();
  #projects: DirectoryProject[] = [];

  readonly #alias: (minted: string) => string | undefined;

  /**
   * `alias` names the thread id T3 gave a session it created (aliases.ts),
   * looked up by the session's minted birth name.
   */
  constructor(
    osUser: string,
    options: {
      readonly home?: string;
      readonly alias?: (minted: string) => string | undefined;
    } = {},
  ) {
    this.#osUser = osUser;
    this.#home = options.home ?? `/home/${osUser}`;
    this.#alias = options.alias ?? (() => undefined);
  }

  get entries(): ReadonlyArray<DirectoryEntry> {
    return [...this.#entries.values()];
  }

  get projects(): ReadonlyArray<DirectoryProject> {
    return this.#projects;
  }

  byId(id: string): DirectoryEntry | undefined {
    return this.#entries.get(id as ThreadId);
  }

  /**
   * The user's own thread for a key the lobby frames it by (frontend-v2
   * keyOf: bornAs, else the name now). That is the thread id itself except
   * for a session T3 created, which keeps T3's id, and a hand-named session
   * renamed while this directory watched, which keeps its first name.
   */
  resolve(key: string): DirectoryEntry | undefined {
    const direct = this.#entries.get(key as ThreadId);
    if (direct !== undefined) return direct;
    for (const entry of this.#entries.values()) {
      if (entry.owner !== undefined) continue;
      if (entry.session.bornAs === key || entry.name === key) return entry;
    }
    return undefined;
  }

  /**
   * The other way from `resolve`: the key the lobby frames the user's own
   * thread by (frontend-v2 keyOf: bornAs, else the name now) and the
   * session's name now. Undefined for someone else's thread, which the lobby's
   * T3 view does not serve, and for an id no session answers to.
   */
  lobbyKey(threadId: string): { readonly key: string; readonly name: string } | undefined {
    const entry = this.#entries.get(threadId as ThreadId);
    if (entry === undefined || entry.owner !== undefined) return undefined;
    return { key: entry.session.bornAs ?? entry.name, name: entry.name };
  }

  project(id: string): DirectoryProject | undefined {
    return this.#projects.find((p) => p.id === id);
  }

  /** Rebuilds from a fresh session list and layout. */
  update(sessions: ReadonlyArray<LobbySession>, layout: LobbyLayout): void {
    const own = sessions.filter((s) => s.owner === undefined || s.owner === this.#osUser);
    const foreign = sessions.filter((s) => s.owner !== undefined && s.owner !== this.#osUser);

    const placed = new Map<string, ProjectId>();
    const projects: DirectoryProject[] = layout.projects.map((p) => ({
      id: projectIdOf(p.name),
      title: p.name,
      workspaceRoot: p.dir ?? this.#home,
      layoutName: p.name,
      dir: p.dir ?? this.#home,
    }));
    const ownByName = new Map(own.map((s) => [s.name, s] as const));
    for (const p of layout.projects) {
      for (const name of p.sessions) {
        const s = ownByName.get(name);
        if (s !== undefined && !placed.has(name) && !isSystem(s))
          placed.set(name, projectIdOf(p.name));
      }
    }
    for (const name of layout.ungrouped) {
      const s = ownByName.get(name);
      if (s !== undefined && !placed.has(name) && !isSystem(s)) placed.set(name, UNGROUPED_PROJECT);
    }
    const layoutNames = new Set(layout.projects.map((p) => p.name));
    let hasSystem = false;
    const entries = new Map<ThreadId, DirectoryEntry>();
    const seenTmuxIds = new Set<string>();
    for (const s of own) {
      if (s.tool !== "claude") continue;
      let projectId = placed.get(s.name);
      if (projectId === undefined) {
        if (isSystem(s)) {
          projectId = SYSTEM_PROJECT;
          hasSystem = true;
        } else if (s.project !== undefined && layoutNames.has(s.project)) {
          projectId = projectIdOf(s.project);
        } else {
          projectId = UNGROUPED_PROJECT;
        }
      }
      const key = this.#keyOf(s);
      if (s.id !== undefined) seenTmuxIds.add(s.id);
      const threadId = ThreadId.make(key);
      entries.set(threadId, { threadId, name: s.name, projectId, session: s });
    }
    projects.push({
      id: UNGROUPED_PROJECT,
      title: "Ungrouped",
      workspaceRoot: this.#home,
      layoutName: "",
      dir: this.#home,
    });
    if (hasSystem) {
      projects.push({
        id: SYSTEM_PROJECT,
        title: "System",
        workspaceRoot: this.#home,
        dir: this.#home,
      });
    }
    const owners = new Set<string>();
    for (const s of foreign) {
      if (s.tool !== "claude" || s.owner === undefined) continue;
      owners.add(s.owner);
      const threadId = ThreadId.make(`${s.owner}~${s.bornAs ?? s.name}`);
      entries.set(threadId, {
        threadId,
        name: s.name,
        owner: s.owner,
        access: s.access ?? "ro",
        projectId: sharedProjectOf(s.owner),
        session: s,
      });
    }
    for (const owner of [...owners].sort()) {
      projects.push({
        id: sharedProjectOf(owner),
        title: `Shared by ${owner}`,
        workspaceRoot: `/home/${owner}`,
        dir: `/home/${owner}`,
      });
    }
    for (const id of [...this.#keyByTmuxId.keys()]) {
      if (!seenTmuxIds.has(id)) this.#keyByTmuxId.delete(id);
    }
    this.#entries = entries;
    this.#projects = withDistinctRoots(projects);
  }

  #keyOf(s: LobbySession): string {
    const aliased = this.#alias(s.bornAs ?? s.name);
    if (aliased !== undefined) return aliased;
    if (s.bornAs !== undefined) return s.bornAs;
    if (s.id === undefined) return s.name;
    const known = this.#keyByTmuxId.get(s.id);
    if (known !== undefined) return known;
    this.#keyByTmuxId.set(s.id, s.name);
    return s.name;
  }
}

/** A path as T3 compares project roots (shared/path.ts): trimmed, no trailing separator. */
function comparableRoot(path: string): string {
  const trimmed = path.trim();
  const bare = trimmed.replace(/\/+$/, "");
  return bare === "" && trimmed !== "" ? "/" : bare;
}

/**
 * T3 treats projects with the same workspace root as one project
 * (client-runtime projectGrouping.ts buildProjectGroups dedupes by
 * environment and root), so its new-thread palette would offer only one of
 * the projects that share a folder: Ungrouped, System and every layout
 * project with no folder of its own all start in the home directory. Each
 * project after the first in a folder gets the same folder written with a
 * leading `/.` per clash (`/./home/wizard`), which names the same directory
 * and keeps its last segment. Ungrouped claims its folder first, so it keeps
 * the plain path. T3 compares roots as strings and the sidecar starts
 * sessions in `dir`, so nothing else reads the difference; the panels that
 * would use the root as a working directory are stubbed.
 */
function withDistinctRoots(projects: ReadonlyArray<DirectoryProject>): DirectoryProject[] {
  const taken = new Set<string>();
  const roots = new Map<ProjectId, string>();
  const claimOrder = [
    ...projects.filter((p) => p.id === UNGROUPED_PROJECT),
    ...projects.filter((p) => p.id !== UNGROUPED_PROJECT),
  ];
  for (const p of claimOrder) {
    let root = p.workspaceRoot;
    let key = comparableRoot(root);
    for (let k = 1; taken.has(key); k++) {
      root = `${"/.".repeat(k)}${key}`;
      key = comparableRoot(root);
    }
    taken.add(key);
    roots.set(p.id, root);
  }
  return projects.map((p) => ({ ...p, workspaceRoot: roots.get(p.id) ?? p.workspaceRoot }));
}

export function projectShells(
  projects: ReadonlyArray<DirectoryProject>,
  at: string,
): OrchestrationProjectShell[] {
  return projects.map((p) => ({
    id: p.id,
    title: p.title,
    workspaceRoot: p.workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: at,
    updatedAt: at,
  }));
}
