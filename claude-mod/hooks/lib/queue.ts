// The outgoing event queue: keeps order, merges adjacent text deltas of the
// same block, and sheds the cheapest events first when the server is down.

export type ModEvent = { type: string; t: number; [field: string]: unknown };

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
// once the queue is over its cap. Rows, turn events and dialogs never go.
const SHEDDABLE_AFTER_DELTAS = new Set(['agents', 'model']);

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
    if (last && sameBlock(last, ev)) {
      this.#items[this.#items.length - 1] = { ...last, text: String(last.text) + String(ev.text) };
      return;
    }
    this.#items.push(ev);
    this.#shed();
  }

  prepend(...evs: ModEvent[]): void {
    this.#items.unshift(...evs);
  }

  requeue(batch: ModEvent[]): void {
    this.#items.unshift(...batch);
  }

  // The next batch, oldest first: at most `limit` events and, past the first,
  // at most `maxChars` of JSON.
  take(limit = 200, maxChars = BATCH_CHARS): ModEvent[] {
    const out: ModEvent[] = [];
    let chars = 0;
    while (this.#items.length > 0 && out.length < limit) {
      const n = charsOf(this.#items[0]);
      if (n > MAX_EVENT_CHARS) {
        this.#items.shift();
        this.dropped++;
        continue;
      }
      if (out.length > 0 && chars + n > maxChars) break;
      out.push(this.#items.shift() as ModEvent);
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
