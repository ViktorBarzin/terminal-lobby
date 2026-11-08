// Cookie write-back (ADR-0047). Logins the session browser picks up go to the
// user's hub, the cluster Chrome that holds their logins, so every other
// browser of the same user gets them. The hub does all merging; this side
// only decides what is worth sending and when nothing changed.
//
// A push carries every pushable cookie the browser holds, not only the ones
// that changed: the hub lets a push replace a site's cookies only when it
// carries every cookie the hub holds live for that site, so a re-login sent
// on its own would look like a signed-out browser and be skipped.
//
// The hub is optional. Without ~/.config/chrome-hub/hub.json, or with one
// that cannot be read, nothing here does anything and nothing is logged.
// Every failure is logged as a count or a status and swallowed: a hub that is
// down never breaks the browser or the agent. No cookie value or token is
// ever logged.

import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";

/**
 * A cookie as Playwright's context.cookies() returns it and storageState holds it.
 * @typedef {import("playwright-core").Cookie} Cookie
 * @typedef {{ cookiesUrl: string, snapshotUrl: string, readToken: string, writeToken: string }} HubConfig
 */

/** The hub refuses a body over 2 MB or with more than 3000 cookies. */
const MAX_BODY_BYTES = 1_900_000;
const MAX_BATCH = 3000;
const REQUEST_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_S = 30;

/**
 * @param {string} home
 * @returns {string}
 */
function hubPath(home) {
  return path.join(home, ".config", "chrome-hub", "hub.json");
}

/**
 * @param {string} home
 * @returns {string} the storage state new session browsers are seeded from
 */
export function snapshotPath(home) {
  return path.join(home, ".cache", "playwright-shared-storage-state.json");
}

/**
 * The user's hub, or null when they have none or its file cannot be used.
 * @param {string} home
 * @returns {HubConfig | null}
 */
export function readHubConfig(home) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(hubPath(home), "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const { cookies_url, snapshot_url, read_token, write_token } = raw;
  for (const v of [cookies_url, snapshot_url, read_token, write_token])
    if (typeof v !== "string" || v === "") return null;
  return {
    cookiesUrl: cookies_url,
    snapshotUrl: snapshot_url,
    readToken: read_token,
    writeToken: write_token,
  };
}

/**
 * Cookies for our own services, the home network, loopback and bare
 * addresses stay in this browser: the lobby's own login is the user's to
 * keep, and the rest mean nothing to a browser elsewhere.
 * @param {string} domain
 * @returns {boolean}
 */
function privateDomain(domain) {
  const d = domain.replace(/^\./, "").toLowerCase();
  const bare = d.replace(/^\[(.*)\]$/, "$1");
  return (
    d === "viktorbarzin.me" ||
    d.endsWith(".viktorbarzin.me") ||
    d.endsWith(".lan") ||
    d === "localhost" ||
    d.endsWith(".localhost") ||
    net.isIP(bare) !== 0
  );
}

/**
 * The cookies worth sending: persistent, not expired, not private.
 * @param {Cookie[]} cookies
 * @param {number} now milliseconds
 * @returns {Cookie[]}
 */
export function pushable(cookies, now) {
  const nowS = now / 1000;
  return cookies.filter((c) => c.expires > nowS && !privateDomain(c.domain));
}

/**
 * @param {Cookie} c
 * @returns {string}
 */
function keyOf(c) {
  return `${c.name}|${c.domain}|${c.path}|${c.partitionKey ?? ""}`;
}

/**
 * @param {Cookie} c
 * @returns {string}
 */
