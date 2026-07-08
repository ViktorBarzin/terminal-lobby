# Sixel images render inline; the pixel-size gap is closed in ttyd

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
