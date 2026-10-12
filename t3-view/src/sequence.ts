/**
 * Event sequence numbers that stay monotonic across sidecar restarts.
 *
 * The T3 client caches thread and shell state in IndexedDB and resumes a
 * subscription with the last sequence it applied (afterSequence). It drops any
 * event whose sequence is not above that (client-runtime
 * src/state/threads.ts), and it resets from a snapshot when the server sends
 * one. A sidecar that restarted from 0 would hand out sequences the client
 * already holds, and the client would silently drop every new event.
 *
 * So one process-wide clock starts at the startup time in microseconds. A
 * restart one millisecond later starts 1,000 above anything a previous run
 * could have handed out in that millisecond, and the base stays well inside
 * Number.MAX_SAFE_INTEGER (about 1.8e15 against 9e15). Every stream (the shell
 * and each thread) takes its sequences from the same clock, so they are sparse
 * within one stream and that is fine: the client only compares them.
 *
 * A resume the sidecar cannot answer exactly, because the sequence comes from
 * another run, is ahead of this one, or falls before events already dropped
 * from memory, gets a full snapshot, the way T3's own server falls back.
 */

export class SequenceClock {
  readonly base: number;
  #current: number;

  constructor(epochMs: number) {
    this.base = Math.floor(epochMs) * 1000;
    this.#current = this.base;
  }

  current(): number {
    return this.#current;
  }

  next(): number {
    this.#current += 1;
    return this.#current;
  }
}

export interface Sequenced<E> {
  readonly sequence: number;
  readonly event: E;
}

export type Resume<E> =
  | { readonly kind: "snapshot" }
  | { readonly kind: "replay"; readonly events: ReadonlyArray<Sequenced<E>> };

/** The recent events of one stream, kept so a reconnecting client can catch up. */
export class EventLog<E> {
  readonly #clock: SequenceClock;
  readonly #capacity: number;
  readonly #events: Sequenced<E>[] = [];
  /** Every sequence at or below this one is no longer replayable. */
  #droppedThrough: number;

  constructor(clock: SequenceClock, capacity: number) {
    this.#clock = clock;
    this.#capacity = capacity;
    this.#droppedThrough = clock.base;
  }

  append(event: E): number {
    const sequence = this.#clock.next();
    this.#events.push({ sequence, event });
    while (this.#events.length > this.#capacity) {
      const dropped = this.#events.shift();
      if (dropped !== undefined) {
        this.#droppedThrough = dropped.sequence;
      }
    }
    return sequence;
  }

  resume(afterSequence: number): Resume<E> {
    if (afterSequence < this.#droppedThrough || afterSequence > this.#clock.current()) {
      return { kind: "snapshot" };
    }
    return {
      kind: "replay",
      events: this.#events.filter((entry) => entry.sequence > afterSequence),
    };
  }
}
