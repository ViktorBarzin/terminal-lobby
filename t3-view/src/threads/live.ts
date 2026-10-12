/**
 * One thread kept live: a single upstream event stream from session-events
 * for one (OS user, session), shared by every browser connection that has the
 * thread open, folded into a ThreadModel.
 *
 * The stream is opened by the session's current name (renames are followed
 * through `locate`), resumed with Last-Event-ID and the log's epoch after a
 * drop, and reopened from scratch when the lobby's log turns out to be
 * another one (ThreadModel's rebuild). Subscribers get a snapshot or a replay
 * on subscribe and every committed event after; after a rebuild they get one
 * fresh snapshot. With no subscriber for `idleMs` the thread closes its stream
 * and the hub forgets it.
 */
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";

import type { RelayCredentials } from "../auth.ts";
import type { LobbyApi } from "../lobby/api.ts";
import { SseParser } from "../lobby/wire.ts";
import type { SequenceClock } from "../sequence.ts";
import type { DomainEvent } from "./mapper.ts";
import { ThreadModel } from "./model.ts";
import { modeFromPane } from "./modes.ts";
import type { PendingDispatches } from "./pending.ts";

export interface ThreadLocation {
  readonly name: string;
  readonly owner?: string;
}

export interface LiveThreadOptions {
  readonly osUser: string;
  readonly threadId: ThreadId;
  readonly thread: OrchestrationV2AppThread;
  readonly api: LobbyApi;
  readonly clock: SequenceClock;
  readonly pending: PendingDispatches;
  /** The session's current name, after refreshing the directory when `stale`. */
  readonly locate: (stale: boolean) => Promise<ThreadLocation | undefined>;
  readonly onChange?: () => void;
  readonly onIdle?: () => void;
  readonly now?: () => number;
  readonly idleMs?: number;
  readonly logCapacity?: number;
  /** How long a quiet stream may stay silent before it is reopened (session-events sends `head` every hb). */
  readonly silenceMs?: number;
  readonly log?: (message: string) => void;
}

type Listener = (item: OrchestrationV2ThreadStreamItem) => void;

export type SubscribeStart =
  | { readonly kind: "snapshot"; readonly item: OrchestrationV2ThreadStreamItem }
  | { readonly kind: "replay"; readonly items: ReadonlyArray<OrchestrationV2ThreadStreamItem> };

const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_SILENCE_MS = 75_000;
const READY_WAIT_MS = 15_000;
let processPrefix = 0;

export class LiveThread {
  readonly #o: LiveThreadOptions;
  readonly #listeners = new Set<Listener>();
  readonly #now: () => number;
  readonly #eventPrefix: string;
  #model: ThreadModel;
  #relay: RelayCredentials | undefined;
  #abort: AbortController | undefined;
  #running = false;
  #disposed = false;
  #needsSnapshot = false;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #readyWaiters: Array<() => void> = [];
  #rebuilds = 0;

  constructor(options: LiveThreadOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#eventPrefix = `${options.clock.base.toString(36)}${(++processPrefix).toString(36)}`;
    this.#model = this.#newModel(options.thread);
  }

  get model(): ThreadModel {
    return this.#model;
  }

  get projection(): OrchestrationV2ThreadProjection {
    return this.#model.projection;
  }

  get pendingKey(): string {
    return `${this.#o.osUser}\u0000${this.#o.threadId}`;
  }

  /** Starts (or keeps) the upstream stream under these credentials. */
  attach(relay: RelayCredentials): void {
    this.#relay = relay;
    this.#touch();
    if (!this.#running && !this.#disposed) {
      this.#running = true;
      void this.#loop();
    }
  }

