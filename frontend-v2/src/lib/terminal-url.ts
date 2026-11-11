/**
 * ttyd terminal-attach URL builder — the `?arg=` positional contract, ported
 * VERBATIM (shape) from the vanilla frontend's `frameArgs()` (index.html). This
 * is red-line-class: ttyd's `-a` maps repeated `?arg=` params positionally to
 * $1..$8 in tmux-attach.sh, so dropping or reordering an arg silently breaks a
 * shared attach (memory #9926 — the 4th arg dying at the iframe boundary).
 *
 *   arg1  session name        (always)
 *   arg2  new-session command KEY (whitelisted: default|claude|codex|shell)
 *   arg3  base directory for a NEW session (a project's dir; absolute)
 *   arg4  session OWNER for a SHARED/foreign attach (a different OS user)
 *   arg5  ATTACH MODE, one question with three answers: absent to drive,
 *         "ro" to watch (a REQUEST — the server resolves it downgrade-only and
 *         sources `-r` from its own answer), "pre" to preload (read-write but
 *         carrying tmux's ignore-size flag, so a hover cannot move the
 *         session's window — ADR-0026)
 *   arg6  model a NEW session launches on ("opus", "gpt-5.6-terra", …)
 *   arg7  effort a NEW session launches at ("max", "xhigh", …)
 *   arg8  WHICH TMUX CLIENT this connection is, so a later size claim can name
 *         it (lib/client-id.ts). The attach script records this connection's
 *         pty against the id before it execs; tmux-api reads it back.
 *
 * A dir must land at arg3, an owner at arg4 and an attach mode at arg5, so
 * whenever a later arg is sent the earlier ones are emitted too ('default' as
 * the inert command placeholder, and an EMPTY owner at arg4 when watching your
 * own session — the attach script treats a blank owner as "mine"). Every gate
 * in that script reads an unrecognised value as no value, so an empty slot
 * standing in for an absent model or effort costs nothing.
 * `tmux -A` ignores -c on a live session, so sending the dir on every attach is
 * harmless. Pure + base-parameterized so it is unit-testable and so a canary
 * deploy can retarget the ttyd origin without touching call sites.
 */

import { ACT_AS } from "./config";

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
  /**
   * arg5 — Preload: the attach a HOVER starts, before the user has said they
   * want this session. `tmux attach-session -f ignore-size`, so it is
   * read-write and a click promotes this same client with
   * `refresh-client -f '!ignore-size'` rather than attaching again, but it
   * cannot resize the session's window while it is only a preload. Measured on
   * tmux 3.4 on the devvm 2026-09-11: a plain read-write attach from a 200x50
   * client moved a phone's 80x39 window to 200x49; with `-f ignore-size` it
   * stayed at 80x39 (ADR-0026).
   *
   * Its own option rather than a third state of {@link watch}, because they are
   * different requests that happen to share a slot: a watch is read-only and
   * pins the grid for life, a preload is read-write and leaves nothing behind.
   * Setting both throws — see {@link buildTerminalArgs}.
   */
  preload?: boolean;
  /**
   * arg6/arg7 — the model and effort a NEW session launches on, as FLAGS on the
   * process rather than a `/model` typed into it once it is up.
   *
   * Measured on this box 2026-09-06: launching with them costs what launching
   * without costs (2.40/2.54/2.84s bare against 2.49/2.42/4.49s flagged), while
   * driving the CLI's own picker afterwards costs 3.83/4.20/3.99s on a
   * browser-sized pane. The flags are free; the drive is four seconds and a
   * visible `/model` line in a conversation that has not started yet.
   *
   * Empty is the absence of a choice, and it is what every attach that is not a
   * fresh create sends: `tmux new-session -A` ignores the command entirely for
   * a session that already exists, so these only ever take effect on a create.
   */
  model?: string;
  effort?: string;
  /**
   * arg8 — WHICH TMUX CLIENT THIS CONNECTION IS, so a size claim can name one
   * (lib/client-id.ts mints it; tmux-api/clientreg.go reads it back).
   *
   * Minted ONCE per terminal mount and held for its life, reconnects included:
   * devvm/tmux-attach.sh rewrites the record against the pty of every attach,
   * so the newest socket wins under one name and an id a claim carries still
   * resolves. Minting it inside a call to this function would hand out a fresh
   * id on every re-read of the args, and the args are re-read often — every
   * reconnect reads them (terminal/attach.ts) and so does the liveness probe.
   *
   * OPTIONAL, and the whole point of that is the fallback. A socket opened
   * before this shipped carries no id, an id the shell's gate refuses becomes
   * no id, and both land on exactly the behaviour the endpoint had before:
   * promote the single preload client, 409 when nobody is driving.
   */
  client?: string;
}

/**
 * The positional `arg=` list, which is the whole of the attach.
 *
 * There is no page URL in front of it: the terminal is drawn by this app in
 * this document, and these args go straight onto /token and /ws, which is where
 * `ttyd -a` maps them to $1..$8 (terminal/attach.ts, terminal/wire.ts).
 *
 * They travelled out of band on the frame's NAME while the terminal was a
 * separate document, because the page URL was a cache key: with the session
 * name in the query, every session was its own entry for a 1.8 MB document —
 * measured 1,796,377 B for a name never seen before against 300 B for an exact
 * repeat, so opening a new session cost 8.4-10.3 s on a 400 kbps link every
 * single time. One document has one URL and no such cost.
 */
