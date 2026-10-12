/**
 * Everything the sidecar keeps per OS user: the session directory, the shell
 * (projects and thread rows) with its event log, and the threads kept live.
 * Every cache here is keyed by OS user first, and a thread by (OS user,
 * thread id), so one user's data never answers another's request.
 *
 * The shell is refreshed from tmux-api (/sessions and /layout, relayed as the
 * user) on demand and every `pollMs` while a browser holds a shell
 * subscription; a live thread's changes rebuild the rows without a fetch.
 * Each change goes out as T3's shell stream items with sequences from the
 * shared clock.
 */
import {
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  OrchestrationProjectShell as ProjectShellSchema,
  OrchestrationV2ThreadShell as ThreadShellSchema,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { Identity, RelayCredentials } from "./auth.ts";
import type { LobbyApi } from "./lobby/api.ts";
import { EventLog, type SequenceClock } from "./sequence.ts";
import type { ThreadAliases } from "./shell/aliases.ts";
import { type DirectoryEntry, projectShells, SessionDirectory } from "./shell/directory.ts";
import { appThreadOf, threadShellOf, titleOf } from "./shell/threadShell.ts";
import { SHELL_SCHEMA_VERSION } from "./shell.ts";
import { LiveThread } from "./threads/live.ts";
import type { PendingDispatches } from "./threads/pending.ts";

export interface HubOptions {
  readonly api: LobbyApi;
  readonly clock: SequenceClock;
  readonly pending: PendingDispatches;
  readonly aliases?: ThreadAliases;
  readonly startedAt: string;
  readonly pollMs?: number;
  readonly threadIdleMs?: number;
  readonly log?: (message: string) => void;
}

/** A shell stream item before it is given its sequence. */
type ShellChange =
  | { readonly kind: "project.updated"; readonly project: OrchestrationProjectShell }
  | { readonly kind: "project.removed"; readonly projectId: ProjectId }
  | { readonly kind: "thread.updated"; readonly thread: OrchestrationV2ThreadShell }
  | { readonly kind: "thread.removed"; readonly threadId: ThreadId };

type ShellListener = (item: OrchestrationV2ShellStreamItem) => void;

const encodeThread = Schema.encodeSync(Schema.toCodecJson(ThreadShellSchema));
const encodeProject = Schema.encodeSync(Schema.toCodecJson(ProjectShellSchema));
const REFRESH_FRESH_MS = 2_000;

function withSequence(change: ShellChange, sequence: number): OrchestrationV2ShellStreamItem {
  switch (change.kind) {
    case "project.updated":
      return { kind: "project.updated", sequence, project: change.project };
    case "project.removed":
      return { kind: "project.removed", sequence, projectId: change.projectId };
    case "thread.updated":
      return { kind: "thread.updated", sequence, location: "active", thread: change.thread };
    case "thread.removed":
      return { kind: "thread.removed", sequence, location: "active", threadId: change.threadId };
  }
}

export class UserHub {
  readonly osUser: string;
  readonly directory: SessionDirectory;
  readonly #o: HubOptions;
  readonly #threads = new Map<ThreadId, LiveThread>();
  readonly #shellLog: EventLog<ShellChange>;
  readonly #shellListeners = new Set<ShellListener>();
  #threadRows = new Map<
    ThreadId,
    { readonly encoded: string; readonly row: OrchestrationV2ThreadShell }
  >();
  #projectRows = new Map<
    ProjectId,
    { readonly encoded: string; readonly row: OrchestrationProjectShell }
  >();
  #relay: RelayCredentials | undefined;
  #refreshedAt = 0;
  #refreshing: Promise<void> | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
  #rowsTimer: ReturnType<typeof setTimeout> | undefined;
  #loaded = false;

  constructor(osUser: string, options: HubOptions) {
    this.osUser = osUser;
    this.#o = options;
    const aliases = options.aliases;
    this.directory = new SessionDirectory(osUser, {
      alias: (minted) => aliases?.get(osUser, minted),
    });
    this.#shellLog = new EventLog(options.clock, 2000, options.clock.next());
  }

  use(relay: RelayCredentials): void {
    this.#relay = relay;
  }

  /** Fetches the session list and layout unless they are fresher than a moment ago. */
  refresh(force = false): Promise<void> {
    if (!force && this.#loaded && Date.now() - this.#refreshedAt < REFRESH_FRESH_MS) {
      return Promise.resolve();
    }
    if (this.#refreshing !== undefined) return this.#refreshing;
    const relay = this.#relay;
    if (relay === undefined) return Promise.resolve();
    this.#refreshing = (async () => {
      try {
        const [sessions, layout] = await Promise.all([
          this.#o.api.sessions(relay),
          this.#o.api.layout(relay),
        ]);
        this.directory.update(sessions, layout);
        this.#refreshedAt = Date.now();
        this.#loaded = true;
        for (const [id, live] of this.#threads) {
          const entry = this.directory.byId(id);
          if (entry !== undefined)
            live.updateThread({ title: titleOf(entry), projectId: entry.projectId });
        }
        this.#rebuildRows();
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }

  shellSnapshot(): OrchestrationV2ShellSnapshot {
    return {
      schemaVersion: SHELL_SCHEMA_VERSION,
      snapshotSequence: this.#shellLog.last,
      threads: [...this.#threadRows.values()].map((r) => r.row),
      archivedThreads: [],
      projects: [...this.#projectRows.values()].map((r) => r.row),
    };
  }

  subscribeShell(afterSequence: number | undefined, listener: ShellListener) {
    const resume =
      afterSequence === undefined
        ? ({ kind: "snapshot" } as const)
        : this.#shellLog.resume(afterSequence);
    const start: OrchestrationV2ShellStreamItem[] =
      resume.kind === "snapshot"
        ? [{ kind: "snapshot", snapshot: this.shellSnapshot() }]
        : resume.events.map((e) => withSequence(e.event, e.sequence));
    this.#shellListeners.add(listener);
    this.#startPolling();
    return {
      start,
      unsubscribe: () => {
        this.#shellListeners.delete(listener);
        if (this.#shellListeners.size === 0) this.#stopPolling();
      },
    };
  }

  entry(threadId: string): DirectoryEntry | undefined {
    return this.directory.byId(threadId);
  }

  /** The user's own thread for a key the lobby frames it by (directory.ts resolve). */
  async resolve(key: string): Promise<DirectoryEntry | undefined> {
    await this.refresh();
    if (this.directory.resolve(key) === undefined) await this.refresh(true);
    return this.directory.resolve(key);
  }

  /** The lobby key and session name for one of the user's threads (directory.ts lobbyKey). */
  async lobbyKey(threadId: string): Promise<{ key: string; name: string } | undefined> {
    await this.refresh();
    if (this.directory.lobbyKey(threadId) === undefined) await this.refresh(true);
    return this.directory.lobbyKey(threadId);
  }

  /** The live thread for an entry the directory lists, created on first use. */
  async thread(threadId: string, relay: RelayCredentials): Promise<LiveThread | undefined> {
    this.use(relay);
    if (this.directory.byId(threadId) === undefined) await this.refresh(true);
    const entry = this.directory.byId(threadId);
    if (entry === undefined) return undefined;
    let live = this.#threads.get(entry.threadId);
    if (live === undefined) {
      const id = entry.threadId;
      live = new LiveThread({
        osUser: this.osUser,
        threadId: id,
        thread: appThreadOf(entry),
        api: this.#o.api,
        clock: this.#o.clock,
        pending: this.#o.pending,
        locate: async (stale) => {
          if (stale) await this.refresh(true);
          const now = this.directory.byId(id);
          return now === undefined
            ? undefined
            : { name: now.name, ...(now.owner === undefined ? {} : { owner: now.owner }) };
        },
        onChange: () => this.#scheduleRows(),
        onIdle: () => {
          this.#threads.delete(id);
          this.#scheduleRows();
        },
        ...(this.#o.threadIdleMs === undefined ? {} : { idleMs: this.#o.threadIdleMs }),
        ...(this.#o.log === undefined ? {} : { log: this.#o.log }),
      });
      this.#threads.set(id, live);
    }
    live.attach(relay);
    return live;
  }

  liveThread(threadId: string): LiveThread | undefined {
    return this.#threads.get(threadId as ThreadId);
  }

  #scheduleRows(): void {
    if (this.#rowsTimer !== undefined) return;
    this.#rowsTimer = setTimeout(() => {
      this.#rowsTimer = undefined;
      this.#rebuildRows();
    }, 250);
  }

  #rebuildRows(): void {
    const changes: ShellChange[] = [];
    const projects = new Map<ProjectId, { encoded: string; row: OrchestrationProjectShell }>();
    for (const row of projectShells(this.directory.projects, this.#o.startedAt)) {
      const encoded = JSON.stringify(encodeProject(row));
      projects.set(row.id, { encoded, row });
      if (this.#projectRows.get(row.id)?.encoded !== encoded)
        changes.push({ kind: "project.updated", project: row });
    }
    const threads = new Map<ThreadId, { encoded: string; row: OrchestrationV2ThreadShell }>();
    for (const entry of this.directory.entries) {
      const live = this.#threads.get(entry.threadId);
      const row = threadShellOf(entry, live?.model.synced === true ? live.projection : undefined);
      const encoded = JSON.stringify(encodeThread(row));
      threads.set(entry.threadId, { encoded, row });
      if (this.#threadRows.get(entry.threadId)?.encoded !== encoded)
        changes.push({ kind: "thread.updated", thread: row });
    }
    for (const id of this.#threadRows.keys()) {
      if (!threads.has(id)) changes.push({ kind: "thread.removed", threadId: id });
    }
    for (const id of this.#projectRows.keys()) {
      if (!projects.has(id)) changes.push({ kind: "project.removed", projectId: id });
    }
    this.#threadRows = threads;
    this.#projectRows = projects;
    for (const change of changes) {
      const sequence = this.#shellLog.append(change);
      const item = withSequence(change, sequence);
      for (const listener of this.#shellListeners) listener(item);
    }
  }

  #startPolling(): void {
    if (this.#poll !== undefined) return;
    this.#poll = setInterval(() => {
      this.refresh(true).catch((error: unknown) =>
        this.#o.log?.(`shell ${this.osUser}: ${String(error)}`),
      );
    }, this.#o.pollMs ?? 5_000);
  }

  #stopPolling(): void {
    if (this.#poll !== undefined) clearInterval(this.#poll);
    this.#poll = undefined;
  }

  dispose(): void {
    this.#stopPolling();
    if (this.#rowsTimer !== undefined) clearTimeout(this.#rowsTimer);
    for (const live of this.#threads.values()) live.dispose();
    this.#threads.clear();
  }
}

export class Hub {
  readonly #o: HubOptions;
  readonly #users = new Map<string, UserHub>();

  constructor(options: HubOptions) {
    this.#o = options;
  }

  get options(): HubOptions {
    return this.#o;
  }

  user(identity: Identity): UserHub {
    let hub = this.#users.get(identity.osUser);
    if (hub === undefined) {
      hub = new UserHub(identity.osUser, this.#o);
      this.#users.set(identity.osUser, hub);
    }
    hub.use(identity.relay);
    return hub;
  }

  dispose(): void {
    for (const hub of this.#users.values()) hub.dispose();
    this.#users.clear();
  }
}
