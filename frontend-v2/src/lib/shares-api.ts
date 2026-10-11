/**
 * tmux-api's named-share routes (tmux-api/shares.go), for the People half of
 * the Share dialog (ADR-0043). A share lets another account on this box open
 * one of your sessions: watch it, or drive it as you.
 *
 * Built through `apiUrl` like every other lobby call. A failure throws an
 * Error carrying the server's own text when it sent one ("unknown or unmapped
 * guest", "no such running session"), which is written for a person.
 */
import { apiUrl, withOwner } from "./config";
import { foreignHash } from "./foreign-hash";
import { fetchWithDeadline } from "./http";

export type ShareMode = "ro" | "rw";

/** One grant, as GET /shares lists it. */
export interface ShareView {
  owner: string;
  name: string;
  guest: string;
  mode: ShareMode;
}

async function fail(res: Response, what: string): Promise<never> {
  let text = "";
  try {
    text = (await res.text()).trim();
  } catch {
    /* no body */
  }
  throw new Error(text || `${what} HTTP ${res.status}`);
}

/** GET /shares → every grant you made or were given. */
export async function listShares(): Promise<ShareView[]> {
  const res = await fetchWithDeadline(apiUrl("/shares"), { cache: "no-store" });
  if (!res.ok) return fail(res, "shares");
  const arr = (await res.json()) as unknown;
  return Array.isArray(arr) ? (arr as ShareView[]) : [];
}

/** POST /shares: invite `guest` to your session `name`, or change their mode. */
export async function createShare(body: {
  name: string;
  guest: string;
  mode: ShareMode;
}): Promise<void> {
  const res = await fetchWithDeadline(apiUrl("/shares"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return fail(res, "share");
}

/** DELETE /shares/{owner}/{name}/{guest}: the owner removing a guest, or a
 *  guest leaving. Their open terminal is detached at once. */
export async function removeShare(owner: string, name: string, guest: string): Promise<void> {
  const path = `/shares/${[owner, name, guest].map(encodeURIComponent).join("/")}`;
  const res = await fetchWithDeadline(apiUrl(path), { method: "DELETE" });
  if (!res.ok && res.status !== 404) return fail(res, "remove share");
}

/** The lobby URL that opens someone else's session: the hash form the page
 *  reads for a foreign session, with tmux's session id so it still finds the
 *  session after a rename (lib/foreign-hash.ts). It grants nothing; only an
 *  invited account gets past the server's access check. */
export function inviteUrl(origin: string, owner: string, name: string, id?: string): string {
  return `${origin}/${foreignHash(owner, name, id)}`;
}

/** A /sessions/{name}… route on someone else's session, for a guest: tmux-api
 *  runs it in the owner's server once its access check lets the caller in. */
function guestSessionUrl(owner: string, name: string, rest = ""): string {
  return withOwner(apiUrl(`/sessions/${encodeURIComponent(name)}${rest}`), owner);
}

/** A driving guest kills the owner's session. The owner is pushed who did it,
 *  and brings it back from Restore if they want it; there is no undo here,
 *  since a restore would land in the guest's own account. */
export async function guestKill(owner: string, name: string): Promise<void> {
  const res = await fetchWithDeadline(guestSessionUrl(owner, name), { method: "DELETE" });
  if (!res.ok && res.status !== 404) return fail(res, "kill");
}

/** A driving guest retitles the owner's session, which renames it as well
 *  (ADR-0022). The share follows the rename server-side. */
export async function guestRetitle(owner: string, name: string, title: string): Promise<void> {
  const res = await fetchWithDeadline(guestSessionUrl(owner, name, "/title"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) return fail(res, "rename");
}