  /** Resolves once the first opening exchange is over, or after a bound. */
  ready(timeoutMs = READY_WAIT_MS): Promise<void> {
    if (this.#model.synced) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        this.#readyWaiters = this.#readyWaiters.filter((w) => w !== waiter);
        resolve();
      };
      const timer = setTimeout(waiter, timeoutMs);
      this.#readyWaiters.push(waiter);
    });
  }

  /**
   * Subscribes a connection. What it is sent first depends on what it holds:
   * nothing, or a sequence this thread cannot continue, gets a snapshot.
   */
  subscribe(
    afterSequence: number | undefined,
    listener: Listener,
  ): {
    readonly start: SubscribeStart;
    readonly unsubscribe: () => void;
  } {
    const resume =
      afterSequence === undefined
        ? ({ kind: "snapshot" } as const)
        : this.#model.log.resume(afterSequence);
    const start: SubscribeStart =
      resume.kind === "snapshot"
        ? { kind: "snapshot", item: this.snapshotItem() }
        : {
            kind: "replay",
            items: resume.events.map((e) => ({
              kind: "event",
              sequence: e.sequence,
              event: e.event,
            })),
          };
    this.#listeners.add(listener);
    this.#touch();
    return {
      start,
      unsubscribe: () => {
        this.#listeners.delete(listener);
        this.#touch();
      },
    };
  }

  snapshotItem(): OrchestrationV2ThreadStreamItem {
    return {
      kind: "snapshot",
      snapshotSequence: this.#model.snapshotSequence,
      projection: this.#model.projection,
    };
  }

  /** Commits events made outside the stream (a T3 Stop's request row, thread metadata). */
  commit(events: ReadonlyArray<DomainEvent>): void {
    this.#broadcast(this.#model.commit(events));
  }

  updateThread(patch: Parameters<ThreadModel["mapper"]["updateThread"]>[0]): void {
    this.commit(this.#model.mapper.updateThread(patch));
  }

  dispose(): void {
    this.#disposed = true;
    this.#abort?.abort();
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    for (const waiter of this.#readyWaiters.splice(0)) waiter();
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  #newModel(thread: OrchestrationV2AppThread): ThreadModel {
    const pending = this.#o.pending;
    const key = `${this.#o.osUser}\u0000${this.#o.threadId}`;
    return new ThreadModel({
      threadId: this.#o.threadId,
      thread,
      clock: this.#o.clock,
      logCapacity: this.#o.logCapacity ?? 5000,
      now: this.#now,
      messages: { take: (text) => pending.take(key, text) },
      eventPrefix: `${this.#eventPrefix}.${this.#rebuilds}`,
    });
  }

  #touch(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    if (this.#listeners.size > 0 || this.#disposed) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#listeners.size === 0) {
        this.dispose();
        this.#o.onIdle?.();
      }
    }, this.#o.idleMs ?? DEFAULT_IDLE_MS);
  }

  #broadcast(
    events: ReadonlyArray<{ readonly sequence: number; readonly event: DomainEvent }>,
  ): void {
    if (events.length === 0) return;
    this.#o.onChange?.();
    if (this.#needsSnapshot) return;
    for (const { sequence, event } of events) {
      const item: OrchestrationV2ThreadStreamItem = { kind: "event", sequence, event };
      for (const listener of this.#listeners) listener(item);
    }
  }

  #synced(): void {
    for (const waiter of this.#readyWaiters.splice(0)) waiter();
    if (this.#needsSnapshot) {
      this.#needsSnapshot = false;
      const item = this.snapshotItem();
      for (const listener of this.#listeners) listener(item);
      this.#o.onChange?.();
    }
  }

  async #loop(): Promise<void> {
    let backoff = 500;
    let stale = false;
    while (!this.#disposed) {
      const relay = this.#relay;
      const where =
        relay === undefined ? undefined : await this.#o.locate(stale).catch(() => undefined);
      if (relay === undefined || where === undefined) {
        backoff = Math.min(backoff * 2, 10_000);
        await sleep(backoff);
        stale = true;
        continue;
      }
      stale = false;
      const outcome = await this.#readOnce(relay, where).catch((error: unknown) => {
        if (!this.#disposed) this.#o.log?.(`thread ${this.#o.threadId}: ${String(error)}`);
        return "error" as const;
      });
      if (this.#disposed) break;
      if (outcome === "synced") backoff = 500;
      if (outcome === "missing") stale = true;
      if (outcome === "rebuild") {
        backoff = 500;
        continue;
      }
      backoff = Math.min(backoff * 2, 10_000);
      await sleep(backoff);
    }
    this.#running = false;
  }

  /**
   * The mode the pane shows, folded at every `ready` (a first open and each
   * resync). The `state` frame's mode comes from session-events' record of
   * the transcript, which the CLI does not write when the mode changes, so it
   * can be stale; the Solid view reads GET /pane for the same reason.
   */
  async #readPaneMode(
    relay: RelayCredentials,
    where: ThreadLocation,
    model: ThreadModel,
  ): Promise<void> {
    const pane = await this.#o.api.pane(relay, where.name, where.owner);
    const mode = pane === undefined ? "" : modeFromPane(pane);
    if (mode === "" || this.#disposed || model !== this.#model) return;
    this.#broadcast(model.commit(model.mapper.confirmMode(mode)));
  }

  /** One upstream connection, until it ends. */
  async #readOnce(
    relay: RelayCredentials,
    where: ThreadLocation,
  ): Promise<"synced" | "ended" | "missing" | "rebuild" | "error"> {
    const abort = new AbortController();
    this.#abort = abort;
    const model = this.#model;
    const resume = model.synced
      ? { lastEventId: model.lastEventId, epoch: model.epoch }
      : undefined;
    const response = await this.#o.api.events(relay, where.name, where.owner, resume, abort.signal);
    if (response.status === 404) {
      await response.body?.cancel();
      return "missing";
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      this.#o.log?.(`thread ${this.#o.threadId}: events answered ${response.status}`);
      return "error";
    }
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let silence = setTimeout(() => abort.abort(), this.#o.silenceMs ?? DEFAULT_SILENCE_MS);
    let synced = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(silence);
        silence = setTimeout(() => abort.abort(), this.#o.silenceMs ?? DEFAULT_SILENCE_MS);
        for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
          const outcome = this.#model.onFrame(frame);
          if (outcome.kind === "rebuild") {
            this.#rebuilds++;
            this.#model = this.#newModel(this.#model.mapper.thread);
            this.#needsSnapshot = true;
            abort.abort();
            return "rebuild";
          }
          this.#broadcast(outcome.events);
          if (frame.event === "ready" && this.#model.synced) {
            await this.#readPaneMode(relay, where, this.#model);
            synced = true;
            this.#synced();
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      clearTimeout(silence);
      reader.releaseLock();
    }
    return synced ? "synced" : "ended";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
