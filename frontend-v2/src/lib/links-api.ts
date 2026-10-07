/**
 * tmux-api's public-links routes (tmux-api/links.go), for the Share dialog,
 * Settings and the session bar's Stop.
 *
 * Built through `apiUrl` like every other lobby call, so a lens tab's `?as=`
 * rides along and the server refuses it with a 403 — the UI does not offer
 * links there in the first place (`canShare`), and this keeps the refusal on
 * the server where it belongs.
 *
 * A failure throws an Error carrying the server's own text when it sent one:
 * "invalid lifetime…", "too many links; revoke some first" and "no such running
 * session" are written for a person and say more than a status code.
 */
import { apiUrl } from "./config";
import { fetchWithDeadline } from "./http";
import type { LinkTTL, LinkView } from "../types/lobby";

async function fail(res: Response, what: string): Promise<never> {
  let text = "";
  try {
    text = (await res.text()).trim();
  } catch {
    /* no body */
  }
  throw new Error(text || `${what} HTTP ${res.status}`);
}

/** GET /links → every live link the caller owns, newest first. */
export async function listLinks(): Promise<LinkView[]> {
  const res = await fetchWithDeadline(apiUrl("/links"), { cache: "no-store" });
  if (!res.ok) return fail(res, "links");
  const arr = (await res.json()) as unknown;
  return Array.isArray(arr) ? (arr as LinkView[]) : [];
}

export interface CreateLinkRequest {
  /** The session's tmux name now. */
  name: string;
  ttl: LinkTTL;
  note?: string;
}

/** What POST /links answers. `token` is shown once: only its hash is kept. */
export interface CreatedLink {
  link: LinkView;
  token: string;
}

/** POST /links → the new link and its token. */
export async function createLink(body: CreateLinkRequest): Promise<CreatedLink> {
  const res = await fetchWithDeadline(apiUrl("/links"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return fail(res, "create link");
  return (await res.json()) as CreatedLink;
}

/** DELETE /links/{id}. A link already gone (404) is what was asked for. */
export async function revokeLink(id: string): Promise<void> {
  const res = await fetchWithDeadline(apiUrl(`/links/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) return fail(res, "revoke link");
}

/** DELETE /links?session=<name>: the session bar's Stop, which revokes every
 *  link on the session and detaches everyone who came in on one. */
export async function revokeSessionLinks(name: string): Promise<number> {
  const res = await fetchWithDeadline(apiUrl(`/links?session=${encodeURIComponent(name)}`), {
    method: "DELETE",
  });
  if (!res.ok) return fail(res, "stop links");
  try {
    const body = (await res.json()) as { revoked?: unknown };
    return typeof body.revoked === "number" ? body.revoked : 0;
  } catch {
    return 0;
  }
}
