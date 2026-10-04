// The outgoing event queue: keeps order, merges adjacent text deltas of the
// same block, keeps one level snapshot, and sheds the cheapest events first
// when the server is down.

import type { ModEvent, ModEventType } from './wire.ts';

export type { ModEvent } from './wire.ts';

// Claude Code refuses a mod's request body over 4,194,304 characters (measured
// on 2.1.287, 2026-10-02). A refused batch goes back on the queue and every
// event behind it waits, so batches stay far below that, and an event that
// could never fit in one is dropped rather than resent forever.
export const MAX_EVENT_CHARS = 3_500_000;
export const BATCH_CHARS = 1_000_000;

function charsOf(ev: ModEvent): number {
  try {
    return JSON.stringify(ev).length;
  } catch {
    return Infinity;
  }
}

// Events the server can rebuild from later ones: dropped before anything else
// once the queue is over its cap. Past the cap, rows, turn events and dialogs
// stay; an event too big for any request (MAX_EVENT_CHARS) is the one thing
// dropped whatever its type, which is why the strings in dialogs, prompts and
// answers are capped before they are queued (shape.ts capStrings). A level is
// never dropped: it is small, and it is the snapshot the server trusts.
const SHEDDABLE_AFTER_DELTAS = new Set<ModEventType>(['agents', 'model']);

function sameBlock(a: ModEvent, b: ModEvent): boolean {
  return a.type === 'delta' && b.type === 'delta' &&
    a.turnId === b.turnId && a.agentId === b.agentId &&
    a.step === b.step && a.index === b.index && a.kind === b.kind;
}

export class EventQueue {
  #items: ModEvent[] = [];
  #max: number;
  dropped = 0;

  constructor(max = 5000) {
    this.#max = max;
  }

  get size(): number {
    return this.#items.length;
  }

  push(ev: ModEvent): void {
    const last = this.#items[this.#items.length - 1];
    if (last && last.type === 'delta' && ev.type === 'delta' && sameBlock(last, ev)) {
      this.#items[this.#items.length - 1] = { ...last, text: last.text + ev.text };
      return;
    }
    // A level says everything as of now, so an older one still queued says nothing more.
    if (ev.type === 'level') this.#items = this.#items.filter((e) => e.type !== 'level');
    this.#items.push(ev);
    this.#shed();
  }

  // Puts events ahead of everything queued. A level among them gives way to
  // one already queued, which was taken later.
  prepend(...evs: ModEvent[]): void {
    const queuedLevel = this.#items.some((e) => e.type === 'level');
    this.#items.unshift(...(queuedLevel ? evs.filter((e) => e.type !== 'level') : evs));
  }

  requeue(batch: ModEvent[]): void {
    this.#items.unshift(...batch);
  }

  // The events queued now, to drop once a snapshot read after this moment
  // has been taken (drop).
  snapshot(): ReadonlySet<ModEvent> {
    return new Set(this.#items);
  }

  // Drops the events of `covered` still queued, except those whose type is in
  // `keep`: what a snapshot already says. Not counted as dropped.
  drop(covered: ReadonlySet<ModEvent>, keep: ReadonlySet<ModEventType>): void {
    this.#items = this.#items.filter((e) => !covered.has(e) || keep.has(e.type));
  }

  // Drops every queued event of these types. Not counted as dropped.
  dropTypes(types: ReadonlySet<ModEventType>): void {
    this.#items = this.#items.filter((e) => !types.has(e.type));
  }

  // The next batch, oldest first: at most `limit` events and, past the first,
  // at most `maxChars` of JSON.
  take(limit = 200, maxChars = BATCH_CHARS): ModEvent[] {
    const out: ModEvent[] = [];
    let chars = 0;
    while (out.length < limit) {
      const head = this.#items[0];
      if (head === undefined) break;
      const n = charsOf(head);
      if (n > MAX_EVENT_CHARS && head.type !== 'level') {
        this.#items.shift();
        this.dropped++;
        continue;
      }
      if (out.length > 0 && chars + n > maxChars) break;
      this.#items.shift();
      out.push(head);
      chars += n;
    }
    return out;
  }

  #shed(): void {
    for (const pick of [(e: ModEvent) => e.type === 'delta', (e: ModEvent) => SHEDDABLE_AFTER_DELTAS.has(e.type)]) {
      while (this.#items.length > this.#max) {
        const i = this.#items.findIndex(pick);
        if (i < 0) break;
        this.#items.splice(i, 1);
        this.dropped++;
      }
    }
  }
}
