# The lobby renders its own terminal

Viktor, 2026-09-02, mid-design on the connection status work: *"also we can move
the iframe into a native component where we render the terminal"*, and then
*"let's build it"*.

The terminal has been a `frontend/term.html` page in a cross-document iframe.
Everything the shell wants to know about it crosses a postMessage boundary one
message type at a time, and everything the page needs from the shell crosses
back. The connection status work (ADR-0016) had just added one more such message
because the shell could not otherwise see whether the terminal was connected.

This replaces the iframe with xterm mounted by the SPA, behind `?native=1` while
it is incomplete.

```stats
330 KB | xterm, its own chunk (83 KB gzipped)
946 KB | what term.html vendors today
8,199 | lines of app logic in term.html
8 | pure modules its rules were lifted into
366 | tests over those modules and the socket
0 | class static blocks in the shipped chunk
```

## What was blocking it, and why that stopped being true

`vite.config.ts` marked xterm `external` with a guard-rail, on the reasoning that
it must never enter the no-store single-file blob — every deploy would have
re-downloaded it. Each half of that is now false:

| The rationale said | Measured 2026-09-02 |
|---|---|
| the lobby is one single-file document | `viteSingleFile` was removed; it is an HTML shell plus content-hashed chunks |
| xterm would re-download every deploy | `/assets/` is served `immutable`, and its own comment cites this as what stopped the terminal page costing ~474 KB per deploy |
| xterm needs hand-transpiling for iPadOS 15 | the npm **ESM** build has zero class static blocks; only the CDN's CJS build (18 of them) does, which is what `scripts/vendor-xterm.py` was transpiling |
| — | esbuild's `safari15` and `esnext` output for the built chunk are **byte identical**: nothing needs lowering |

A docs-versus-live mismatch is a finding, and this one had been guarding against
a build shape that no longer existed.

## The shape

One impure module owns the socket and the timers. Everything it does on an edge,
it asks a pure module.

```mermaid
flowchart TD
  C["TerminalNative.tsx<br/>mounts xterm, owns the DOM"] --> A["terminal/attach.ts<br/>the only impure module:<br/>socket + timers"]
  A --> R["reconnect.ts<br/>ladder, generations,<br/>the 30s stability proof"]
  A --> L["liveness.ts<br/>half-open watchdog"]
  A --> B["battery.ts<br/>hidden-tab suspend"]
  A --> H["held.ts<br/>offline typing"]
  A --> W["wire.ts<br/>ttyd frames, the input<br/>choke point"]
  C --> T["theme.ts<br/>CSS vars to ITheme"]
  A --> S["the ADR-0016 badge"]
```

`attach.ts` decides nothing: an event goes into `reduce()` and it carries out the
actions that come back. That is what lets the rules be tested without a socket, a
browser or a clock — none of them could be, inside term.html.

## How the rules were extracted, and why that matters to how much you trust them

Eight agents lifted one area each out of term.html; eight more read each module
against the source trying to REFUTE that it preserved the behaviour.

The first pass produced **290 passing tests and 17 behaviour changes**, and the
adversarial pass found all 17. Among them: Ctrl+C reaching the pty as SIGINT with
a highlight on screen (xterm right-trims rows, so a drag into trailing whitespace
has a selection range but empty text — the failure ADR-0003 exists to prevent); a
liveness probe loop that never exited on any keystroke without an echo; a
read-only watcher's keys being held and later flushed into a session they cannot
write to; and a `/token` 404 becoming a successful empty-token handshake.

A second round fixed those, and a blind re-check found six more — two real, and
four false claims in comments, including one that argued its own divergence from
term.html with a reason that was not true.

The lesson is not about agents. Tests written by whoever wrote the module encode
the module's assumptions, so a green suite from that pairing is not evidence.
Every generate stage here is paired with an independent refute stage.

## What driving it caught that assertions did not

- xterm ships a stylesheet and does not lay out without it, and the host div had
  no size. DOM checks said "rendered" and text extraction returned plausible
  content while the screen showed a column of overlapping glyphs.
- The held-key replay fired on socket `open` and lost everything. ttyd drops what
  arrives before the process is spawned; the first output frame is the only proof
  there is one, which `wire.ts` already said about the resize.
- `decodeServerFrame`'s `instanceof ArrayBuffer` fails cross-realm, so a test
  could only reach it with a view rather than the ArrayBuffer a socket delivers.
  Branded now: a test that has to avoid the production path is not testing it.

