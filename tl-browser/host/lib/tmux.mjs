// Records the browser on its tmux session, which is how tmux-api and
// session-events find it: @tl_browser holds "live" or "frozen" and
// @tl_browser_sock the viewer socket. Both are cleared when the host exits.
// Outside tmux (no TMUX_PANE) every call here does nothing.
//
// The options are the session's, and two Claudes in one tmux session each run
// a host. The one that registered last holds them. A host only changes or
// clears them while they name its own socket, so one host exiting or freezing
// does not hide or mislabel the other's browser; and a host whose state
// changes while nobody holds them takes them back. The launcher hands them to
// a surviving host when the holder exits (tl-browser/registration.go).

import { execFile, execFileSync } from "node:child_process";

export const OPT_STATE = "@tl_browser";
export const OPT_SOCK = "@tl_browser_sock";

/**
 * Runs tmux. Each call answers its stdout, or null when tmux failed, which for
 * show-options is an option that is not set.
 * @typedef {{
 *   run: (args: string[]) => Promise<string | null>,
 *   runSync: (args: string[]) => string | null,
 * }} TmuxRunner
 */

/** @type {TmuxRunner} */
const execRunner = {
  run: (args) =>
    new Promise((resolve) => {
      execFile("tmux", args, { timeout: 3000 }, (err, stdout) => resolve(err ? null : stdout));
    }),
  runSync: (args) => {
    try {
      return execFileSync("tmux", args, { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString();
    } catch {
      // The session may already be gone, which clears its options too.
      return null;
    }
  },
};

export class TmuxRegistration {
  /** @type {string | null} */
  #pane;
  /** @type {TmuxRunner} */
  #tmux;
  /** @type {string | null} the socket this host registered */
  #sock = null;

  /**
   * @param {string | undefined} pane the TMUX_PANE this host was started in
   * @param {TmuxRunner} [runner]
   */
  constructor(pane, runner = execRunner) {
    this.#pane = pane || null;
    this.#tmux = runner;
  }

  get inTmux() {
    return this.#pane !== null;
  }

  /** @returns {Promise<string | null>} the session id, e.g. "$12" */
  async sessionId() {
    const pane = this.#pane;
    if (!pane) return null;
    const out = await this.#tmux.run(["display-message", "-p", "-t", pane, "#{session_id}"]);
    return out?.trim() || null;
  }

  /**
   * Records this host's socket on the session, live. It takes the options
   * over from any other host, since the newest browser is the one the agent
   * in this session just opened.
   * @param {string} sock
   * @returns {Promise<void>}
   */
  async register(sock) {
    const pane = this.#pane;
    if (!pane) return;
    this.#sock = sock;
    await this.#tmux.run(["set-option", "-t", pane, OPT_SOCK, sock]);
    await this.#tmux.run(["set-option", "-t", pane, OPT_STATE, "live"]);
  }

  /**
   * Records a freeze or a thaw, while the options are this host's or nobody's.
   * @param {"live" | "frozen"} state
   * @returns {Promise<void>}
   */
  async setState(state) {
    const pane = this.#pane;
    const sock = this.#sock;
    if (!pane || !sock) return;
    const holder = (await this.#tmux.run(["show-options", "-v", "-t", pane, OPT_SOCK]))?.trim() || "";
    if (holder !== sock && holder !== "") return;
    if (holder === "") await this.#tmux.run(["set-option", "-t", pane, OPT_SOCK, sock]);
    await this.#tmux.run(["set-option", "-t", pane, OPT_STATE, state]);
  }

  /** Synchronous, because it runs on the way out of the process. */
  clearSync() {
    const pane = this.#pane;
    const sock = this.#sock;
    if (!pane || !sock) return;
    const holder = this.#tmux.runSync(["show-options", "-v", "-t", pane, OPT_SOCK])?.trim() || "";
    if (holder !== sock) return;
    for (const name of [OPT_STATE, OPT_SOCK]) this.#tmux.runSync(["set-option", "-u", "-t", pane, name]);
  }
}
