/**
 * Prompts the browser sent that the session has not recorded yet, so the
 * user row Claude writes for one carries the browser's own messageId.
 *
 * T3's ChatView draws a sent message optimistically and drops that row only
 * when a user message with the same id reaches the projection (ChatView.tsx,
 * serverAcknowledgedUserMessageIds). The lobby knows nothing of T3's ids: its
 * transcript says what was typed. So message.dispatch records messageId ->
 * text here, and the mapper takes the entry when a queued prompt or a user
 * row with that text appears.
 *
 * Entries are matched by text, oldest first, and expire after a TTL so a
 * prompt Claude never recorded (a slash command, a refused send) cannot take
 * a later row. With a file, the map survives a sidecar restart: a prompt sent
 * just before a release still comes back under its id.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { MessageId } from "@t3tools/contracts";

export interface PendingDispatch {
  readonly messageId: MessageId;
  readonly text: string;
  readonly at: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_PER_THREAD = 50;

function samePrompt(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (x === y) return true;
  return x.length >= 64 && y.length >= 64 && (x.startsWith(y) || y.startsWith(x));
}

export class PendingDispatches {
  readonly #file: string | undefined;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #byThread = new Map<string, PendingDispatch[]>();

  constructor(options: { file?: string; ttlMs?: number; now?: () => number } = {}) {
    this.#file = options.file;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#load();
  }

  /** `key` names the thread for one OS user: `${osUser}\0${threadId}`. */
  add(key: string, dispatch: PendingDispatch): void {
    const list = this.#live(key);
    list.push(dispatch);
    while (list.length > MAX_PER_THREAD) list.shift();
    this.#byThread.set(key, list);
    this.#save();
  }

  take(key: string, text: string): MessageId | undefined {
    const list = this.#live(key);
    const i = list.findIndex((p) => samePrompt(p.text, text));
    if (i === -1) return undefined;
    const [hit] = list.splice(i, 1);
    this.#byThread.set(key, list);
    this.#save();
    return hit?.messageId;
  }

  /** Drops one entry, for a send the lobby refused. */
  remove(key: string, messageId: MessageId): void {
    const list = this.#live(key).filter((p) => p.messageId !== messageId);
    this.#byThread.set(key, list);
    this.#save();
  }

  list(key: string): ReadonlyArray<PendingDispatch> {
    return this.#live(key);
  }

  #live(key: string): PendingDispatch[] {
    const cut = this.#now() - this.#ttlMs;
    return (this.#byThread.get(key) ?? []).filter((p) => p.at > cut);
  }

  #load(): void {
    if (this.#file === undefined) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#file, "utf8"));
    } catch {
      return;
    }
    if (typeof raw !== "object" || raw === null) return;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const list: PendingDispatch[] = [];
      for (const entry of value) {
        if (typeof entry !== "object" || entry === null) continue;
        const { messageId, text, at } = entry as Record<string, unknown>;
        if (
          typeof messageId === "string" &&
          messageId !== "" &&
          typeof text === "string" &&
          typeof at === "number"
        ) {
          list.push({ messageId: MessageId.make(messageId), text, at });
        }
      }
      this.#byThread.set(key, list);
    }
  }

  #save(): void {
    if (this.#file === undefined) return;
    const out: Record<string, PendingDispatch[]> = {};
    for (const [key] of this.#byThread) {
      const list = this.#live(key);
      if (list.length > 0) out[key] = list;
    }
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch (error) {
      process.stderr.write(`tl-t3-view: saving pending prompts: ${String(error)}\n`);
    }
  }
}
