/**
 * One thread's state, built from the frames of its lobby stream: the mapper,
 * the projection T3's reducer folds from the mapper's events, and the event
 * log a reconnecting client resumes from.
 *
 * Frames (session-events sse.go, nomod.go):
 *
 *   state    the session's mode, model and queue, ahead of anything else
 *   back     one backfill event, newest first; buffered until `ready`
 *   ready    the opening is over; names the log's epoch
 *   epoch    the log's epoch moved under a live stream; adopted
 *   message  a stored event (with an id) or a live `delta`
 *   nomod    the session has no mod stream (Claude exited, or predates the mod)
 *   starting a new Claude is starting; the stream ends when its mod says hello
 *
 * A `ready` naming a different epoch than the one this model was built from
 * means the lobby's log is not the one the projection came from (a new
 * transcript after /clear, or a session-events restart that rebuilt it), so
 * the caller rebuilds the model from a fresh open and clients get a snapshot.
 */
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";

import {
  type LobbyEvent,
  parseEpochFrame,
  parseLobbyEvent,
  parseNoStream,
  parseReadyFrame,
  parseSessionState,
  type SessionState,
  type SseFrame,
} from "../lobby/wire.ts";
import { EventLog, type SequenceClock, type Sequenced } from "../sequence.ts";
import { type DomainEvent, type MessageCorrelation, ThreadMapper } from "./mapper.ts";

export interface ThreadModelOptions {
  readonly threadId: ThreadId;
  readonly thread: OrchestrationV2AppThread;
  readonly clock: SequenceClock;
  readonly logCapacity: number;
  readonly now: () => number;
  readonly messages: MessageCorrelation;
  readonly eventPrefix: string;
}

export type FrameOutcome =
  | { readonly kind: "events"; readonly events: ReadonlyArray<Sequenced<DomainEvent>> }
  /** The log is another one: rebuild from a fresh open. */
  | { readonly kind: "rebuild" };

const NO_EVENTS: FrameOutcome = { kind: "events", events: [] };

export function emptyProjection(thread: OrchestrationV2AppThread): OrchestrationV2ThreadProjection {
  return {
    thread,
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: thread.updatedAt,
  };
}

const NO_STREAM_TEXT = {
  starting: "Claude is starting in this session.",
  exited: "This session's Claude is not running. Open it in the lobby to start it again.",
  "restart-when-idle":
    "This session's Claude started before the lobby could stream it. It restarts onto the lobby's stream once it is idle.",
} as const;

export class ThreadModel {
  readonly mapper: ThreadMapper;
  readonly log: EventLog<DomainEvent>;
  #projection: OrchestrationV2ThreadProjection;
  /** The newest stored lobby event id applied: the resume cursor. */
  lastEventId = 0;
  /** The lobby log this model was built from; undefined until the first `ready`. */
  epoch: string | undefined;
  /** True once an opening exchange has finished. */
  synced = false;
  #back: LobbyEvent[] = [];
  #state: SessionState | undefined;
  readonly #noticed = new Set<string>();
  readonly #clock: SequenceClock;

  constructor(options: ThreadModelOptions) {
    this.#clock = options.clock;
    this.mapper = new ThreadMapper(
      {
        threadId: options.threadId,
        eventPrefix: options.eventPrefix,
        now: options.now,
        messages: options.messages,
      },
      options.thread,
    );
    this.log = new EventLog(options.clock, options.logCapacity, options.clock.next());
    this.#projection = emptyProjection(options.thread);
  }

  get projection(): OrchestrationV2ThreadProjection {
    return this.#projection;
  }

  /** The sequence a snapshot of the projection stands at. */
  get snapshotSequence(): number {
    return this.log.last;
  }

  /** The largest turn item ordinal, for the bounded snapshot's watermark. */
  get latestLocalTurnOrdinal(): number | null {
    let max: number | null = null;
    for (const item of this.#projection.turnItems) {
      if (max === null || item.ordinal > max) max = item.ordinal;
    }
    return max;
  }

  /** Applies mapper output: into the projection, then into the log. */
  commit(events: ReadonlyArray<DomainEvent>): ReadonlyArray<Sequenced<DomainEvent>> {
    const out: Sequenced<DomainEvent>[] = [];
    for (const event of events) {
      this.#projection =
        applyOrchestrationV2ProjectionEvent(this.#projection, event) ?? this.#projection;
      out.push({ sequence: this.log.append(event), event });
    }
    return out;
  }

  onFrame(frame: SseFrame): FrameOutcome {
    switch (frame.event) {
      case "state": {
        const state = parseSessionState(frame.data);
        if (state === undefined) return NO_EVENTS;
        this.#state = state;
        this.#back = [];
        return this.#events(this.mapper.applyState(state));
      }
      case "back": {
        const event = parseLobbyEvent(frame.data);
        if (event !== undefined) this.#back.push(event);
        return NO_EVENTS;
      }
      case "ready":
        return this.#ready(frame.data);
      case "epoch": {
        const epoch = parseEpochFrame(frame.data);
        if (epoch !== undefined) this.epoch = epoch;
        return NO_EVENTS;
      }
      case "message": {
        const event = parseLobbyEvent(frame.data);
        if (event === undefined) return NO_EVENTS;
        if (event.kind !== "delta") {
          if (event.id <= this.lastEventId) return NO_EVENTS;
          this.lastEventId = event.id;
        }
        return this.#events(this.mapper.applyEvent(event));
      }
      case "nomod":
      case "starting": {
        const why = parseNoStream(frame.event, frame.data);
        if (why === undefined || this.#noticed.has(why.kind)) return NO_EVENTS;
        this.#noticed.add(why.kind);
        return this.#events(this.mapper.noStream(NO_STREAM_TEXT[why.kind]));
      }
      default:
        return NO_EVENTS;
    }
  }

  #ready(data: string): FrameOutcome {
    const ready = parseReadyFrame(data);
    if (ready === undefined) return NO_EVENTS;
    if (this.epoch !== undefined && ready.epoch !== undefined && ready.epoch !== this.epoch) {
      return { kind: "rebuild" };
    }
    if (this.epoch === undefined && ready.epoch !== undefined) {
      this.epoch = ready.epoch;
      this.mapper.setEpoch(ready.epoch);
    }
    const back = this.#back.sort((a, b) => a.id - b.id);
    this.#back = [];
    const events: DomainEvent[] = [];
    for (const event of back) {
      if (event.id <= this.lastEventId) continue;
      events.push(...this.mapper.applyEvent(event));
      this.lastEventId = event.id;
    }
    if (this.#state !== undefined) {
      events.push(...this.mapper.reconcileQueue(this.#state.queue));
      this.#state = undefined;
    }
    this.synced = true;
    return this.#events(events);
  }

  #events(events: ReadonlyArray<DomainEvent>): FrameOutcome {
    return events.length === 0 ? NO_EVENTS : { kind: "events", events: this.commit(events) };
  }

  /** The clock's newest sequence, for an answer that is not an event (dispatchCommand). */
  currentSequence(): number {
    return this.#clock.current();
  }
}
