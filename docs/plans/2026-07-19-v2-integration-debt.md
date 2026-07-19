# terminal-lobby v2 — integration-debt ledger

Decision (Viktor, 2026-07-19): fan out feature parity in waves, **integrate at the
end**. This ledger tracks every deferred cross-component / runtime-wiring item so
the final integration wave closes ALL of them. Each parity wave appends its
blockers here. Repo-canonical (not published).

## Open integration debt

### Terminal bridge (SPA ↔ ttyd iframe)
- [x] Iframe receiver for `{type:'tl-input',bytes}` → `mirrorLineReset()` + `sendInput()`. **DONE 2026-07-19** (`frontend/term.html` terminal-mode message handler; parent-scoped, origin-validated).
- [x] Iframe receiver for `{type:'tl-refit'}` → `refit()`. **DONE 2026-07-19** (`frontend/term.html`).
- [x] `tl-command` `terminal.copy` / `terminal.paste` / `gallery.open` handlers on the terminal page. **DONE 2026-07-19** — `terminal.copy` added (extracted `runTerminalCopy()` shared with the mobile Copy button); paste/gallery were already handled.
- [x] Terminal-mode currently loads the **vanilla** `index.html`; decide v2 terminal page vs teaching the vanilla page the v2 messages. **DECIDED + DONE 2026-07-19** — new `frontend/term.html` = the vanilla terminal path (copy of `index.html`; loaded with `?arg=` it runs the same proven ttyd/tmux branch, lobby branch dormant, no SW registered) + the tl-input/tl-refit/terminal.copy receivers. The SPA points its iframe at `/term.html` (config `TERMINAL_BASE`, default `/term.html`) so the iframe never recursively loads the SPA. Vite build emits `dist/term.html` as a separate asset (like `sw.js`).
- [ ] Double-toolbar: SPA `#soft-keys` + vanilla iframe toolbar both show on coarse pointers → gate SPA toolbar to text-mode or suppress native. *(wave 5)* — **STILL OPEN, now live:** `term.html` is a copy of the vanilla page, so it still builds its own `#soft-keys` on coarse pointers; with the SPA also rendering `SoftKeys`, a phone shows TWO toolbars in terminal mode. Fix options: suppress `#soft-keys` in `term.html` (it's framed → the SPA owns the toolbar), or gate the SPA toolbar. Framing is detectable in term.html (`isFramed`).

### Runtime wiring
- [ ] `session-events` must be RUNNING + deployed for `/events`,`/prompt`,`/cancel`,`/permission` (endpoints exist; not wired live). *(wave 2/5)*
- [ ] Prove the vertical slice in a real browser: frontend-v2 ↔ running session-events ↔ real tmux, text + terminal. *(waves 2–5)* — code is now wired end-to-end; a local `vite preview` harness recipe exists (see the integration commit) for the browser gate. Still needs the actual browser run.
- [~] Vite dev-proxy → real ingress-equivalent routing in the built/deployed artifact. *(wave 2)* — **dev/preview proxy DONE 2026-07-19:** `/api/sessions/*` strip → tmux-api, plus `/ws` + `/token` → ttyd and `/fonts` → clipboard-upload so `vite preview` is a complete same-origin harness (SPA at `/`, `term.html` at `/term.html`, live terminal). The **deployed** artifact routing (serving `dist/index.html` at `/` and `dist/term.html` at `/term.html` behind the ingress) is the cutover deploy's job — see the new "term.html serving" blocker below.
- [x] **BUG — API path prefix:** `lobby-api.ts`/`config.ts` call `/api/*` (works only under the v2 dev-proxy); the PROD ingress is `PathPrefix /api/sessions/` (strip). **FIXED 2026-07-19** — `config.ts` `TMUX_API_PREFIX = "/api/sessions"` (all `apiUrl` callers: lobby-api, prefs move with it), vite proxy strips `/api/sessions`. Push/SW paths left verbatim (`/api/sessions/push*` in `pwa/push.ts`, `sw.js`). `/events`,`/prompt`,`/cancel`,`/permission` (session-events root) + `/clipboard` + `/files` unchanged. Locked by `test/config.test.ts`. *(mem #10069)*

- [ ] **term.html SERVING at deploy (cutover, NOT done here):** the build now emits
  `frontend-v2/dist/term.html`, but the current deploy serves the vanilla
  `frontend/index.html` at `/` via ttyd `-I` (one file only). The frontend-v2
  cutover deploy must serve `dist/index.html` at `/` AND `dist/term.html` at
  `/term.html` same-origin. Options: (a) add `term.html` to clipboard-upload's
  static whitelist (like `sw.js`) + an ingress carve-out for `/term.html`, or
  (b) a static file server for `dist/`. ttyd `-I` can't serve a second path.
  `/ws`,`/token` stay on ttyd; `/api/sessions`,`/clipboard`,`/files`,`/events`…
  unchanged. This is deploy wiring — deferred with the canary→cutover. *(cutover)*
- [ ] **term.html ↔ index.html drift:** `term.html` is a COPY of the vanilla
  terminal path. Until the SPA fully replaces the vanilla lobby, a terminal-branch
  fix in `frontend/index.html` must be mirrored into `term.html` (and vice-versa).
  End-state: `term.html` becomes the canonical terminal page and `index.html`
  retires. *(cutover, maintenance)*

### Cross-subsystem deps
- [ ] recents-first (command palette, Alt-jump) needs `tl:session-visits:v1` from the pills/visits subsystem. *(wave 4)*
- [ ] **Seen/visit tracking** (Cat.2: STATES_KEY/VISITS_KEY/stateChangedAt) not ported → tab-title unseen-done count + SessionCard `unseen` are placeholders (`state==='done'`). `title.ts`/`notifications.ts` take an injectable `isUnseen` — swap the real predicate in both when it lands. *(wave 6)*
- [ ] `relandLastActive` boot reattach (inventory #304) not ported (needs `LAST_ACTIVE_KEY` per-device). iOS killed-PWA stash-consume (#303) + SW `tl-activate-session` (#302) ARE wired. *(wave 6)*
- [ ] `keyRepeat` hold-to-repeat needs a roamed pref + master kill when the mobile settings surface lands. *(wave 5)*
- [ ] Ctrl/Cmd+J dropped the vanilla scratch-shell dock (v2 uses it for the view toggle) — revisit with the dock pillar. *(wave 4)*

### File preview (pillar #6) — wave 8 (PREVIEW surface built; editor deferred)
- [ ] **file-api ROUTE PREFIX — ingress must route `/files/*` VERBATIM (no strip)** to
  file-api (`:7686`), + Authentik auth injecting `X-Authentik-Username`. file-api's own
  routes already carry the prefix (`/files/list`,`/files/read`,`/files/write` — see
  `file-api/main.go`), so this mirrors **session-events' root-path mapping, NOT
  tmux-api's `/api`-strip / clipboard's `/clipboard`-strip.** Frontend uses
  `FILE_API_PREFIX="/files"` (config.ts) and the dev proxy forwards verbatim
  (`TL_FILE_API`, no rewrite). *Do NOT strip `/files`.* *(wave 6/integration)*
- [ ] **file-api must be RUNNING + deployed** (systemd sibling of tmux-api /
  clipboard-upload / session-events; sudo-as-mapped-OS-user wiring at deploy) for the
  preview surface to work live. Endpoints exist + tested on master; not wired live. *(wave 6/integration)*
- [ ] **PENDING DECISION — editor engine (Monaco vs CodeMirror).** This wave is
  **PREVIEW-ONLY** (read-only). Monaco is deferred because it **breaks the single-file
  build**: its worker/AMD loader + bulk don't fit `viteSingleFile`'s one-file /
  no-sidecar / no-store constraint. Likely pick: **CodeMirror 6** (ESM, tree-shakeable,
  inlineable). When the editor lands, reuse `POST /files/write` (already on master) +
  the file-preview store. Preview's read-only highlight uses **highlight.js** (core + 20
  curated langs, lazy dynamic import folded into the single file, +~36 KB gzip / +3.5%). *(next wave)*
- [ ] Transcript path chips render only on **visible** tool rows; folded (settled-turn)
  Read/Edit/Write rows hide the chip until the fold is expanded — the recent-files strip
  covers those. Fine as-is; note if a "preview from folded row" ask appears. *(minor)*
- [ ] Browse (`GET /files/list`) needs a loaded file to seed its parent dir; **idle
  browse has no home root** (file-api `/list` requires an absolute dir). Seed from a
  `/whoami`-style home or a default dir when that surface lands. *(wave 6, minor)*

### Deferred (need dedicated passes)
- [ ] Gestures: pinch-to-font + session-swipe — red-line-adjacent, need real-device CDP probing per BATTERY.md. *(wave 5)*
- [ ] Ctrl+J scratch-shell dock (inventory Cat.8: dock/orphan-reclaim/resize-gutter) — NOT built; Ctrl+J is the v2 view-toggle → needs a keybinding-conflict decision first. *(wave 7)*
- [ ] Gallery mobile: thumbnail long-press menu (Open/Insert-path/Download) + lightbox swipe-dismiss / horizontal swipe-nav (N/M chip shows, arrows/swipe not wired). *(wave 7)*
- [ ] Unify `terminal.paste` into the SPA (programmatic `navigator.clipboard.read` + iOS transient-activation) — today it forwards to the ttyd page's routine. *(wave 7)*

## Rule for the final integration wave
Nothing is "done" until: the vertical slice runs end-to-end in a browser against a
real backend, every box above is closed, and the golden-master + BATTERY parity
gate passes — THEN the gated canary → soak → live cutover (needs Viktor; touches emo).
