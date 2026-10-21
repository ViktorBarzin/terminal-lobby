# The T3 view's embed contract

The lobby frames T3 Code's web client from its own origin as a third view of a
session ([ADR-0044](../docs/adr/0044-t3-code-renders-a-session-through-its-own-protocol.md),
[design](../docs/plans/2026-10-12-t3-view-design.md)). The two documents talk
only through `postMessage`. This page is the contract between the lobby's side
(`frontend-v2/src/components/T3Host.tsx` and `frontend-v2/src/t3/embed.logic.ts`)
and the embed patch (`patches/`), so the patch can be written against it
without reading the lobby's code.

Version 1, second revision. Every message carries `v: 1`, and each side
ignores a message with any other version. The second revision adds `tl-route`
(frame to lobby). A lobby without it drops the message as an unknown type, so
it is additive and the version stays 1.

## The frame's URL

The lobby loads one of two URLs:

| When | URL |
|---|---|
| The lobby has seen this origin's environment id before | `{origin}/{environmentId}/{threadId}?embed` |
| First load from this origin | `{origin}/?embed` |

- `origin` is `https://t3view.<the lobby's domain>` in production
  (`https://t3view.viktorbarzin.me` for `terminal.viktorbarzin.me`). For a local
  check the lobby takes `?t3view=<origin>`, limited to http on loopback. The
  lobby grants the frame clipboard access only on the production origin.
- `environmentId` is the one the sidecar's descriptor carries
  (`GET /.well-known/t3/environment`). The lobby learns it from `tl-ready` and
  keeps it in `localStorage` under `tl:t3view:env:v1:{origin}`.
- `threadId` is the session's birth name: tmux-api `/sessions` `bornAs` when
  it is set, otherwise `name`. It does not change when the session is renamed
  (ADR-0022). The sidecar maps it to the session's current name. Path segments
  are percent-encoded.
- `embed` (a bare flag) turns the patch on, and only inside a frame. Without
  it the client behaves as upstream. T3's own navigation drops the query, so
  the patch remembers the flag for the frame's life (sessionStorage).

The lobby keeps at most one T3 frame per tab. On a desktop browser with
`Element.moveBefore` (Chromium 133 and later), the lobby boots that frame
early, on the root (`/?embed`), in a hidden park, and moves it into whichever
session shows the T3 view, then back to the park when that session lets it go.
The move keeps the frame's document, so the frame never reloads and the URL
names only the thread it booted on. Every thread after that arrives by
`tl-open`. Elsewhere (a phone, a tablet, a browser without `moveBefore`),
switching to another session unmounts the frame and mounts a new one for that
session, as in the first cut. When T3's own
navigation moves the frame to another thread, `tl-route` tells the lobby,
which either follows to that session or sends the frame back.

## The parent's origin

The frame posts only to its parent's origin and accepts messages only from it.
It reads that origin from the browser rather than from the URL, so the page
that frames it cannot choose it:

1. `location.ancestorOrigins[0]` where the browser has it (Chrome, Safari).
2. Otherwise the origin of `document.referrer` (Firefox). The lobby sets no
   referrer policy on the frame, so the default
   `strict-origin-when-cross-origin` sends the lobby's origin.
3. Neither available, or the answer is `"null"`: the frame posts nothing.

The frame then accepts that origin only when it is the lobby itself:
exactly `https://terminal.<the frame's domain>` (`https://terminal.viktorbarzin.me`
for `t3view.viktorbarzin.me`), or `http` on loopback with the frame on loopback
too. Any other parent, a sibling page on the same site included, gets a frame
that behaves as upstream and posts nothing. The parent the frame accepts sees
every chord it forwards, so this is a single origin rather than a domain.

Which pages can frame the sidecar at all is set by CSP. Traefik's global
header allows `frame-ancestors 'self' *.viktorbarzin.me`, and the sidecar adds
its own `frame-ancestors https://terminal.<its domain>` on every page it
serves (`frame-ancestors http://localhost:* http://127.0.0.1:* http://[::1]:*`
on a loopback host). A browser enforces both, so only the lobby can frame it.
The lobby, for its part, trusts a message only from the T3 origin it framed
and from that frame's own window.

