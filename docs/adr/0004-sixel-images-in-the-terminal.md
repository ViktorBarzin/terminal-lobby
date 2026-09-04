# Sixel images render inline; the pixel-size gap is closed in ttyd

> **Superseded 2026-09-04** by
> `docs/plans/2026-09-04-native-terminal-de-iframe-design.md`: Viktor deprecated
> the flow, in his words *"let's deprecate the sixel flow. it's not very useful
> today. we rely on the library and text mode"*. Everything below happened and
> every link in the chain worked as described. What changed is the judgement
> about how much the inline picture is worth next to the two surfaces that
> carry images now, the session library (ADR-0005, which this decision already
> leaned on for persistence) and text mode.
>
> Three things moved:
>
> - **The ttyd patch was re-cut.** Fix 1, the pixel-size plumbing decided here
>   (optional `xpixel`/`ypixel` on `RESIZE_TERMINAL`, forwarded via
>   `TIOCSWINSZ`), came out of `devvm/ttyd-local.patch`, so `struct winsize` is
>   back to upstream's `{process->rows, process->columns, 0, 0}`. Fix 2 (client
>   PAUSE/RESUME flow control) and fix 3 (the `-I` index ETag) stayed exactly as
>   they were, and keep their numbers, so every doc that names one still points
>   at the same hunk. The file this ADR calls `devvm/ttyd-pixel-size.patch` was
>   renamed `devvm/ttyd-local.patch` when the second and third fixes joined it.
> - **`show-image` files the image, tells the session, and prints where to open
>   it.** The split pane and the `viu` inside it are gone for every client, not
>   only the web one: the tmux branch of the script no longer invokes `viu` at
>   all, so a human on a real sixel-capable terminal inside tmux loses the
>   inline picture as well. What the script does instead is register the image
>   into the per-session store, put a one-line notice on the tmux status line of
>   every client attached to the session, and print the
>   `/clipboard/img/<session>/<name>` path it landed on. The notice is there
>   because the usual caller is an agent's tool call, which captures stdout: the
>   printed line reaches the agent, and the status line is what reaches the
>   person at the terminal. That POST also became synchronous, because the
>   stored name is assigned by the server and a failed registration now means
>   there is nothing to look at.
> - **The native terminal never sends pixels.** `frontend-v2/src/terminal/wire.ts`
>   dropped both fields from its resize frame in the same change.
>
> **One consequence was accepted knowingly: sixel stops working in the shipped
> `term.html` iframe in this release, not after it.** `term.html` is untouched
> and keeps sending the pixel fields (`:8325`), a re-cut ttyd no longer reads
> them, so the pty reports 0 by 0 and tmux draws the `SIXEL IMAGE (WxH)`
> placeholder this ADR documents for a zero-pixel pty. The image addon is still
> vendored in that page and still amends DA1, so programs inside tmux go on
> emitting sixel; what stops is tmux re-emitting it to this client. Anyone who
> was watching pictures appear inline sees that text line instead. An image that
> came through `show-image` is in the session library and the status-line notice
> says so; one a program emitted straight into the terminal is not, because
> nothing files it.

Goal (Viktor, 2026-07-08): view images inline in the web terminal —
`viu photo.jpg` in any session and the picture appears in the flow of
the terminal, through tmux, on desktop and phone.

The chain was prototyped end-to-end and every link verified. xterm.js
5.5.0 with `@xterm/addon-image@0.9.0` renders sixel (and iTerm IIP) on
the canvas; loading the addon also amends the terminal's DA1 response
so tmux and the programs inside it auto-detect sixel support, and
answers `CSI 14t`/`16t` pixel-size reports. tmux 3.4 (Ubuntu build,
sixel-enabled) passes sixel through. viu 1.6.1 built with
`--features icy_sixel` emits it.

One link was broken: tmux draws its "SIXEL IMAGE (WxH)" text
placeholder instead of re-emitting sixel when the client terminal's
pty reports a zero pixel size. tmux 3.4 `tty.c`,
`tty_cmd_sixelimage`:

```c
if (tty->xpixel == 0 || tty->ypixel == 0) fallback = 1;
```

