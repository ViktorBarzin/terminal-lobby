/**
 * Who may use the sidecar, decided on every HTTP request and every WebSocket
 * upgrade. There are two ways in, and a request takes exactly one of them.
 *
 * The browser path (ProxyAuthGate). The listener is reachable by every local
 * OS user (the devvm's nftables accept loopback and 10.0.10.10), so the
 * identity header alone proves nothing. The lobby's answer is the proxy
 * secret: Traefik adds X-TL-Proxy-Secret to every request, and the Go
 * services compare it with TL_PROXY_SECRET. This process deliberately does
 * not hold that secret (it runs without /etc/terminal-lobby.local.conf in its
 * environment), so it cannot compare the secret itself. Instead it forwards
 * the identity header and the secret a request presented to tmux-api's
 * /whoami on loopback, which performs the real check.
 *
 * The bearer path (BearerAuthGate), for T3's own apps paired as devices
 * (ADR-0045). The app presents `Authorization: Bearer <device token>`, or a
 * WebSocket ticket the sidecar issued for one (tickets.ts). The sidecar asks
 * /whoami with that bearer alone, and tmux-api resolves it through authuser
 * like any other bearer. A request that carries a bearer or a ticket is
 * decided by this path only and never falls back to the header gate, so a
 * forged identity header next to a bad bearer gets nothing.
 *
 * Either way an admitted credential is remembered for a short TTL, keyed by a
 * SHA-256 digest rather than the credential. Refusals are never remembered,
 * and a burst of concurrent requests for the same credential (a page load
 * fetches dozens of assets) shares one /whoami call.
 *
 * The credential a request presented does travel with its Identity, because
 * every call the sidecar makes on the user's behalf relays it, the same way
 * the client's own calls carry it. It lives as long as the request or
 * WebSocket that brought it.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const PROXY_SECRET_HEADER = "X-TL-Proxy-Secret";

/** A browser's credentials: what Traefik added to its request. */
export interface ProxyRelay {
  /** The identity header's configured name. */
  readonly header: string;
  readonly identity: string;
  readonly secret: string;
  readonly bearer?: undefined;
}

/** A paired app's credential: its device token. */
export interface BearerRelay {
  readonly bearer: string;
  readonly header?: undefined;
  readonly identity?: undefined;
  readonly secret?: undefined;
}

/** What the sidecar relays on every call it makes for a user. */
export type RelayCredentials = ProxyRelay | BearerRelay;

export const isBearerRelay = (relay: RelayCredentials): relay is BearerRelay =>
  relay.bearer !== undefined;

/** The headers that carry `relay` on a call to tmux-api or session-events. */
export function relayHeaders(relay: RelayCredentials): Record<string, string> {
  return isBearerRelay(relay)
    ? { authorization: `Bearer ${relay.bearer}` }
    : { [relay.header]: relay.identity, [PROXY_SECRET_HEADER]: relay.secret };
}

const digest = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();

/**
 * Names a credential without containing it: equal for the same credential,
 * different for any other. The hub keys upstream streams by it (hub.ts).
 */