## Messages

### Frame to lobby

Posted with `window.parent.postMessage(message, parentOrigin)`, never with `"*"`.

| `type` | When | Body |
|---|---|---|
| `tl-ready` | Once, as soon as the frame knows its environment id | `{ type: "tl-ready", v: 1, environmentId: string, threadId: string \| null }` |
| `tl-key` | A chord from the latest `tl-bindings` was pressed in the frame | `{ type: "tl-key", v: 1, key, code, ctrlKey, metaKey, shiftKey, altKey, repeat }` |
| `tl-route` | After `tl-ready`, whenever the frame's thread route changes | `{ type: "tl-route", v: 1, threadId: string \| null, session: { key: string, name: string } \| null }` |

- `environmentId` in `tl-ready` is the sidecar's descriptor's. The simplest
  way for the patch to get it is its own same-origin
  `GET /.well-known/t3/environment`; reading it from the client's environment
  store works too.
- `threadId` in `tl-ready` is the thread the frame is showing, or `null` on
  any other route.
- `tl-key` copies the `KeyboardEvent` fields of the same names. `key` and
  `code` are at most 32 characters; the lobby drops longer ones.
- `tl-route` reports a route change the frame made on its own: T3's command
  palette, New thread, or the frame following a `tl-open`. `threadId` is the
  thread route's id, or `null` on a route that is no thread (a new thread's
  draft, the index). Before posting, the frame asks the sidecar, same-origin,
  `GET /.well-known/t3/session/{threadId}`, which answers
  `{ "key": "...", "name": "..." }` for one of the user's own sessions (`key`
  is the lobby's key for it: its birth name, else its name now) and 404 for
  someone else's thread or an unknown one; `session` carries that answer or
  `null`. A 404 is asked again for about 45 seconds before `null` is sent
  (`findRouteSession`): a new thread's route shows as its first prompt goes,
  before the sidecar has claimed its session, and reporting `null` then made
  the lobby send the frame back to the old session. A report the next route
  change overtook is not sent. The frame does not report the route
  `tl-ready` already named.
- The lobby accepts a message only when `event.origin` is the T3 origin it
  framed and `event.source` is that frame's window. Any other shape or type is
  dropped. A key is replayed as a keydown and nothing more, so no message can
  name a lobby command directly.
- On `tl-route` the lobby does nothing when `threadId` is `null` or `session`
  names the session it framed. When `session` names another of the caller's
  own sessions in the lobby's list, the lobby selects that session and opens
  it in the T3 view, which mounts a new frame for it. Otherwise (no session,
  someone else's, or one the lobby's list does not have) it posts `tl-open`
  with its own thread, so the frame goes back to the session the lobby's
  header, keepalive and chords belong to.

### Lobby to frame

Posted with `frame.contentWindow.postMessage(message, t3Origin)`, and only
after `tl-ready`. The frame accepts a message only when
`event.source === window.parent` and `event.origin` is the parent's origin
from the section above.

| `type` | When | Body |
|---|---|---|
| `tl-bindings` | After every `tl-ready`, and whenever the lobby's bindings change (Settings, an override saved in another tab) | `{ type: "tl-bindings", v: 1, chords: FrameChord[] }` |
| `tl-open` | After `tl-ready` when the frame is not on the session's thread, whenever the thread changes, and in answer to a `tl-route` the lobby does not follow | `{ type: "tl-open", v: 1, threadId: string }` |

`tl-open` asks the frame to route to `/{environmentId}/{threadId}` with its own
environment id, through the client's router so the client does not reload. A
full navigation (`location.replace` with `?embed`) also works, at the cost of a
reload.

