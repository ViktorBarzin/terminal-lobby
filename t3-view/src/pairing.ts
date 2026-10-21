/**
 * Pairing a T3 app: the code from the lobby's Settings, exchanged for a device
 * token by tmux-api's POST /devices/exchange (ADR-0045).
 *
 * tmux-api answers that route on loopback only and refuses a request that
 * carries X-Real-IP, X-Forwarded-For or Forwarded, so the exchange must come
 * from this process and never be a relayed browser request. Node's fetch adds
 * none of those headers. The code and the token are never logged.
 */

export interface ExchangeRequest {
  readonly code: string;
  readonly label?: string;
  readonly deviceType?: string;
  readonly os?: string;
}

export type ExchangeResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly status: 401 | 502; readonly reason: string };

export type DeviceExchange = (request: ExchangeRequest) => Promise<ExchangeResult>;

const EXCHANGE_TIMEOUT_MS = 5_000;

export function tmuxApiExchange(baseUrl: string): DeviceExchange {
  return async (request) => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/devices/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: request.code,
          label: request.label ?? "",
          deviceType: request.deviceType ?? "",
          os: request.os ?? "",
        }),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, status: 502, reason: `tmux-api unreachable: ${String(error)}` };
    }
    const text = await response.text();
    if (response.status === 401) {
      return { ok: false, status: 401, reason: "tmux-api refused the pairing code" };
    }
    if (response.status !== 200) {
      return { ok: false, status: 502, reason: `tmux-api answered ${response.status}` };
    }
    let token: unknown;
    try {
      token = (JSON.parse(text) as { token?: unknown }).token;
    } catch {
      token = undefined;
    }
    return typeof token === "string" && token !== ""
      ? { ok: true, token }
      : { ok: false, status: 502, reason: "tmux-api answered an unexpected body" };
  };
}