export function buildTerminalArgs(name: string, opts: TerminalUrlOpts = {}): string {
  if (opts.watch && opts.preload) {
    // One slot, one answer. Picking a winner here would be worse than failing:
    // a preload demoted to a watch attaches read-only, which calls PinGrid, and
    // grid.go holds that pin for as long as the client stays attached — so
    // every card the pointer crossed would keep a grid pin for as long as its
    // hidden mount lived, which is the outcome ADR-0026 exists to avoid.
    // A promoted watch would be the same mistake pointing the other way, at a
    // client that asked for less access than it got. So neither: the caller
    // hears about it on the first hover, in development, out loud.
    throw new TypeError(
      "terminal attach: watch and preload are mutually exclusive (both ride arg5)",
    );
  }
  // arg5 — the attach mode, resolved once so the slot list below cannot
  // disagree with itself about what position 5 holds.
  const mode: "" | "ro" | "pre" = opts.watch ? "ro" : opts.preload ? "pre" : "";

  /**
   * THE EIGHT SLOTS, in order, empty where there is nothing to say.
   *
   * A list rather than the nest of "deepest slot present" branches this used
   * to be. Each new arg rewrote the branch above it, and arg8 is carried by
   * nearly every attach rather than a rare one, so the nest would have had to
   * become the common path. The emitted string is unchanged for all seven
   * shapes that predate arg8, which test/terminal-url.test.ts pins case by
   * case — that equality is the point of the rewrite, not a side effect.
   *
   * `cmd` is empty rather than "default" here, so that a caller who asks for
   * the default command explicitly emits the same single arg as one who asks
   * for nothing. It becomes "default" below, as a placeholder, only when a
   * deeper slot needs pushing into position.
   */
  const slots = [
    name,
    opts.cmd && opts.cmd !== "default" ? opts.cmd : "",
    opts.dir ?? "",
    opts.owner ?? "",
    mode,
    opts.model ?? "",
    opts.effort ?? "",
    opts.client ?? "",
  ];
  // Nothing below the deepest slot anyone asked for. The session name always
  // survives: it is the attach.
  while (slots.length > 1 && slots[slots.length - 1] === "") slots.pop();
  // INTERIOR PLACEHOLDERS: a slot emitted only to push a deeper one into
  // position. The command takes 'default' and the dir takes it too (the attach
  // script ignores a non-absolute dir, and `tmux -A` ignores -c on a live
  // session). The OWNER slot stays EMPTY, because tmux-attach.sh reads a blank
  // arg4 as "mine" and a placeholder there would name an OS user that does not
  // exist. Everything below arg4 is gated the same way and reads empty as
  // absent, so none of them needs one either.
  if (slots.length > 1 && slots[1] === "") slots[1] = "default";
  if (slots.length > 2 && slots[2] === "") slots[2] = "default";
  return slots.map((v) => "arg=" + encodeURIComponent(v)).join("&");
}

/** Config-bound arg list — {@link buildTerminalArgs} with the act-as owner
 *  filled in. This is what every attach in the app is built from. */
export function terminalFrameArgs(name: string, opts?: TerminalUrlOpts): string {
  // The act-as switch (?as=) cannot reach ttyd — it resolves the guest from the
  // Authentik header itself and takes only positional ?arg= values — so here it
  // becomes arg4, the owner slot that already exists for shared attaches.
  //
  // A DEFAULT, not an override. The sidebar passes no owner for a session it
  // considers the caller's own, and in an as-bob tab bob's sessions are exactly
  // that: without this the attach would reach WIZARD's session of the same
  // name. But while acting as bob you can still see sessions a third party
  // shared WITH bob, and those carry their real owner — forcing the act-as
  // target there would attach the wrong account.
  //
  // A PRELOAD IN AN ACT-AS TAB IS REFUSED, ON PURPOSE, AND THAT IS THE SAFE
  // ANSWER OF THE THREE. The default applies to `pre` like any other mode, so a
  // hover in an as-bob tab builds `…&arg=bob&arg=pre`, and tmux-attach.sh's
  // own-sessions-only gate denies it: ttyd resolves its identity from the
  // Authentik header, which is the admin, never the lens target. The client
  // should not be asking — /whoami answers `osUser: bob` there, so the hover
  // eligibility in store/preload.ts reads bob's cards as "mine" — and gating
  // the hover on the lens is the fix that stops the wasted connection. What
  // this line must not do is paper over it, because the two other shapes are
  // both worse than a refusal:
  //
  //   - dropping `pre` and keeping the owner attaches bob's session read-write
  //     from a hidden mount, and a plain attach is what moves the window: 80x39
  //     to 200x49 on the measurement in ADR-0026. A hover would rewrap the
  //     session of the person being helped.
  //   - dropping the owner and keeping `pre` attaches the ADMIN's own session
  //     of the same name, under a card labelled with bob's.
  //
  // So the vector stays as it is and the refusal stays where it can be audited.
  // devvm/tmux-attach.sh answers it with a journal line and an immediate exit —
  // no banner, no hold — so the hidden terminal reports the preload failed, the
  // slot empties, and the click that follows attaches the ordinary way.
  const owner = opts?.owner || ACT_AS || undefined;
  return buildTerminalArgs(name, { ...opts, owner });
}
