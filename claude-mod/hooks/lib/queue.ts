// The outgoing event queue: keeps order, merges adjacent text deltas of the
// same block, and sheds the cheapest events first when the server is down.

export type ModEvent = { type: string; t: number; [field: string]: unknown };

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

  prepend(ev: ModEvent): void {
    this.#items.unshift(ev);
  }

  requeue(batch: ModEvent[]): void {
    this.#items.unshift(...batch);
  }

  take(limit = 200): ModEvent[] {
    return this.#items.splice(0, limit);
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
