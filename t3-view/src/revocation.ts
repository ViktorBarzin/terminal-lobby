/**
 * Revocation for paired apps. A device token is checked when a request
 * arrives (auth.ts), but a WebSocket lives for hours, so every open socket
 * that came in on a bearer is checked again: every `intervalMs` (60 s), and
 * at once when any lobby call made with that bearer answers 401 (suspect).
 *
 * When tmux-api now refuses the bearer, each of its sockets is closed with
 * AUTH_CLOSE_CODE, and `onRevoked` is told the credential's key so the hub
 * moves every upstream stream opened under it to another client's credential,
 * or closes it when no client is left (hub.ts). An unreachable tmux-api is
 * not a refusal: the sockets stay, and the next round asks again.
 *
 * Each check goes through BearerAuthGate.recheck, which also refreshes the
 * device's last use in tmux-api. Only bearers with an open socket are
 * checked, so a device that is not connected ages toward its idle limit.
 */
import { type BearerAuthGate, relayKey } from "./auth.ts";

/** The close code T3's own server uses for a refused credential. */
export const AUTH_CLOSE_CODE = 4401;
export const AUTH_CLOSE_REASON = "credential revoked";

const DEFAULT_INTERVAL_MS = 60_000;

export class BearerWatch {
  readonly #gate: Pick<BearerAuthGate, "recheck">;
  readonly #onRevoked: (key: string) => void;
  readonly #intervalMs: number;
  readonly #log: ((message: string) => void) | undefined;
  /** By credential key: the bearer and the closers of its open sockets. */
  readonly #sockets = new Map<
    string,
    { readonly bearer: string; readonly closers: Set<() => void> }
  >();
  readonly #checking = new Map<string, Promise<void>>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    readonly gate: Pick<BearerAuthGate, "recheck">;
    readonly onRevoked: (key: string) => void;
    readonly intervalMs?: number;
    readonly log?: (message: string) => void;
  }) {
    this.#gate = options.gate;
    this.#onRevoked = options.onRevoked;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#log = options.log;
  }

  /** Watches one open socket; the returned function stops watching it. */
  watch(bearer: string, close: () => void): () => void {
    const key = relayKey({ bearer });
    let entry = this.#sockets.get(key);
    if (entry === undefined) {
      entry = { bearer, closers: new Set() };
      this.#sockets.set(key, entry);
    }
    const closers = entry.closers;
    closers.add(close);
    this.#start();
    return () => {
      closers.delete(close);
      if (closers.size === 0 && this.#sockets.get(key)?.closers === closers) {
        this.#sockets.delete(key);
      }
      if (this.#sockets.size === 0) this.#stop();
    };
  }

  /** Checks one bearer now, as after a 401 from the lobby. Concurrent calls share one check. */
  suspect(bearer: string): Promise<void> {
    const key = relayKey({ bearer });
    const running = this.#checking.get(key);
    if (running !== undefined) return running;
    const check = this.#check(key, bearer).finally(() => this.#checking.delete(key));
    this.#checking.set(key, check);
    return check;
  }

  /** One round over every watched bearer. */
  async checkAll(): Promise<void> {
    await Promise.all([...this.#sockets.values()].map((entry) => this.suspect(entry.bearer)));
  }

  get watchedSockets(): number {
    let count = 0;
    for (const entry of this.#sockets.values()) count += entry.closers.size;
    return count;
  }

  dispose(): void {
    this.#stop();
    this.#sockets.clear();
  }

  async #check(key: string, bearer: string): Promise<void> {
    const decision = await this.#gate.recheck(bearer);
    if (decision.ok || decision.status === 502) return;
    const entry = this.#sockets.get(key);
    this.#sockets.delete(key);
    if (this.#sockets.size === 0) this.#stop();
    const closers = entry === undefined ? [] : [...entry.closers];
    this.#log?.(`a paired app's credential was refused; closing ${closers.length} socket(s)`);
    for (const close of closers) {
      try {
        close();
      } catch (error) {
        this.#log?.(`closing a revoked socket: ${String(error)}`);
      }
    }
    this.#onRevoked(key);
  }

  #start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      this.checkAll().catch((error: unknown) => this.#log?.(`bearer re-check: ${String(error)}`));
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  #stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
