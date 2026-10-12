/**
 * Prompts a T3 Stop held, kept outside the process.
 *
 * T3's Stop takes the session's queued prompts back from the lobby
 * (POST /cancel {restoreQueue}) and keeps them as held runs until
 * queue.resume sends them again (mapper.ts holdQueue). From then on only the
 * sidecar has their text, and the lobby's log records the hand-back as each
 * prompt leaving the queue. So the held set of each thread is written here
 * whenever it changes, and a model built again from the log (a sidecar
 * restart, a stream rebuild, a thread reopened after it went idle) takes the
 * prompts back (mapper.ts restoreHeld). With a file, they outlive a restart.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { MessageId } from "@t3tools/contracts";

export interface HeldPrompt {
  readonly messageId: MessageId;
  readonly text: string;
}

const MAX_THREADS_PER_USER = 1000;
const MAX_PER_THREAD = 50;
const NONE: ReadonlyArray<HeldPrompt> = Object.freeze([]);

export class HeldPrompts {
  readonly #file: string | undefined;
  /** osUser -> thread id -> held prompts, oldest first. */
  readonly #byUser = new Map<string, Map<string, ReadonlyArray<HeldPrompt>>>();

  constructor(file?: string) {
    this.#file = file;
    this.#load();
  }

  get(osUser: string, threadId: string): ReadonlyArray<HeldPrompt> {
    return this.#byUser.get(osUser)?.get(threadId) ?? NONE;
  }

  /** Replaces a thread's held prompts; an empty list forgets the thread. */
  set(osUser: string, threadId: string, prompts: ReadonlyArray<HeldPrompt>): void {
    let map = this.#byUser.get(osUser);
    if (map === undefined) {
      if (prompts.length === 0) return;
      map = new Map();
      this.#byUser.set(osUser, map);
    }
    map.delete(threadId);
    if (prompts.length > 0) {
      map.set(
        threadId,
        prompts.slice(-MAX_PER_THREAD).map((p) => ({ messageId: p.messageId, text: p.text })),
      );
    }
    while (map.size > MAX_THREADS_PER_USER) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    if (map.size === 0) this.#byUser.delete(osUser);
    this.#save();
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
    for (const [user, threads] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof threads !== "object" || threads === null) continue;
      const map = new Map<string, ReadonlyArray<HeldPrompt>>();
      for (const [threadId, list] of Object.entries(threads as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        const prompts = list.flatMap((entry: unknown): HeldPrompt[] => {
          if (typeof entry !== "object" || entry === null) return [];
          const { messageId, text } = entry as { messageId?: unknown; text?: unknown };
          return typeof messageId === "string" && messageId !== "" && typeof text === "string"
            ? [{ messageId: MessageId.make(messageId), text }]
            : [];
        });
        if (prompts.length > 0) map.set(threadId, prompts);
      }
      if (map.size > 0) this.#byUser.set(user, map);
    }
  }

  #save(): void {
    if (this.#file === undefined) return;
    const out: Record<string, Record<string, ReadonlyArray<HeldPrompt>>> = {};
    for (const [user, map] of this.#byUser) out[user] = Object.fromEntries(map);
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch (error) {
      process.stderr.write(`tl-t3-view: saving held prompts: ${String(error)}\n`);
    }
  }
}