The lobby's `threadId` is the session's key, and the sidecar's thread id can
differ from it: a session made from inside T3 keeps the id T3 minted, and a
hand-named session renamed while the sidecar ran keeps its first name. So the
frame first asks the sidecar, same-origin, `GET /.well-known/t3/thread/{key}`
(`{ "threadId": "..." }`, 404 when no session of the user's answers to the
key), routes to that id, and stays put when it is already there. A first load
of `/{environmentId}/{key}` is redirected by the sidecar to the thread's id in
the same way.

Details of the patch's side:

- `tl-ready` is sent once per page load.
- A `tl-open` that arrives before the router is ready is kept and applied once
  it is.
- In embed mode the patch turns T3's `planModeEnabled` client setting on when
  the person has not chosen, since T3 hides its plan toggle otherwise and the
  embed has no Settings page.
- In embed mode the composer's Plan/Build and runtime-mode picks follow the
  server thread. T3 keeps them in a sticky per-thread draft
  (`composerDraftStore`) and applies the draft on the next send when it
  differs from the server, so a mode the session left on its own (a plan
  approved from its card, a mode changed in the lobby or the terminal) would
  come back with the next message. Whenever the routed thread's
  `interactionMode` or `runtimeMode` differs from the one last seen on the
  page, including the first time the page sees the thread, the patch clears
  that field of the draft, and the composer shows the server's mode again
  (`draftModesToClear` in `embed.logic.ts`, `useDraftFollowsServerModes` in
  `embed.tsx`). A pick made since the last change is kept until the send
  applies it. A pick left unsent across a reload is dropped.
- In embed mode a model or effort picked in the composer goes to the session
  when it is picked, as the lobby's Text view does, rather than riding on the
  next send. T3 keeps the pick in the same draft, and the lobby cannot change
  the model while a turn runs or a question is open, so a pick sent with a
  message was dropped while the composer went on showing it. The patch sends
  `thread.model-selection.set` for a pick the person made (T3 also seeds the
  draft from the last model used, which is not sent) when it differs from the
  server thread's model or effort, then drops the pick from the draft so the
  composer shows the session's model. When the sidecar refuses, a toast gives
  the lobby's reason (for a running turn, that the session is working) and the
  composer goes back to the model the session is on (`modelPickToApply` and
  `withoutModelPick` in `embed.logic.ts`, `useModelPickApplies` in
  `embed.tsx`).

A `FrameChord` is:

```ts
interface FrameChord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;               // lowercased KeyboardEvent.key: "1", "[", "k", "enter", "escape"
  code?: string;             // a KeyboardEvent.code that also matches: "Digit1", "BracketLeft", "KeyK", "Slash"
  notWhileEditing?: true;    // keep the key in the frame while focus is in a text field
  passive?: true;            // forward only if T3 left it unhandled; never preventDefault
}
```

## Forwarding keys

Until the first `tl-bindings` arrives the frame forwards nothing. It keeps
only chords with Ctrl, Alt or Meta, or Escape, and drops the rest of the
list: the lobby asks for nothing else, and a bare or Shift-only key would
forward ordinary typing.

A keydown matches a chord when all four modifiers equal the chord's
(`ctrlKey === ctrl`, and the same for shift, alt and meta) and either
`event.key.toLowerCase() === key` (with `"esc"` read as `"escape"`) or
`code` is present and `event.code === code`. The `code` leg is what keeps
Alt+1 working where a modifier changes `key`: macOS Option+1 produces `"¡"`,
and AZERTY Alt+1 produces `"&"`.

For each keydown in the frame:

| Chord flags | What the frame does |
|---|---|
| none | In a `keydown` listener registered on `window` in the capture phase before T3's own: `preventDefault()`, `stopImmediatePropagation()`, then post `tl-key`. T3 never sees the key. |
| `notWhileEditing` | As above, except that when focus is in a text field (an `input` other than a button, checkbox or radio; a `textarea`; a `select`; or a contenteditable element) the frame does nothing and T3 handles the key. |
| `passive` | In a bubble-phase `keydown` listener on `window`: post `tl-key` only when `event.defaultPrevented` is false. Never `preventDefault()`. |

