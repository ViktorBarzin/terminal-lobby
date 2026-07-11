#!/usr/bin/env python3
"""ttyd WebSocket flow-control probe (plan Task 3.4).

Speaks the raw ttyd 1.7.7 wire protocol (WS subprotocol 'tty': first client
message is the bare JSON handshake `{"AuthToken":…,"columns":…,"rows":…}`;
client opcodes INPUT '0'/0x30, PAUSE '2'/0x32, RESUME '3'/0x33; server OUTPUT
frames carry '0' + pty bytes) to verify the server honors client PAUSE.

Why: stock ttyd 1.7.7 pause is a no-op — pty_spawn() leaves process->paused
stuck true (src/pty.c:470) so pty_pause()'s `if (process->paused) return;`
early-return (src/pty.c:124) always fires, and even without that the
SERVER_WRITEABLE pump unconditionally pty_resume()s after every flushed chunk
(src/protocol.c:279). devvm/ttyd-local.patch fixes both; this probe is the
red/green check.

Instrument design (every point below bit this probe's earlier drafts —
calibrated on this devvm 2026-07-11):
- tmux frame-skips for lagging clients, so a `yes | head -c 20M` flood
  reaches the client as only ~2.4 MB of collapsed repaints (~390 frames/s,
  ~0.13 MiB/s, ~17 s) — gross byte counts can't discriminate a honored
  pause. The discriminator is stream SHAPE: after PAUSE and a bounded
  drain-to-quiet of the in-flight backlog, an honoring server goes to ZERO
  while the flood is provably still alive (RESUME must revive it).
- That backlog (≤ one 64 KiB pty chunk + kernel socket buffers) drains at
  the slow collapsed-stream rate, i.e. for SECONDS — fixed wall-clock
  slices after PAUSE misattribute it, in both directions.
- The reader is a free-running consumer task and phase logic polls its
  timestamped counters (an `asyncio.wait_for` around every recv() throttles
  a small-frame stream and lets buffered backlog masquerade as live server
  output).

Legs:
  pause (default)   Attach, flood the pty (`yes | head -c 20M` via tmux
                    send-keys), send PAUSE mid-flood (at 512 KiB received or
                    0.75 s after first flood byte, whichever first). The
                    in-flight backlog (≤ one 64 KiB pty chunk + kernel
                    socket buffers) legitimately drains for a while at the
                    slow collapsed-stream rate, so the probe first waits for
                    the stream to go QUIET (no bytes for 0.75 s, capped at
                    8 s — a no-op server never goes quiet mid-flood: the
                    collapsed stream runs ~390 frames/s for ~17 s), then
                    holds a 2 s STRICT window in which an honoring server
                    delivers ZERO bytes. Then RESUME: the stream must revive
                    (resume_alive) — proves the flood was merely paused, not
                    finished (kills the too-short-flood false green).
                    pause_honored = went-quiet AND strict bytes < 4 KiB AND
                    resume_alive. Exit 0 iff honored.
  --no-pause        Same flood, NO PAUSE sent: measures un-paused throughput
                    (OUTPUT payload bytes/s, first→last byte, done after a
                    1.5 s quiet gap). Run against pre-fix and post-fix
                    binaries — plan acceptance is within ~10% (guards
                    against a partial-freeze regression that a total-freeze
                    check would miss). Exit 0 iff output was seen.

Defaults target the dev harness's ttyd child
(`python3 scripts/dev-harness.py --scratch --ttyd-bin out/ttyd`):
ws://127.0.0.1:7996/ws, scratch tmux server `-L tl-dev`, session `main`.
Against production ttyd:
  flowprobe.py --url ws://127.0.0.1:7681/ws \
      --header 'X-Authentik-Username: vbarzin' --tmux-socket ''
(--tmux-socket '' send-keys the default tmux server of whoever runs the
probe; or --no-flood and start the flood yourself in the attached session.)

Requires: python3 + `websockets` (10.4 verified), tmux for the flood trigger.
"""

import argparse
import asyncio
import json
import subprocess
import sys
import time

import websockets

OUTPUT = 0x30       # server → client: pty output frame marker ('0')
PAUSE = b"2"        # client → server: 0x32
RESUME = b"3"       # client → server: 0x33

POLL = 0.02         # counter-polling granularity for phase logic (seconds)


def log(msg: str) -> None:
    print(f"[flowprobe] {msg}", file=sys.stderr, flush=True)


def tmux_argv(socket_name: str) -> list:
    return ["tmux", "-L", socket_name] if socket_name else ["tmux"]


