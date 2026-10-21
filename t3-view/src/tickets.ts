/**
 * WebSocket tickets for paired apps. A browser cannot put a header on a
 * WebSocket handshake, so T3's client first POSTs /api/auth/websocket-ticket
 * with its bearer and then opens /ws?wsTicket=<ticket>. A ticket is random,
 * good for one upgrade within `ttlMs`, and held only in this process's memory,
 * mapped to the bearer it was issued for. The upgrade then goes through the
 * bearer gate with that bearer, so a ticket never outlives its device's
 * revocation. Tickets and bearers are never logged.
 */
import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX = 10_000;

export class WsTickets {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #tickets = new Map<string, { readonly bearer: string; readonly expiresAt: number }>();

  constructor(
    options: { readonly now?: () => number; readonly ttlMs?: number; readonly max?: number } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#max = options.max ?? DEFAULT_MAX;
  }

  issue(bearer: string): { readonly ticket: string; readonly expiresAt: number } {
    const now = this.#now();
    for (const [ticket, entry] of this.#tickets) {
      if (entry.expiresAt <= now) this.#tickets.delete(ticket);
    }
    // Insertion order is age order, so the first key is the oldest.
    while (this.#tickets.size >= this.#max) {
      const oldest = this.#tickets.keys().next();
      if (oldest.done === true) break;
      this.#tickets.delete(oldest.value);
    }
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + this.#ttlMs;
    this.#tickets.set(ticket, { bearer, expiresAt });
    return { ticket, expiresAt };
  }

  /** The bearer the ticket was issued for, or undefined. Either way the ticket is spent. */
  consume(ticket: string): string | undefined {
    const entry = this.#tickets.get(ticket);
    if (entry === undefined) return undefined;
    this.#tickets.delete(ticket);
    return entry.expiresAt > this.#now() ? entry.bearer : undefined;
  }

  get size(): number {
    return this.#tickets.size;
  }
}
