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
 *   arg5  Watch mode: "ro" to attach without driving (a REQUEST — the server
 *         resolves it downgrade-only and sources `-r` from its own answer)
 *
 * A dir must land at arg3, an owner at arg4 and a watch request at arg5, so
 * whenever a later arg is sent the earlier ones are emitted too ('default' as
 * the inert command placeholder, and an EMPTY owner at arg4 when watching your
 * own session — the attach script treats a blank owner as "mine").
 * `tmux -A` ignores -c on a live session, so sending the dir on every attach is
 * harmless. Pure + base-parameterized so it is unit-testable and so a canary
 * deploy can retarget the ttyd origin without touching call sites.
 */

import { ACT_AS, TERMINAL_BASE } from "./config";

export interface TerminalUrlOpts {
  /** arg2 — the new-session command key. Defaults to "default" (the user's tmux
   *  default-command decides). Only meaningful when CREATING a session. */
  cmd?: string;
  /** arg3 — absolute base directory for a NEW session (a project dir). */
  dir?: string;
  /** arg4 — the real OS-user owner for a SHARED/foreign attach; empty = own. */
  owner?: string;
  /** arg5 — Watch mode: attach read-only, so this client never drives the
   *  session and never moves its grid. Works on your own session as well as a
   *  shared one. Absent/false keeps today's read-write behaviour. */
  watch?: boolean;
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
  if (opts.watch) {
    // Deepest slot: emit ALL of arg2..arg4 so "ro" lands on $5. The owner slot
    // is deliberately empty for your own session — tmux-attach.sh reads a blank
    // arg4 as "mine", whereas a placeholder like 'default' would name an OS
    // user that does not exist.
    u +=
      "&arg=" +
      encodeURIComponent(cmd) +
      "&arg=" +
      encodeURIComponent(dir || "default") +
      "&arg=" +
      encodeURIComponent(owner) +
      "&arg=ro";
  } else if (owner) {
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
  // The act-as switch (?as=) cannot reach ttyd — it resolves the guest from the
  // Authentik header itself and takes only positional ?arg= values — so here it
  // becomes arg4, the owner slot that already exists for shared attaches.
  //
  // A DEFAULT, not an override. The sidebar passes no owner for a session it
  // considers the caller's own, and in an as-bob tab bob's sessions are exactly
  // that: without this the iframe would attach WIZARD's session of the same
  // name. But while acting as bob you can still see sessions a third party
  // shared WITH bob, and those carry their real owner — forcing the act-as
  // target there would attach the wrong account.
  const owner = opts?.owner || ACT_AS || undefined;
  return buildTerminalUrl(TERMINAL_BASE, name, { ...opts, owner });
}
