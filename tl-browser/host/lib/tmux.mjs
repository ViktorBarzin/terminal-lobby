// Records the browser on its tmux session, which is how tmux-api and
// session-events find it: @tl_browser holds "live" or "frozen" and
// @tl_browser_sock the viewer socket. Both are cleared when the host exits.
// Outside tmux (no TMUX_PANE) every call here does nothing.

import { execFile, execFileSync } from "node:child_process";

export const OPT_STATE = "@tl_browser";
export const OPT_SOCK = "@tl_browser_sock";

export class TmuxRegistration {
  /** @type {string | null} */
  #pane;

  /** @param {string | undefined} pane the TMUX_PANE this host was started in */
  constructor(pane) {
    this.#pane = pane || null;
  }

  get inTmux() {
    return this.#pane !== null;
  }

  /** @returns {Promise<string | null>} the session id, e.g. "$12" */
  sessionId() {
    const pane = this.#pane;
    if (!pane) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(
        "tmux",
        ["display-message", "-p", "-t", pane, "#{session_id}"],
        { timeout: 3000 },
        (err, stdout) => {
          resolve(err ? null : stdout.trim() || null);
        },
      );
    });
  }

  /**
   * @param {string} name
   * @param {string} value
   * @returns {Promise<void>}
   */
  set(name, value) {
    const pane = this.#pane;
    if (!pane) return Promise.resolve();
    return new Promise((resolve) => {
      execFile("tmux", ["set-option", "-t", pane, name, value], { timeout: 3000 }, () => resolve());
    });
  }

  /** Synchronous, because it runs on the way out of the process. */
  clearSync() {
    const pane = this.#pane;
    if (!pane) return;
    for (const name of [OPT_STATE, OPT_SOCK]) {
      try {
        execFileSync("tmux", ["set-option", "-u", "-t", pane, name], {
          timeout: 2000,
          stdio: "ignore",
        });
      } catch {
        // The session may already be gone, which clears its options too.
      }
    }
  }
}
