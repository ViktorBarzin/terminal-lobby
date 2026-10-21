/**
 * tmux-api's /whoami as the auth gates' verifier (auth.ts). The request
 * carries exactly what the client's request carried: the identity header and
 * the proxy secret for a browser, or the bearer alone for a paired app.
 * tmux-api checks them and answers the OS user.
 */
import { relayHeaders, type WhoamiFetch } from "./auth.ts";

const WHOAMI_TIMEOUT_MS = 5_000;

export function tmuxApiWhoami(baseUrl: string): WhoamiFetch {
  return async (relay) => {
    const response = await fetch(`${baseUrl}/whoami`, {
      headers: relayHeaders(relay),
      signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status, body: undefined };
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  };
}