def send_flood(args: argparse.Namespace) -> None:
    base = tmux_argv(args.tmux_socket)
    target = ["-t", args.tmux_session]
    # C-c first: clears any half-typed prompt state (harmless at a clean
    # prompt); then the flood command.
    subprocess.run([*base, "send-keys", *target, "C-c"], check=True)
    subprocess.run([*base, "send-keys", *target, args.flood_cmd, "Enter"],
                   check=True)
    log(f"flood triggered via {' '.join(base)} send-keys: {args.flood_cmd!r}")


class Meter:
    """OUTPUT-payload counters, updated by the consumer task."""

    def __init__(self) -> None:
        self.bytes = 0
        self.frames = 0
        self.t_last = None

    def snapshot(self) -> int:
        return self.bytes


async def consume(ws, meter: Meter) -> None:
    """Free-running reader: drain frames at full speed, count OUTPUT bytes."""
    try:
        async for msg in ws:
            if isinstance(msg, str):
                msg = msg.encode()
            if msg and msg[0] == OUTPUT and len(msg) > 1:
                meter.bytes += len(msg) - 1
                meter.frames += 1
                meter.t_last = time.monotonic()
    except websockets.ConnectionClosed:
        pass


async def wait_quiet(meter: Meter, quiet: float, cap: float) -> bool:
    """Sleep until the byte counter is unchanged for `quiet` s.

    Returns True when the quiet gap was reached, False when `cap` seconds
    passed with the stream still moving.
    """
    end = time.monotonic() + cap
    last = meter.snapshot()
    last_change = time.monotonic()
    while time.monotonic() < end:
        await asyncio.sleep(POLL)
        cur = meter.snapshot()
        if cur != last:
            last, last_change = cur, time.monotonic()
        elif time.monotonic() - last_change >= quiet:
            return True
    return False