## What is verified

Against a live tmux session, through the shipped code path: xterm mounts and
renders with the app's theme; a pressed key reaches the pty and echoes; a dropped
socket walks the badge up the ladder and recovers; a socket **frozen** with
SIGSTOP — `ss` confirming both ends still ESTABLISHED, so nothing closed — is
given up on by the client alone, which only the liveness watchdog does, and
recovers when unfrozen; typing into a dead socket is held and replayed
(`❯ qw`); and paste through the unchanged `__tlPasteToTerminal` bridge lands on
the prompt.

## What is not done

Selection and copy (module extracted, not wired), pinch-zoom, sixel images and
WebGL. The last two are xterm ADDONS rather than logic to lift, so they are a
dependency decision of their own — and sixel is load-bearing here (ADR-0004,
`show-image`).

`term.html` is untouched and remains the shipped terminal. `?native=1` is
off by default.

## The cutover is blocked, deliberately

iPadOS 15.8 is the floor, and it is the device `vendor-xterm.py` exists to
protect: xterm 6 shipped syntax that WebKit could not parse and the lobby was a
blank page there for two days. The evidence that the new chunk is safe is a byte
comparison, not a device — nobody has opened `?native=1` on the iPad, and there
is no instrument here that can. Until someone does, the flag stays off and
term.html stays.

## Amendment — 2026-09-02: the floor gained a runtime check, and one it lacked

The section above describes the evidence as a byte comparison. That was accurate
for syntax and incomplete for the rest, because `build.target` governs only what
the engine can parse. A method the engine never shipped parses fine and throws
where it is called, which is the failure mode `baseline-polyfills.ts` exists for.

Two things changed on 2026-09-02.

**The runtime-API guard in `scripts/test_frontend_compat.py` had not been
checking anything since 2026-08-28.** It read `api in html` while its fixture had
moved to returning `(path, [(label, code), …])`, so it asked whether a list of
tuples contained a string. That is False for every API, so the guard passed
unconditionally for five days, including through this port. The bundle did reach
`AbortSignal.timeout` and `URL.canParse` in that window; both were already
polyfilled, so nothing shipped broken. The guard now searches each chunk by
label, and two further tests keep it honest: one feeds it a fake chunk and
asserts it fires, one asserts the shipped bundle is a non-empty haystack.

**xterm reaches `OffscreenCanvas`, which arrived in Safari 16.4.** Bundling xterm
put 330 KB of third-party code inside the floor for the first time, so all 88
chunks were swept. xterm's character-width measurer constructs one and survives
the floor because upstream wraps it in `try`/`catch` and falls back to measuring
in the DOM. That fallback is upstream's choice and could change on a version
bump, so `frontend-v2/test/xterm.baseline.test.ts` opens a real terminal in
jsdom — which also has no `OffscreenCanvas` — and asserts that written text
round-trips. Removing the fallback from the installed xterm makes it fail, so the
test does detect the regression it is there for.

Both guards were also run against the SPA extracted from the released
`v0.25.0` .deb, rather than only a local build.

What has not changed: nobody has opened `?native=1` on the iPad, and there is
still no instrument here that can. The guards are stronger; they are not a
device. The flag stays off.

## Amendment — 2026-09-05: the flag flipped, and then both sides of it went

Two sentences above are records rather than current state, and both were already
overtaken before this amendment was written. "`term.html` is untouched and
remains the shipped terminal. `?native=1` is off by default" held until
2026-09-04, when the de-iframe plan's passes 1 and 2 closed the parity gap and
the default became native. "Until someone does, the flag stays off and term.html
stays" describes an iPad gate that the plan then waived by decision, flipping on
the evidence available, which is not a device.

On 2026-09-05 `term.html`, `TerminalView.tsx`, `scripts/vendor-xterm.py` and the
escape hatch were deleted together, with `/term-build-id` and the 18-type
postMessage protocol.
[ADR-0020](0020-one-terminal-in-one-document.md) records what went, what
replaced it and what was dropped on purpose.

What has still not changed is the sentence this ADR has carried through both
amendments: nobody has opened the native terminal on iPadOS 15.8, and there is
no instrument here that can. The guards are stronger than they were and they are
not a device. What the deletion changes is the cost of being wrong about that,
since a device where the built-in terminal is unusable now needs a package
downgrade rather than a setting.
