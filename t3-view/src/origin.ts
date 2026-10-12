/**
 * Which browser contexts may act through the sidecar.
 *
 * The auth gate proves who the person is, but on a WebSocket handshake that
 * proof (the Authentik cookie, then the headers Traefik adds) arrives whatever
 * page opened the socket: the cookie is scoped to the whole viktorbarzin.me
 * site, so every page on a sibling host is same-site and the browser sends it
 * regardless of SameSite. A browser always sends Origin on a WebSocket
 * handshake and cannot be made to send another page's, so requiring it to name
 * this host is what keeps a page elsewhere from driving an admin's sessions.
 * It mirrors session-events' sameOrigin (browser.go), including refusing a
 * handshake with no Origin at all.
 *
 * HTTP writes get the same treatment where the browser says where they came
 * from (Sec-Fetch-Site). A client that sends no fetch metadata is not a browser
 * page, so it cannot carry someone else's cookie.
 */
import type { RequestHeaders } from "./auth.ts";

function single(headers: RequestHeaders, name: string): string | undefined {
  const raw = headers[name];
  const value = typeof raw === "string" ? raw : raw?.[0];
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function isSameOriginUpgrade(headers: RequestHeaders): boolean {
  const origin = single(headers, "origin");
  const host = single(headers, "host");
  if (origin === undefined || host === undefined) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.host === "" || (url.protocol !== "https:" && url.protocol !== "http:")) return false;
  return url.host.toLowerCase() === host.toLowerCase();
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const OWN_CONTEXTS = new Set(["same-origin", "none"]);

export function isCrossSiteWrite(method: string, headers: RequestHeaders): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const site = single(headers, "sec-fetch-site");
  return site !== undefined && !OWN_CONTEXTS.has(site.toLowerCase());
}

/** The lobby's host name, beside the sidecar's own (t3view.example.org -> terminal.example.org). */
const LOBBY_LABEL = "terminal";

const LOOPBACK_ANCESTORS = "frame-ancestors http://localhost:* http://127.0.0.1:* http://[::1]:*";

/**
 * The CSP that names who may frame the sidecar's pages: the lobby beside it,
 * https://terminal.<this host's domain>, and nothing else. Traefik's global
 * CSP allows every *.viktorbarzin.me page; a browser enforces both headers, so
 * this narrows it to the one page the embed patch talks to. A loopback host is
 * the local check (dev-proxy.mjs), framed by a loopback lobby.
 */
export function frameAncestors(host: string | undefined): string {
  const name = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (name === "localhost" || name === "127.0.0.1" || name === "[::1]") return LOOPBACK_ANCESTORS;
  const labels = name.split(".");
  const isAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.startsWith("[");
  if (isAddress || labels.length < 3 || labels.some((l) => l === "")) {
    return "frame-ancestors 'none'";
  }
  return `frame-ancestors https://${LOBBY_LABEL}.${labels.slice(1).join(".")}`;
}