Today's list, with app shortcuts on (the defaults in
`frontend-v2/src/keybindings/bindings.logic.ts`, plus two keys the lobby
handles outside that table):

| Chord | Lobby command |
|---|---|
| Ctrl+Shift+K | command palette |
| Alt+1 … Alt+9, Alt+0 | jump to session 1 … 10 |
| Alt+Shift+[ and Alt+Shift+] | previous / next session |
| Alt+Shift+Enter, Alt+Shift+U | next awaiting / next unseen session |
| Alt+Shift+S, N, W, R, F | sidebar, new session, kill, rename, find |
| Alt+/ | shortcuts help |
| Ctrl+Z, Cmd+Z, Ctrl+Shift+Z, Cmd+Shift+Z | undo / redo (`notWhileEditing`) |
| Alt+Shift+Backspace | kill the session (always on, even with app shortcuts off) |
| Ctrl+J, Cmd+J | the scratch-shell dock |
| Escape | closes a lobby overlay (`passive`) |

The frame does not hard-code this list. It uses whatever the latest
`tl-bindings` says, which follows the person's overrides and the "App
shortcuts" switch.

The lobby drops a `tl-key` that matches no chord in the latest list it sent,
and replays the rest by dispatching a synthetic, bubbling, cancelable
`keydown` on the iframe element, so its own keybinding engine and window
listeners treat it as a key pressed on the session pane, and evaluate their
own conditions (an open overlay, an unsaved file draft) as they would for a
real key.

```mermaid
sequenceDiagram
  participant L as Lobby (T3Host)
  participant F as T3 frame (embed patch)
  L->>F: load {origin}/{env}/{thread}?embed
  F->>L: tl-ready {environmentId, threadId}
  L->>F: tl-bindings {chords}
  opt frame not on the session's thread
    L->>F: tl-open {threadId}
  end
  Note over F: T3's palette opens another thread
  F->>L: tl-route {threadId, session}
  alt session is another of the caller's own
    Note over L: selects it, in the T3 view
  else no such session
    L->>F: tl-open {own threadId}
  end
  Note over F: Alt+1 pressed in T3's composer
  F->>L: tl-key {key "1", code "Digit1", altKey true}
  Note over L: replayed as a keydown on the iframe;<br/>the lobby jumps to session 1
```

## What the embed mode hides

From the design (decisions 9 and 24): T3's sidebar and its header, the
terminal drawer toggle, and the git and preview panels. The lobby's own
session bar stays above the frame and carries the title, the view switcher and
the session's menu.

## Open questions

- The iOS soft keyboard inside a cross-origin iframe has not been tested yet,
  and neither has touch input generally; the phone check so far used a resized
  desktop Chromium. The live check on `homelab ios` and the shared Android
  emulator settles it.
- Focus handover: when the person picks a session that is already showing in
  T3, the lobby does not yet move keyboard focus into the frame.
- Without `moveBefore` (Firefox, Safari, and every phone and tablet, where
  the lobby does not preload), following a `tl-route` mounts a new frame for
  the other session, which loads the T3 client again.
- Theme: the frame follows its own theme setting. Passing the lobby's light or
  dark choice is not part of version 1.

## Auth inside the frame

The frame is a browser on the sidecar's own origin, so it takes the
sidecar's browser path (README.md "Inbound auth"): Traefik's forward-auth and
the proxy secret, with no pairing. Since ADR-0045 the T3 view is for every
lobby user, not only admins. Two answers changed for paired apps and are
harmless to the frame:

- `GET /.well-known/t3/environment` answers without a credential, so the
  patch's same-origin read of it works as before and needs nothing new.
- `/api/auth/session` names the method, and for the frame that stays
  `browser-session-cookie`. A `/pair#token=...` link opened in a signed-in
  browser makes the client post `/api/auth/browser-session`, which the
  sidecar answers with the same success without spending the code.
