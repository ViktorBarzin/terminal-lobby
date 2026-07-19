# frontend-v2 — terminal-lobby v2 frontend (SolidJS + TypeScript)

The from-scratch rewrite of terminal-lobby's frontend (roadmap pillars #0 + #2).
This directory is the **foundation**: the build pipeline, the shared wire
contract, the resumable event stream, the two-view app shell, and the structured
text-mode renderer. It lives **alongside** the vanilla `frontend/` — the existing
app is untouched and still ships until v2 reaches cutover.

## What this is

A **two-view app** over a single tmux/Claude session:

- **Text mode (primary)** — a MessagesTimeline-style structured render of the
  session's normalized event stream: turn folding, collapsed tool rows with
  expand-to-raw, full-width assistant **markdown with mermaid + inline images**,
  user bubbles, a composer, and a composer-docked permission panel.
- **Terminal mode (fallback)** — a stub today; it will host the existing ttyd
  iframe (a live pty attach to the *same* tmux session). xterm stays **external**
  (never bundled), per the deploy decision.

The switch is a segmented **`[ Text | Terminal ]`** control: **full-swap XOR**,
both views **permanently mounted** (CSS-hidden, never unmounted), `Cmd/Ctrl-J`
toggles, per-session/per-device `{mode}` in localStorage, activity dot on the
inactive segment.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm run build        # → dist/index.html (ONE inlined file, no sidecars)
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

`?session=<id>` selects the session; `?api=<base>` points the SSE/control calls
at a remote devvm for local dev (default is same-origin).

## Build output

`npm run build` uses `vite-plugin-singlefile` to inline **all** JS + CSS into a
single `dist/index.html` — verified: `dist/` contains exactly one file, no
`.js`/`.css`/`.wasm`/worker sidecars. Serving stays byte-identical to the vanilla
app (ttyd `-I index.html`). The build id is injected via Vite `define`
(`__TL_BUILD__`), replacing the old `sed` token.

## Layout

```
src/
  types/events.ts        Wire contract — mirrors session-events/event.go EXACTLY
  lib/config.ts          Endpoints (/events/<s>, /permission/<id>) + build id
  sse/client.ts          Resumable SSE client (Last-Event-ID, backoff+jitter,
                         instant-retry on visible/online) — DOM-free, testable
  store/session.ts       SSE → Solid store of events + permission/send control
  store/viewmode.ts      Per-session/per-device {mode} persistence
  theme/theme.css        The 9-theme CSS-var token layer (ported verbatim)
  theme/theme.ts         Live theme switch + xterm ITheme derivation
  components/
    timeline.logic.ts    PURE transcript→rows derivation (unit-tested, no DOM)
    MessagesTimeline.tsx  Rows-as-data renderer (fold / tool / working / …)
    Markdown.tsx          solid-markdown + remark-gfm + rehype-sanitize
    Mermaid.tsx           Lazy mermaid render (dynamic import; fold into 1 file)
    Composer.tsx          Prompt input + Send↔Stop morph + number-key approvals
    PermissionPanel.tsx   Composer-docked Approve/Deny → POST /permission/<id>
    ViewSwitch.tsx        Segmented Text|Terminal + activity dot
    TextView / TerminalView / App
test/                    logic, render smoke, SSE client, event-parse suites
```

## Wire contract

`src/types/events.ts` mirrors the Go `Event` struct in
`session-events/event.go` field-for-field (`id, kind, session, turnId, body,
tool, toolId, reqId, isError, at`) and the 11 `kind` discriminators. The renderer
only ever sees this normalized shape, never raw transcript JSONL.

## Foundation stubs / follow-ups

- **Terminal view** is a placeholder (ttyd iframe wiring is P2).
- **Send / interrupt** POST to a provisional `/input/<session>` endpoint that
  pillar #1's `session-events` service has not finalized yet; failures are
  swallowed so the read path is unaffected. Optimistic echo + dedup is deferred.
- **Virtualization**, auto-fallback engine, mobile soft-keys, PWA/SW, gallery,
  golden-master suite — later phases (see the roadmap + rewrite-design docs).