export function relayKey(relay: RelayCredentials): string {
  return isBearerRelay(relay)
    ? `bearer:${digest(relay.bearer).toString("hex")}`
    : `proxy:${relay.identity}\u0000${digest(relay.secret).toString("hex")}`;
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

const DEFAULT_TTL_MS = 30_000;

export function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const raw = headers[name.toLowerCase()];
  const value = typeof raw === "string" ? raw : raw?.[0];
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

interface WhoamiBody {
  readonly authentik: string;
  readonly osUser: string;
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
  return realUser === undefined ? { authentik, osUser } : { authentik, osUser, realUser };
}

const refuse = (status: 401 | 403 | 502, reason: string): GateDecision => ({
  ok: false,
  status,
  reason,
});

/** One /whoami round for `relay`, as a decision. Admin or not makes no difference here. */
async function askWhoami(whoami: WhoamiFetch, relay: RelayCredentials): Promise<GateDecision> {
  let result: WhoamiResult;
  try {
    result = await whoami(relay);
  } catch (error) {
    return refuse(502, `tmux-api /whoami unreachable: ${String(error)}`);
  }
  if (result.status === 401) {
    return refuse(401, "tmux-api refused the credentials");
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
  return { ok: true, identity: { osUser: who.osUser, authentik: who.authentik, relay } };
}

interface Admitted {
  readonly osUser: string;
  readonly authentik: string;
  readonly secretDigest: Buffer;
  readonly expiresAt: number;
}

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

  /** Whether the request carries either half of a browser's credentials. */
  presented(headers: RequestHeaders): boolean {
    return (
      headerValue(headers, this.#authHeader) !== undefined ||
      headerValue(headers, PROXY_SECRET_HEADER) !== undefined
    );
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
    const relay: ProxyRelay = { header: this.#authHeader, identity, secret };
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

  async #ask(relay: ProxyRelay, presented: Buffer): Promise<GateDecision> {
    const decision = await askWhoami(this.#whoami, relay);
    if (decision.ok) {
      this.#admitted.set(relay.identity, {
        osUser: decision.identity.osUser,
        authentik: decision.identity.authentik,
        secretDigest: presented,
        expiresAt: this.#now() + this.#ttlMs,
      });
    }
    return decision;
  }
}

/**
 * The bearer path. The cache is keyed by the token's SHA-256 digest: a lookup
 * by digest reveals nothing about the token, and the token itself is never
 * stored here. Any refusal tmux-api gives (401 for an unknown or revoked
 * token, 403 for an account that no longer maps) is a 401 to the app, which
 * is what makes T3's client offer to pair again.
 */
export class BearerAuthGate {
  readonly #whoami: WhoamiFetch;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #admitted = new Map<
    string,
    { readonly osUser: string; readonly authentik: string; readonly expiresAt: number }
  >();
  readonly #inFlight = new Map<string, Promise<GateDecision>>();

  constructor(options: {
    readonly whoami: WhoamiFetch;
    readonly now?: () => number;
    readonly ttlMs?: number;
  }) {
    this.#whoami = options.whoami;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async check(token: string): Promise<GateDecision> {
    const key = digest(token).toString("hex");
    const known = this.#admitted.get(key);
    if (known !== undefined) {
      if (known.expiresAt > this.#now()) {
        return {
          ok: true,
          identity: { osUser: known.osUser, authentik: known.authentik, relay: { bearer: token } },
        };
      }
      this.#admitted.delete(key);
    }
    return this.#flight(key, token);
  }

  /**
   * Asks tmux-api again whatever the cache says, for the periodic re-check of
   * a live connection (revocation.ts). A refusal also evicts the bearer; an
   * unreachable tmux-api leaves the cache as it was.
   */
  recheck(token: string): Promise<GateDecision> {
    return this.#flight(digest(token).toString("hex"), token);
  }

  /** What the cache holds, for tests and diagnostics. Never the token. */
  cacheSnapshot(): ReadonlyArray<{ digest: string; osUser: string; expiresAt: number }> {
    return [...this.#admitted].map(([key, entry]) => ({
      digest: key,
      osUser: entry.osUser,
      expiresAt: entry.expiresAt,
    }));
  }

  #flight(key: string, token: string): Promise<GateDecision> {
    const pending = this.#inFlight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const flight = this.#ask(key, token).finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, flight);
    return flight;
  }

  async #ask(key: string, token: string): Promise<GateDecision> {
    const decision = await askWhoami(this.#whoami, { bearer: token });
    if (decision.ok) {
      this.#admitted.set(key, {
        osUser: decision.identity.osUser,
        authentik: decision.identity.authentik,
        expiresAt: this.#now() + this.#ttlMs,
      });
      return decision;
    }
    if (decision.status === 502) {
      return decision;
    }
    this.#admitted.delete(key);
    return refuse(401, decision.reason);
  }
}