and tmux learns `xpixel`/`ypixel` exclusively from `TIOCGWINSZ` on the
client tty. ttyd 1.7.7 hardcodes those fields to zero on every resize
(`src/pty.c`: `struct winsize size = {rows, columns, 0, 0}`), and its
JSON resize message has no way to carry them. So under stock ttyd,
tmux can never see a pixel size and sixel never reaches the browser.

Decision: patch ttyd. `devvm/ttyd-pixel-size.patch` (~10 lines, three
hunks) adds `uint16_t xpixel, ypixel` to the pty process struct, reads
optional `"xpixel"`/`"ypixel"` fields from the RESIZE_TERMINAL JSON,
and passes them through in the `TIOCSWINSZ` call. Old frontends that
don't send the fields get the previous behaviour exactly.

The frontend closes the loop with three pieces:

- the image addon (pinned CDN build, same defensive UMD-shape loading
  as the clipboard addon);
- `sendResize()` now measures `.xterm-screen` and sends `xpixel`/
  `ypixel` alongside cols/rows — stock ttyd ignores the extra fields,
  so the frontend stays deployable against an unpatched binary;
- a one-shot resize kick on the FIRST server output message of each
  connection: ttyd's initial JSON handshake carries no pixel fields
  and ttyd drops RESIZE messages that arrive before the process is
  spawned, so pixels would otherwise only start flowing on the first
  real window resize. First output is the earliest proof the process
  exists.

## Considered Options

- **tmux configuration or a newer tmux** — nothing to configure: the
  pixel size is not an option, and both tmux 3.4 and 3.5 read it only
  from `TIOCGWINSZ` (verified in source). No tmux version fixes a pty
  that reports 0×0.
- **A pty shim between ttyd and tmux** (wrapper allocating its own
  pty, stamping pixel sizes) — a custom data pump inserted into every
  session's interactive hot path, always attached, adding latency and
  a failure mode; rejected against a 10-line upstream-able patch.
- **Sixel passthrough hacks** (`allow-passthrough` + escaping the
  sequences past tmux) — viu doesn't tmux-wrap its output, and
  passthrough'd images bypass tmux's screen model entirely: no redraw
  persistence on reattach/switch. Solves the wrong layer.

## Consequences

- We run a forked ttyd binary. Mitigation: the delta is a single
  in-repo patch file, `scripts/build-ttyd.sh` rebuilds it reproducibly
  from the pinned upstream 1.7.7 tag (idempotent, checksum-markered),
  and an upstream PR is planned so the fork can eventually retire.
  Upstream PR: https://github.com/tsl0922/ttyd/pull/1560 (open, 2026-07-08) — retire the local patch if/when it merges into a released ttyd
- `scripts/deploy.sh` ships `out/ttyd` only when it exists — building
  stays an explicit `build-ttyd.sh` step, never a deploy side effect.
- Any sixel-capable program now renders inline, not just viu:
  `img2sixel`, matplotlib's sixel backends, etc. — the DA1 amendment
  makes them auto-detect it.
- viu is a system binary on the devvm, installed outside this repo's
  deploy: `cargo install viu --features icy_sixel` (v1.6.1 — the
  feature is off by default and MUST be on), then
  `sudo install ~/.cargo/bin/viu /usr/local/bin/viu`. In a terminal
  without sixel viu falls back to half-block characters, so nothing
  breaks where the chain isn't present.
- Images are per-connection state: tmux re-emits sixel to each
  attached client whose pty reports pixels, and redraws images on
  reattach where the pixel info is present.
- The image addon buffers decoded images in a FIFO per terminal,
  default cap 128 MB (plus a 25 MB single-image limit) — bounded, but
  nonzero browser memory per open session iframe.

## Amendment — 2026-08-28: sixel is skipped on a link judged slow

The decision stands wherever the image addon loads. It now does not load when the
connection diagnostics classify the link as slow (see
`docs/plans/2026-08-28-slow-client-performance-design.md`): the terminal page
skips the webgl, image and unicode11 addons, and tmux falls back to its
"SIXEL IMAGE (WxH)" text placeholder — the same path this ADR describes for a pty
with no pixel size.

What that saves is the parse and the decode buffers, not the bytes: the addons are
vendored inline in term.html, so the code arrives either way. A viewer can force
the full experience with the Connection setting in the terminal's own settings
panel, which pins the tier per device.

