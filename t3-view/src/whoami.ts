/**
 * tmux-api's /whoami as the auth gate's verifier (auth.ts). The request
 * carries exactly what the browser's request carried: the identity header and
 * the proxy secret. tmux-api checks both and answers the OS user and whether
 * that user is an admin.
 */
import { PROXY_SECRET_HEADER, type WhoamiFetch } from "./auth.ts";

const WHOAMI_TIMEOUT_MS = 5_000;

export function tmuxApiWhoami(baseUrl: string): WhoamiFetch {
  return async (relay) => {
    const response = await fetch(`${baseUrl}/whoami`, {
      headers: { [relay.header]: relay.identity, [PROXY_SECRET_HEADER]: relay.secret },
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
