/**
 * tmux-api's paired-devices routes (tmux-api/devices.go, ADR-0045), for
 * Settings → T3 apps.
 *
 * Built through `apiUrl` like every other lobby call, so a lens tab's `?as=`
 * rides along and tmux-api refuses it with a 403: a device token would be a
 * credential to someone else's account. The UI does not offer the page there
 * in the first place. Only a signed-in browser may call these; a paired app's
 * own token is refused, so a device cannot mint another.
 *
 * A failure throws an Error carrying the server's own reason when it sent one
 * (`{"error": "..."}`), such as the 429 for too many codes outstanding.
 */
import { apiUrl } from "./config";
import { fetchWithDeadline } from "./http";

/** A paired app as its owner sees it. Times are unix seconds. */
export interface DeviceView {
  id: string;
  label: string;
  deviceType: string;
  os: string;
  created: number;
  /** 0 for a device not used since it paired. */
  lastSeen: number;
}

/** What POST /devices/pair answers: the code, and when it lapses (unix s). */
export interface PairCode {
  code: string;
  expiresAt: number;
}

async function fail(res: Response, what: string): Promise<never> {
  let reason = "";
  try {
    const text = (await res.text()).trim();
    try {
      const body = JSON.parse(text) as { error?: unknown };
      reason = typeof body.error === "string" ? body.error : text;
    } catch {
      reason = text;
    }
  } catch {
    /* no body */
  }
  throw new Error(reason || `${what} HTTP ${res.status}`);
}

/** POST /devices/pair → a fresh code for the caller. */
export async function pairDevice(): Promise<PairCode> {
  const res = await fetchWithDeadline(apiUrl("/devices/pair"), { method: "POST" });
  if (!res.ok) return fail(res, "pair");
  const body = (await res.json()) as Partial<PairCode>;
  if (typeof body.code !== "string" || typeof body.expiresAt !== "number") {
    throw new Error("pair: unexpected answer");
  }
  return { code: body.code, expiresAt: body.expiresAt };
}

/** GET /devices → the caller's paired apps, newest first. */
export async function listDevices(): Promise<DeviceView[]> {
  const res = await fetchWithDeadline(apiUrl("/devices"), { cache: "no-store" });
  if (!res.ok) return fail(res, "devices");
  const arr = (await res.json()) as unknown;
  return Array.isArray(arr) ? (arr as DeviceView[]) : [];
}

/** DELETE /devices/{id}. A device already gone (404) is what was asked for. */
export async function revokeDevice(id: string): Promise<void> {
  const res = await fetchWithDeadline(apiUrl(`/devices/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) return fail(res, "revoke device");
}
