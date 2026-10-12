/**
 * Who may use the sidecar, decided on every HTTP request and every WebSocket
 * upgrade.
 *
 * The listener is reachable by every local OS user (the devvm's nftables
 * accept loopback and 10.0.10.10), so the identity header alone proves
 * nothing. The lobby's answer is the proxy secret: Traefik adds
 * X-TL-Proxy-Secret to every request, and the Go services compare it with
 * TL_PROXY_SECRET. This process deliberately does not hold that secret (it
 * runs without /etc/terminal-lobby.local.conf in its environment), so it
 * cannot compare the secret itself. Instead it forwards the identity header
 * and the secret a request presented to tmux-api's /whoami on loopback, which
 * performs the real check and also answers whether the caller is an admin.
 *
 * An admitted pair is remembered for a short TTL, keyed by identity, with a
 * SHA-256 digest of the secret rather than the secret. A later request is
 * admitted from memory only when the digest of the secret it presents matches,
 * compared with timingSafeEqual. Refusals are never remembered, and a burst of
 * concurrent requests for the same pair (a page load fetches dozens of assets)
 * shares one /whoami call.
 *
 * The secret a request presented does travel with its Identity, because every
 * call the sidecar makes on the user's behalf relays it, the same way the
 * browser's own calls carry it. It lives as long as the request or WebSocket
 * that brought it.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const PROXY_SECRET_HEADER = "X-TL-Proxy-Secret";

/** What the sidecar relays on every call it makes for a user. */
export interface RelayCredentials {
  /** The identity header's configured name. */
  readonly header: string;
  readonly identity: string;
  readonly secret: string;
}

export interface Identity {
  readonly osUser: string;
  readonly authentik: string;
  readonly relay: RelayCredentials;
}

export interface WhoamiResult {
  readonly status: number;
  readonly body: unknown;
}

export type WhoamiFetch = (relay: RelayCredentials) => Promise<WhoamiResult>;

export type GateDecision =
  | { readonly ok: true; readonly identity: Identity }
  | { readonly ok: false; readonly status: 401 | 403 | 502; readonly reason: string };

export type RequestHeaders = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;

interface Admitted {
  readonly osUser: string;
  readonly authentik: string;
  readonly secretDigest: Buffer;
  readonly expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;

const digest = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();

function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const raw = headers[name.toLowerCase()];
  const value = typeof raw === "string" ? raw : raw?.[0];
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

interface WhoamiBody {
  readonly authentik: string;
  readonly osUser: string;
  readonly admin: boolean;
  readonly realUser?: string;
}

function parseWhoami(body: unknown): WhoamiBody | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const { authentik, osUser, admin, realUser } = body as Record<string, unknown>;
  if (typeof authentik !== "string" || typeof osUser !== "string" || osUser === "") {
    return undefined;
  }
  if (typeof admin !== "boolean") {
    return undefined;
  }
  if (realUser !== undefined && typeof realUser !== "string") {
    return undefined;
  }
  return realUser === undefined
    ? { authentik, osUser, admin }
    : { authentik, osUser, admin, realUser };
}

const refuse = (status: 401 | 403 | 502, reason: string): GateDecision => ({
  ok: false,
  status,
  reason,
});

export class ProxyAuthGate {
  readonly #authHeader: string;
  readonly #whoami: WhoamiFetch;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #admitted = new Map<string, Admitted>();
  readonly #inFlight = new Map<string, Promise<GateDecision>>();

  constructor(options: {
    readonly authHeader: string;
    readonly whoami: WhoamiFetch;
    readonly now?: () => number;
    readonly ttlMs?: number;
  }) {
    this.#authHeader = options.authHeader;
    this.#whoami = options.whoami;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async check(headers: RequestHeaders): Promise<GateDecision> {
    const identity = headerValue(headers, this.#authHeader);
    if (identity === undefined) {
      return refuse(401, "missing identity header");
    }
    const secret = headerValue(headers, PROXY_SECRET_HEADER);
    if (secret === undefined) {
      return refuse(401, "missing proxy secret");
    }
    const relay: RelayCredentials = { header: this.#authHeader, identity, secret };
    const presented = digest(secret);

    const known = this.#admitted.get(identity);
    if (known !== undefined) {
      if (known.expiresAt <= this.#now()) {
        this.#admitted.delete(identity);
      } else if (timingSafeEqual(known.secretDigest, presented)) {
        return { ok: true, identity: { osUser: known.osUser, authentik: known.authentik, relay } };
      }
    }

    const flightKey = `${identity}\u0000${presented.toString("hex")}`;
    const pending = this.#inFlight.get(flightKey);
    if (pending !== undefined) {
      return pending;
    }
    const flight = this.#ask(relay, presented).finally(() => {
      this.#inFlight.delete(flightKey);
    });
    this.#inFlight.set(flightKey, flight);
    return flight;
  }

  /** What the cache holds, for tests and diagnostics. Never the secret. */
  cacheSnapshot(): ReadonlyArray<{ identity: string; osUser: string; expiresAt: number }> {
    return [...this.#admitted].map(([identity, entry]) => ({
      identity,
      osUser: entry.osUser,
      expiresAt: entry.expiresAt,
    }));
  }

  async #ask(relay: RelayCredentials, presented: Buffer): Promise<GateDecision> {
    let result: WhoamiResult;
    try {
      result = await this.#whoami(relay);
    } catch (error) {
      return refuse(502, `tmux-api /whoami unreachable: ${String(error)}`);
    }
    if (result.status === 401) {
      return refuse(401, "tmux-api refused the identity or proxy secret");
    }
    if (result.status === 403) {
      return refuse(403, "tmux-api refused the identity");
    }
    if (result.status !== 200) {
      return refuse(502, `tmux-api /whoami answered ${result.status}`);
    }
    const who = parseWhoami(result.body);
    if (who === undefined) {
      return refuse(502, "tmux-api /whoami answered an unexpected body");
    }
    if (who.realUser !== undefined) {
      return refuse(403, "acting as another user is not supported here");
    }
    if (!who.admin) {
      return refuse(403, "the T3 view is for admins");
    }
    this.#admitted.set(relay.identity, {
      osUser: who.osUser,
      authentik: who.authentik,
      secretDigest: presented,
      expiresAt: this.#now() + this.#ttlMs,
    });
    return { ok: true, identity: { osUser: who.osUser, authentik: who.authentik, relay } };
  }
}
