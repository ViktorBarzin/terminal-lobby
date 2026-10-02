// Command ids this module instance has already run. session-events sends a
// command again to whoever says hello next when it was handed out but never
// acked, so a re-hello from the same instance can see a command twice.

export type Outcome = { ok: boolean; error?: string };

export class SeenCommands {
  #outcomes = new Map<string, Outcome | null>();
  #max: number;

  constructor(max = 256) {
    this.#max = max;
  }

  // undefined: a new id, now remembered, so run it. Otherwise the outcome to
  // ack again: the last one recorded, or ok:true while the first run is busy.
  repeat(id: unknown): Outcome | undefined {
    if (typeof id !== 'string' || id === '') return undefined;
    if (this.#outcomes.has(id)) return this.#outcomes.get(id) ?? { ok: true };
    this.#outcomes.set(id, null);
    while (this.#outcomes.size > this.#max) {
      const oldest = this.#outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.#outcomes.delete(oldest);
    }
    return undefined;
  }

  record(id: unknown, outcome: Outcome): void {
    if (typeof id === 'string' && this.#outcomes.has(id)) this.#outcomes.set(id, outcome);
  }
}
