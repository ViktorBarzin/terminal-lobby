/**
 * The sidecar's settings, one field per environment variable.
 *
 * The identity header name comes from TL_AUTH_HEADER, the variable every
 * lobby service resolves by (authuser/resolve.go), so the sidecar and
 * tmux-api always read the same header. Everything else is the sidecar's own
 * and prefixed TL_T3_VIEW_, so TL_BIND (the Go services' listen address) never
 * moves this listener by accident.
 *
 * The one variable it refuses is TL_PROXY_SECRET. The sidecar verifies the
 * secret by asking tmux-api, never by holding it (README "Inbound auth"), and
 * a unit that hands it the secret anyway is a packaging mistake worth failing
 * loudly on.
 */

export interface SidecarConfig {
  readonly bind: string;
  readonly port: number;
  /** The identity header the proxy sets, as configured (any case). */
  readonly authHeader: string;
  /** tmux-api's base URL, no trailing slash. */
  readonly tmuxApiUrl: string;
  /** session-events' base URL, no trailing slash. */
  readonly sessionEventsUrl: string;
  /** The built T3 web client (build-web.sh's web/). */
  readonly webDir: string;
  /** The environment's name in T3's UI (TL_T3_VIEW_LABEL, else "Terminal Lobby"). */
  readonly environmentLabel: string;
  /**
   * Where the sidecar keeps what must outlive a restart (prompts awaiting
   * their row, the thread ids of sessions T3 created). Undefined keeps them in
   * memory only.
   */
  readonly stateDir: string | undefined;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_AUTH_HEADER = "X-Authentik-Username";
const DEFAULT_PORT = 7690;
// What T3 lists this server as. The box's hostname said "devvm", which names
// the machine rather than the lobby the sessions live in.
const DEFAULT_LABEL = "Terminal Lobby";

function value(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`TL_T3_VIEW_PORT must be a port number, got ${JSON.stringify(raw)}`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`TL_T3_VIEW_PORT must be 1-65535, got ${port}`);
  }
  return port;
}

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

export function loadConfig(env: Env): SidecarConfig {
  if ((env.TL_PROXY_SECRET ?? "") !== "") {
    throw new ConfigError(
      "TL_PROXY_SECRET is set in tl-t3-view's environment. The sidecar verifies the " +
        "secret through tmux-api /whoami and must not hold it: drop it from the unit " +
        "(UnsetEnvironment=TL_PROXY_SECRET).",
    );
  }
  // The port is validated before anything else reads it, including an empty
  // value, which is a typo rather than a request for the default.
  const rawPort = env.TL_T3_VIEW_PORT;
  return {
    bind: value(env, "TL_T3_VIEW_BIND") ?? "127.0.0.1",
    port: rawPort === undefined ? DEFAULT_PORT : parsePort(rawPort.trim()),
    authHeader: value(env, "TL_AUTH_HEADER") ?? DEFAULT_AUTH_HEADER,
    tmuxApiUrl: withoutTrailingSlash(value(env, "TL_T3_VIEW_TMUX_API") ?? "http://127.0.0.1:7684"),
    sessionEventsUrl: withoutTrailingSlash(
      value(env, "TL_T3_VIEW_SESSION_EVENTS") ?? "http://127.0.0.1:7685",
    ),
    webDir: value(env, "TL_T3_VIEW_WEB_DIR") ?? "/usr/lib/terminal-lobby/tl-t3-view/web",
    environmentLabel: value(env, "TL_T3_VIEW_LABEL") ?? DEFAULT_LABEL,
    // systemd's StateDirectory= sets STATE_DIRECTORY, colon-separated when
    // the unit names several.
    stateDir: value(env, "TL_T3_VIEW_STATE_DIR") ?? value(env, "STATE_DIRECTORY")?.split(":")[0],
  };
}