async def probe(args: argparse.Namespace) -> int:
    headers = []
    for h in args.header or []:
        name, sep, value = h.partition(":")
        if not sep:
            raise SystemExit(f"--header expects 'Name: value', got {h!r}")
        headers.append((name.strip(), value.strip()))

    async with websockets.connect(
            args.url, subprotocols=["tty"], extra_headers=headers,
            max_size=None, compression=None, ping_interval=None) as ws:
        # ttyd handshake: bare JSON as the first client message (JSON_DATA).
        await ws.send(json.dumps({
            "AuthToken": args.token,
            "columns": args.columns,
            "rows": args.rows,
        }).encode())
        log(f"connected {args.url} (subprotocol {ws.subprotocol!r})")

        meter = Meter()
        reader = asyncio.ensure_future(consume(ws, meter))
        try:
            # Let the attach redraw settle so it doesn't count as flood.
            await wait_quiet(meter, quiet=0.4, cap=3.0)
            base = meter.snapshot()
            log(f"attach settled ({base} bytes of redraw)")

            if not args.no_flood:
                send_flood(args)

            # Wait for the first flood byte.
            cap = time.monotonic() + args.max_seconds
            while meter.snapshot() == base:
                if time.monotonic() > cap:
                    log("ERROR: no flood output before deadline")
                    print("pause_honored: unknown (no flood output)")
                    return 2
                await asyncio.sleep(POLL)
            t_flood = time.monotonic()

            if args.no_pause:
                # ---- Throughput control leg: count to stream quiesce ----
                await wait_quiet(meter, quiet=args.quiesce,
                                 cap=args.max_seconds)
                total = meter.snapshot() - base
                active = max((meter.t_last or t_flood) - t_flood, 1e-3)
                rate = total / active
                print("mode: throughput (no PAUSE sent)")
                print(f"total_bytes: {total} in {meter.frames} frames")
                print(f"active_seconds: {active:.3f}")
                print(f"bytes_per_sec: {rate:.0f} "
                      f"({rate / 1048576:.2f} MiB/s)")
                return 0 if total > 0 else 2

            # ---- Pause leg ----
            # Phase 1: accumulate pre-PAUSE flood bytes until the trigger.
            while True:
                pre = meter.snapshot() - base
                now = time.monotonic()
                if (pre >= args.pause_after_bytes
                        or now - t_flood >= args.pause_after_secs):
                    break
                if now > cap:
                    log("ERROR: not enough flood output before deadline")
                    print("pause_honored: unknown (flood too thin)")
                    return 2
                await asyncio.sleep(POLL)

            # Phase 2: PAUSE, let the in-flight backlog drain to quiet.
            t_pause = time.monotonic()
            b_pause = meter.snapshot()
            await ws.send(PAUSE)
            went_quiet = await wait_quiet(meter, quiet=args.drain_quiet,
                                          cap=args.drain_cap)
            drained = meter.snapshot() - b_pause
            drain_secs = time.monotonic() - t_pause

            # Phase 3: the strict window — an honoring (and drained) server
            # now delivers NOTHING.
            b_strict = meter.snapshot()
            await asyncio.sleep(args.post_window)
            strict_bytes = meter.snapshot() - b_strict

            # Phase 4: RESUME — the stream must revive, proving the flood
            # outlived the pause (and leaving nothing backed up behind us).
            b_resume = meter.snapshot()
            await ws.send(RESUME)
            await wait_quiet(meter, quiet=0.5, cap=5.0)
            resumed = meter.snapshot() - b_resume

            honored = (went_quiet
                       and strict_bytes < args.strict_threshold
                       and resumed > 0)
            pre_secs = t_pause - t_flood
            pre_rate = pre / max(pre_secs, 1e-3)
            print("mode: pause")
            print(f"pre_pause_bytes: {pre} over {pre_secs:.3f}s "
                  f"({pre_rate / 1048576:.2f} MiB/s)")
            print(f"post_pause_drain: {drained} bytes, "
                  + (f"quiet after {drain_secs - args.drain_quiet:.2f}s"
                     if went_quiet else
                     f"NEVER went quiet (cap {args.drain_cap:.1f}s)")
                  + f" (gap {args.drain_quiet:.2f}s)")
            print(f"strict_window_bytes: {strict_bytes} in "
                  f"{args.post_window:.1f}s after quiet "
                  f"(threshold {args.strict_threshold})")
            print(f"resume_alive: {'true' if resumed > 0 else 'false'} "
                  f"({resumed} bytes after RESUME)")
            print(f"pause_honored: {'true' if honored else 'false'}")
            return 0 if honored else 1
        finally:
            reader.cancel()
            try:
                await reader
            except asyncio.CancelledError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="ws://127.0.0.1:7996/ws",
                        help="ttyd WebSocket endpoint (default: the dev "
                             "harness ttyd child, ws://127.0.0.1:7996/ws)")
    parser.add_argument("--header", action="append", metavar="'Name: value'",
                        help="extra WS handshake header (repeatable), e.g. "
                             "'X-Authentik-Username: vbarzin' for prod :7681")
    parser.add_argument("--token", default="",
                        help="AuthToken for the handshake JSON (default '')")
    parser.add_argument("--columns", type=int, default=200)
    parser.add_argument("--rows", type=int, default=50)
    parser.add_argument("--tmux-socket", default="tl-dev",
                        help="tmux -L socket for the flood send-keys "
                             "(default tl-dev = the harness scratch server; "
                             "'' = the default tmux server)")
    parser.add_argument("--tmux-session", default="main",
                        help="tmux session for the flood (default main)")
    parser.add_argument("--flood-cmd", default="yes | head -c 20M",
                        help="flood command typed into the pane "
                             "(default: 'yes | head -c 20M')")
    parser.add_argument("--no-flood", action="store_true",
                        help="don't send-keys; you start the flood yourself")
    parser.add_argument("--no-pause", action="store_true",
                        help="throughput control leg: never send PAUSE, "
                             "measure un-paused bytes/s to stream quiesce")
    parser.add_argument("--pause-after-bytes", type=int, default=512 * 1024,
                        help="send PAUSE once this many flood bytes arrived "
                             "(default 524288)")
    parser.add_argument("--pause-after-secs", type=float, default=0.75,
                        help="…or this long after the first flood byte, "
                             "whichever comes first (default 0.75)")
    parser.add_argument("--drain-quiet", type=float, default=0.75,
                        help="post-PAUSE: gap of silence that counts as "
                             "'backlog drained' (default 0.75s)")
    parser.add_argument("--drain-cap", type=float, default=8.0,
                        help="post-PAUSE: max wait for that silence — a "
                             "no-op server streams past it (default 8s)")
    parser.add_argument("--post-window", type=float, default=2.0,
                        help="strict zero-byte window after the drain "
                             "(default 2.0s)")
    parser.add_argument("--strict-threshold", type=int, default=4096,
                        help="bytes in the strict window below this = "
                             "honored (default 4096)")
    parser.add_argument("--quiesce", type=float, default=1.5,
                        help="throughput leg: gap that ends the stream "
                             "(default 1.5s)")
    parser.add_argument("--max-seconds", type=float, default=45.0,
                        help="overall probe deadline (default 45s)")
    args = parser.parse_args()

    try:
        sys.exit(asyncio.run(probe(args)))
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, websockets.WebSocketException) as exc:
        log(f"ERROR: {exc}")
        print("pause_honored: unknown (connection error)")
        sys.exit(2)


if __name__ == "__main__":
    main()
