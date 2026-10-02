// Commands this module instance has already run. session-events sends a
// command again to whoever says hello next when it was handed out but never
// acked, so a re-hello from the same instance can see a command twice. A
// restarted server can also reuse an id for a new command, so a repeat must
// match the command's content as well as its id.

export type Outcome = { ok: boolean; error?: string };

type Entry = { fingerprint: string; outcome: Outcome | null };

// The command with its fields in a fixed order, so a redelivery compares equal.
function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${fingerprint(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export class SeenCommands {
  #entries = new Map<string, Entry>();
  #max: number;

  constructor(max = 256) {
    this.#max = max;
  }

  // undefined: a new command (or an id reused for a different one), now
  // remembered, so run it. Otherwise the outcome to ack again: the last one
  // recorded, or ok:true while the first run is busy. Takes the command, or
  // its bare id.
  repeat(command: unknown): Outcome | undefined {
    const id = typeof command === 'string' ? command : (command as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id === '') return undefined;
    const print = fingerprint(command);
    const known = this.#entries.get(id);
    if (known && known.fingerprint === print) return known.outcome ?? { ok: true };
    this.#entries.delete(id);
    this.#entries.set(id, { fingerprint: print, outcome: null });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return undefined;
  }

  record(id: unknown, outcome: Outcome): void {
    const known = typeof id === 'string' ? this.#entries.get(id) : undefined;
    if (known) known.outcome = outcome;
  }
}
