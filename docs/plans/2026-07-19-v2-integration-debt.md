# terminal-lobby v2 — integration-debt ledger

Decision (Viktor, 2026-07-19): fan out feature parity in waves, **integrate at the
end**. This ledger tracks every deferred cross-component / runtime-wiring item so
the final integration wave closes ALL of them. Each parity wave appends its
blockers here. Repo-canonical (not published).

## Open integration debt

### Terminal bridge (SPA ↔ ttyd iframe)
- [ ] Iframe receiver for `{type:'tl-input',bytes}` → `sendInput()` + `mirrorLineReset()` (soft-keys/compose bytes don't reach the pty yet). *(wave 5)*
- [ ] Iframe receiver for `{type:'tl-refit'}` → `refit()`. *(wave 5)*
- [ ] `tl-command` `terminal.copy` / `terminal.paste` / `gallery.open` handlers on the terminal page. *(wave 4/5)*
- [ ] Terminal-mode currently loads the **vanilla** `index.html`; decide v2 terminal page vs teaching the vanilla page the v2 messages. *(wave 3/5)*
- [ ] Double-toolbar: SPA `#soft-keys` + vanilla iframe toolbar both show on coarse pointers → gate SPA toolbar to text-mode or suppress native. *(wave 5)*

### Runtime wiring
- [ ] `session-events` must be RUNNING + deployed for `/events`,`/prompt`,`/cancel`,`/permission` (endpoints exist; not wired live). *(wave 2/5)*
- [ ] Prove the vertical slice in a real browser: frontend-v2 ↔ running session-events ↔ real tmux, text + terminal. *(waves 2–5)*
- [ ] Vite dev-proxy → real ingress-equivalent routing in the built/deployed artifact. *(wave 2)*
- [ ] **BUG — API path prefix:** `lobby-api.ts`/`config.ts` call `/api/*` (works only under the v2 dev-proxy); the PROD ingress is `PathPrefix /api/sessions/` (strip). Move lobby-api + config + vite-proxy to `/api/sessions/*`. Push/SW paths are already correct (`/api/sessions/push*`, verbatim sw.js) — do NOT move those. *(wave 6, mem #10069)*

### Cross-subsystem deps
- [ ] recents-first (command palette, Alt-jump) needs `tl:session-visits:v1` from the pills/visits subsystem. *(wave 4)*
- [ ] **Seen/visit tracking** (Cat.2: STATES_KEY/VISITS_KEY/stateChangedAt) not ported → tab-title unseen-done count + SessionCard `unseen` are placeholders (`state==='done'`). `title.ts`/`notifications.ts` take an injectable `isUnseen` — swap the real predicate in both when it lands. *(wave 6)*
- [ ] `relandLastActive` boot reattach (inventory #304) not ported (needs `LAST_ACTIVE_KEY` per-device). iOS killed-PWA stash-consume (#303) + SW `tl-activate-session` (#302) ARE wired. *(wave 6)*
- [ ] `keyRepeat` hold-to-repeat needs a roamed pref + master kill when the mobile settings surface lands. *(wave 5)*
- [ ] Ctrl/Cmd+J dropped the vanilla scratch-shell dock (v2 uses it for the view toggle) — revisit with the dock pillar. *(wave 4)*

### Deferred (need dedicated passes)
- [ ] Gestures: pinch-to-font + session-swipe — red-line-adjacent, need real-device CDP probing per BATTERY.md. *(wave 5)*
- [ ] Ctrl+J scratch-shell dock (inventory Cat.8: dock/orphan-reclaim/resize-gutter) — NOT built; Ctrl+J is the v2 view-toggle → needs a keybinding-conflict decision first. *(wave 7)*
- [ ] Gallery mobile: thumbnail long-press menu (Open/Insert-path/Download) + lightbox swipe-dismiss / horizontal swipe-nav (N/M chip shows, arrows/swipe not wired). *(wave 7)*
- [ ] Unify `terminal.paste` into the SPA (programmatic `navigator.clipboard.read` + iOS transient-activation) — today it forwards to the ttyd page's routine. *(wave 7)*

## Rule for the final integration wave
Nothing is "done" until: the vertical slice runs end-to-end in a browser against a
real backend, every box above is closed, and the golden-master + BATTERY parity
gate passes — THEN the gated canary → soak → live cutover (needs Viktor; touches bob).
