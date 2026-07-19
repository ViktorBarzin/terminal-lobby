/**
 * ttyd terminal-attach URL builder — the `?arg=` positional contract, ported
 * VERBATIM (shape) from the vanilla frontend's `frameArgs()` (index.html). This
 * is red-line-class: ttyd's `-a` maps repeated `?arg=` params positionally to
 * $1..$4 in tmux-attach.sh, so dropping or reordering an arg silently breaks a
 * shared attach (memory #9926 — the 4th arg dying at the iframe boundary).
 *
 *   arg1  session name        (always)
 *   arg2  new-session command KEY (whitelisted: default|claude|codex|shell)
 *   arg3  base directory for a NEW session (a project's dir; absolute)
 *   arg4  session OWNER for a SHARED/foreign attach (a different OS user)
 *
 * A dir must land at arg3 and an owner at arg4, so whenever a later arg is sent
 * the earlier ones are emitted too ('default' as the inert command placeholder).
 * `tmux -A` ignores -c on a live session, so sending the dir on every attach is
 * harmless. Pure + base-parameterized so it is unit-testable and so a canary
 * deploy can retarget the ttyd origin without touching call sites.
 */

import { TERMINAL_BASE } from "./config";

export interface TerminalUrlOpts {
  /** arg2 — the new-session command key. Defaults to "default" (the user's tmux
   *  default-command decides). Only meaningful when CREATING a session. */
  cmd?: string;
  /** arg3 — absolute base directory for a NEW session (a project dir). */
  dir?: string;
  /** arg4 — the real OS-user owner for a SHARED/foreign attach; empty = own. */
  owner?: string;
}

/**
 * Build the ttyd attach URL for `name` under `base` — the terminal PAGE URL
 * (default "/term.html"; see config.TERMINAL_BASE). `base` is the full page path
 * (or origin+path for a cross-origin canary), and the positional args are appended
 * as its query, so `buildTerminalUrl("/term.html", "foo")` → "/term.html?arg=foo".
 * Every arg value is encodeURIComponent'd.
 */
export function buildTerminalUrl(
  base: string,
  name: string,
  opts: TerminalUrlOpts = {},
): string {
  let u = base + "?arg=" + encodeURIComponent(name);
  const cmd = opts.cmd && opts.cmd.length > 0 ? opts.cmd : "default";
  const owner = opts.owner ?? "";
  const dir = opts.dir ?? "";
  if (owner) {
    // Foreign attach: owner MUST reach $4, so command + dir precede it as
    // placeholders ('default' when absent — a non-absolute dir is ignored by
    // the attach branch, which sources `-r` from the server).
    u +=
      "&arg=" +
      encodeURIComponent(cmd) +
      "&arg=" +
      encodeURIComponent(dir || "default") +
      "&arg=" +
      encodeURIComponent(owner);
  } else if (dir) {
    u += "&arg=" + encodeURIComponent(cmd) + "&arg=" + encodeURIComponent(dir);
  } else if (cmd !== "default") {
    u += "&arg=" + encodeURIComponent(cmd);
  }
  return u;
}

/** Config-bound builder: `buildTerminalUrl` against TERMINAL_BASE (the
 *  same-origin /term.html page by default; `?terminal=` overrides it). */
export function terminalUrl(name: string, opts?: TerminalUrlOpts): string {
  return buildTerminalUrl(TERMINAL_BASE, name, opts);
}