function stampOf(c) {
  return `${c.expires}|${c.value}`;
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"]);

/**
 * The registrable site a cookie domain belongs to (amazon.co.uk, google.com),
 * by the same approximation of the public suffix list as the hub's site_of()
 * in infra stacks/chrome-service/files/broker/cookie_merge.py.
 * @param {string} domain
 * @returns {string}
 */
export function siteOf(domain) {
  const labels = domain.replace(/^\.+/, "").toLowerCase().split(".");
  const n = labels.length;
  if (n >= 3 && labels[n - 1].length === 2 && SECOND_LEVEL.has(labels[n - 2]))
    return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

/**
 * Splits cookies into request bodies the hub accepts, keeping each site's
 * cookies in one body so the hub sees the site's whole set. A single site too
 * large for one body is split, since nothing else can carry it.
 * @param {Cookie[]} cookies
 * @returns {Cookie[][]}
 */
function batches(cookies) {
  /** @type {Map<string, Cookie[]>} */
  const bySite = new Map();
  for (const c of cookies) {
    const site = siteOf(c.domain);
    const group = bySite.get(site);
    if (group) group.push(c);
    else bySite.set(site, [c]);
  }
  /** @type {Cookie[][]} */
  const out = [];
  /** @type {Cookie[]} */
  let cur = [];
  let bytes = 0;
  const flush = () => {
    if (cur.length > 0) out.push(cur);
    cur = [];
    bytes = 0;
  };
  for (const group of bySite.values()) {
    const sizes = group.map((c) => Buffer.byteLength(JSON.stringify(c)) + 1);
    const groupBytes = sizes.reduce((a, b) => a + b, 0);
    const fits = group.length <= MAX_BATCH && groupBytes <= MAX_BODY_BYTES;
    if (fits && (cur.length + group.length > MAX_BATCH || bytes + groupBytes > MAX_BODY_BYTES))
      flush();
    group.forEach((c, i) => {
      if (cur.length >= MAX_BATCH || (cur.length > 0 && bytes + sizes[i] > MAX_BODY_BYTES))
        flush();
      cur.push(c);
      bytes += sizes[i];
    });
  }
  flush();
  return out;
}

/**
 * Takes flock(2) on `lockPath` the way flock(1) does, so the hourly refresh
 * script and this process exclude each other. flock(1) locks the open file
 * description it is handed as fd 3; that description is ours too, so the lock
 * stays held after flock(1) exits, until we close it.
 * @param {string} lockPath
 * @returns {Promise<number>} the descriptor to close to let go
 */
async function lock(lockPath) {
  const fd = openSync(lockPath, "a", 0o600);
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn("flock", ["-w", String(LOCK_TIMEOUT_S), "3"], {
        stdio: ["ignore", "ignore", "ignore", fd],
      });
      child.once("error", reject);
      child.once("exit", (c) => resolve(c));
    });
    if (code !== 0) throw new Error(`flock exited ${code}`);
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/**
 * Replaces the local snapshot atomically, mode 0600, holding its lock.
 * @param {string} dest
 * @param {string} body
 */
export async function writeSnapshot(dest, body) {
  mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const fd = await lock(`${dest}.lock`);
  const tmp = `${dest}.new.${process.pid}`;
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
    closeSync(fd);
  }
}

export class CookiePusher {
  /** @type {Map<string, string>} what this session last sent, by cookie */
  #sent = new Map();
  /** @type {Promise<{ sent: number } | null> | null} */
  #running = null;
  #home;
  #log;
  #now;

  /**
   * @param {{ home: string, log: (msg: string) => void, now?: () => number }} opts
   */
  constructor({ home, log, now = Date.now }) {
    this.#home = home;
    this.#log = log;
    this.#now = now;
  }

  /**
   * When anything changed since this session's last push, sends every
   * pushable cookie, then refreshes the local snapshot from the hub. A push
   * asked for while one runs joins it.
   * @param {string} reason for the log: "periodic", "freeze", "close"
   * @param {() => Promise<Cookie[]>} read the browser's cookies, called at
   *   most once and before anything else is awaited
   * @returns {Promise<{ sent: number } | null>} null with no hub or on failure
   */
  push(reason, read) {
    this.#running ??= this.#push(reason, read).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /**
   * @param {string} reason
   * @param {() => Promise<Cookie[]>} read
   * @returns {Promise<{ sent: number } | null>}
   */
  async #push(reason, read) {
    const hub = readHubConfig(this.#home);
    if (!hub) return null;
    try {
      const all = pushable(await read(), this.#now());
      if (all.every((c) => this.#sent.get(keyOf(c)) === stampOf(c))) return { sent: 0 };
      /** @type {{ accepted: number, skipped: number, rejected: number }} */
      const totals = { accepted: 0, skipped: 0, rejected: 0 };
      for (const batch of batches(all)) {
        const res = await fetch(hub.cookiesUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${hub.writeToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ source: "tl-browser", cookies: batch }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`hub answered ${res.status}`);
        const answer = await res.json().catch(() => ({}));
        for (const k of /** @type {const} */ (["accepted", "skipped", "rejected"]))
          if (typeof answer?.[k] === "number") totals[k] += answer[k];
        for (const c of batch) this.#sent.set(keyOf(c), stampOf(c));
      }
      this.#log(
        `cookie push (${reason}): sent ${all.length}, accepted ${totals.accepted}, ` +
          `skipped ${totals.skipped}, rejected ${totals.rejected}`,
      );
      await this.#refresh(hub);
      return { sent: all.length };
    } catch (err) {
      this.#log(`cookie push (${reason}) failed: ${describe(err)}`);
      return null;
    }
  }

  /**
   * Rewrites the local snapshot from the hub's merged one, so the next
   * session browser on this box starts with these logins too.
   * @param {HubConfig} hub
   */
  async #refresh(hub) {
    const res = await fetch(hub.snapshotUrl, {
      headers: { authorization: `Bearer ${hub.readToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`snapshot answered ${res.status}`);
    const body = await res.text();
    const state = JSON.parse(body);
    if (!Array.isArray(state?.cookies) || !Array.isArray(state?.origins))
      throw new Error("snapshot is not a storage state");
    await writeSnapshot(snapshotPath(this.#home), body);
    this.#log(`snapshot refreshed: ${state.cookies.length} cookies`);
  }
}

/**
 * An error's message, without anything a request might echo back.
 * @param {unknown} err
 * @returns {string}
 */
function describe(err) {
  if (!(err instanceof Error)) return "unknown error";
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
  return `${err.message}${cause}`.slice(0, 200);
}
