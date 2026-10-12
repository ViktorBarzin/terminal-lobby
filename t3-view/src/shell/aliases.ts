/**
 * Thread ids for sessions T3 created.
 *
 * T3's web client mints the thread id of a new thread itself and keeps using
 * it after launchThread returns (client-runtime operations/commands.ts sends
 * `threadId`; ChatView never reads the result's id). The lobby names the new
 * session with its own minted id (ADR-0019), so the sidecar remembers which
 * thread id T3 gave each session it created, keyed by that minted id, which
 * the session keeps as bornAs across its rename. With a file, the mapping
 * outlives a sidecar restart.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_PER_USER = 1000;

export class ThreadAliases {
  readonly #file: string | undefined;
  /** osUser -> minted session id -> thread id, oldest first. */
  readonly #byUser = new Map<string, Map<string, string>>();

  constructor(file?: string) {
    this.#file = file;
    this.#load();
  }

  get(osUser: string, minted: string): string | undefined {
    return this.#byUser.get(osUser)?.get(minted);
  }

  set(osUser: string, minted: string, threadId: string): void {
    let map = this.#byUser.get(osUser);
    if (map === undefined) {
      map = new Map();
      this.#byUser.set(osUser, map);
    }
    map.set(minted, threadId);
    while (map.size > MAX_PER_USER) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
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
    for (const [user, entries] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entries !== "object" || entries === null) continue;
      const map = new Map<string, string>();
      for (const [minted, id] of Object.entries(entries as Record<string, unknown>)) {
        if (typeof id === "string" && id !== "") map.set(minted, id);
      }
      this.#byUser.set(user, map);
    }
  }

  #save(): void {
    if (this.#file === undefined) return;
    const out: Record<string, Record<string, string>> = {};
    for (const [user, map] of this.#byUser) out[user] = Object.fromEntries(map);
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch (error) {
      process.stderr.write(`tl-t3-view: saving thread aliases: ${String(error)}\n`);
    }
  }
}
