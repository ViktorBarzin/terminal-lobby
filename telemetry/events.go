package telemetry

// The event catalog — a CLOSED vocabulary, by design.
//
// Every event the lobby can emit is listed here, and Emit drops anything else.
// Two reasons: a typo at a call site would otherwise create a series nobody
// ever queries, and the browser intake (tmux-api POST /telemetry) accepts event
// names from the client — an open vocabulary there would let a tab write
// arbitrary records into the shared journal.
//
// Adding an event = add it here, in the same commit as the call site, and to
// the catalog table in docs/adr/0006-usage-telemetry.md.
//
// Attribute conventions: tl.session, tl.project, tl.from, tl.to, tl.key,
// tl.kind, tl.count, tl.ms, tl.reason, tl.client, tl.device. NEVER conversation
// content, prompt text, file contents or keystrokes — an event says WHICH
// feature ran, not what was typed into it.
//
// tl.device is a random per-installation id the browser mints and keeps in
// localStorage (frontend-v2/src/telemetry/device.ts); the service worker reads
// the same id from IndexedDB db 'tl-device', store 'meta', key 'id', because a
// worker cannot reach localStorage. It names a BROWSER INSTALLATION and nothing
// about the person: the user is already attributed server-side, and without a
// device dimension one person's phone and laptop are one indistinguishable
// series — which is why a stash written on the phone could not be joined to the
// read that consumed it.
var knownEvents = map[string]bool{
	// -- app lifecycle (browser) --------------------------------------------
	"app.loaded":        true, // a lobby tab booted (tl.client, tl.build)
	"app.reloaded":      true, // a self-update landed (tl.reason, tl.from, tl.to)
	"app.update_failed": true, // reloads at one asset id never landed (tl.to, tl.count)
	"app.error":         true, // a surfaced failure (tl.kind); no message text

	// -- session lifecycle --------------------------------------------------
	// Emitted when a create input OPENS. Paired with session.created it gives
	// the window a speculative pre-warm has to cover Claude's ~2.4s boot in.
	"session.create_opened": true,
	"session.created":       true,
	"session.selected":      true, // a row was activated in the sidebar
	"session.attached":      true, // the terminal actually mounted
	// Opening a session's transcript in Text mode: whether this device already
	// held it, how many events it seeded from, and how many the server still had
	// to send. The pair is what says whether the client-side transcript cache is
	// earning its keep in the wild rather than in a test.
	"text.open": true, // tl.cache, tl.cached, tl.fetched
	// Answering a blocking AskUserQuestion from the text view. The failure
	// carries WHERE the sequence stopped and WHY, never what the pane held:
	// a dialog can quote anything the session was working on.
	// tl.reason, tl.step, tl.steps, tl.multi, tl.questions, tl.options,
	// tl.source, tl.expect_len, tl.pane_read
	"text.answer_failed": true,
	"text.answer_sent":   true, // tl.multi, tl.questions, tl.steps
	"session.detached":   true,
	"session.renamed":    true,
	// A title someone chose, replacing whatever the session had. Emitted
	// server-side at POST /sessions/{n}/title, so tl.client says which surface
	// asked. One arriving soon after a session.autonamed is how a rejected
	// auto-title is counted — the event has existed since titles shipped and
	// was missing from this catalog, which meant Emit dropped every one.
	"session.retitled": true,
	// The auto-title rule (tmux-api/autotitle.go) taking Claude Code's own
	// conversation summary as the session's title, or running out of window
	// without one. tl.session, tl.delay_ms since creation, tl.outcome =
	// titled|gave_up.
	"session.autonamed": true,
	"session.moved":     true, // between projects / reordered (tl.from, tl.to)
	"session.killed":    true,
	"session.restored":  true, // tmux-persist restore (tl.count)
	// A session whose grid pin had gone stale, repinned by the sweep in
	// tmux-api/repair_grid_pins.go so the terminal resizes again. Emitted per
	// repaired session, so a run over many users emits many; tl.client says
	// which pass did it. tl.session, tl.client=sweep.
	"session.grid_repinned": true,

	// -- skills & plugins (skills-api) --------------------------------------
	"skill.installed":          true, // took a peer's skill (tl.key, tl.from, tl.kind=new|replace)
	"skill.removed":            true, // backed up and dropped one (tl.key)
	"skill.deleted":            true, // permanent: skill + its backups + its state (tl.key)
	"plugin.uninstalled":       true, // marketplace plugin removed and its cache reclaimed (tl.key)
	"plugin.installed":         true, // installed from a source repo (tl.key, tl.from, tl.kind=source)
	"skill.toggled":            true, // enabledPlugins write (tl.key, tl.kind=on|off)
	"skill.edited":             true, // the editor wrote a skill file (tl.key)
	"plugin.updated":           true, // marketplace plugin updated (tl.key)
	"session.claude_restarted": true, // respawned a pane to load a new skill set (tl.session)

	// -- projects & layout --------------------------------------------------
	"project.created":        true,
	"project.renamed":        true,
	"project.deleted":        true,
	"project.dir_changed":    true,
	"project.member_added":   true,
	"project.member_removed": true,
	"project.mode_changed":   true, // blanket attach mode ro/rw (tl.kind)
	"project.coown_changed":  true,
	"layout.reordered":       true, // projects or Ungrouped slot moved
	"layout.group_toggled":   true, // collapse/expand (tl.kind)
	"sidebar.toggled":        true,

	// -- sharing ------------------------------------------------------------
	"share.granted": true, // (tl.kind = ro|rw)
	"share.revoked": true,
	// The other side of a share: which way a member chose to JOIN a session
	// they can reach, read-only or read-write (tl.to = ro|rw, tl.session).
	// tl.as is set when the joiner is acting as another user, which makes
	// "an admin chose to type in someone else's session" one query rather
	// than a join against the attach line. Browser-emitted (v2 lobby).
	"watch.switched": true,

	// -- acting as another user (admin) -------------------------------------
	// The audit trail for the act-as switch. user.id is always the REAL caller
	// and tl.to the target, so "who was in bob's account, and when" is
	// answerable. Server-emitted at /whoami (once per tab) and at attach (once
	// per session), with tl.client naming which; the SPA emits the same name
	// when the switch is asked for, and .exit when it is left.
	"admin.actas":         true, // (tl.to = target, tl.client = whoami|attach)
	"admin.actas.exit":    true, // (client only) back to your own lobby
	"admin.actas.refused": true, // (tl.to = target, tl.kind = reason) a denial

	// -- navigation & keyboard ---------------------------------------------
	"palette.opened": true,
	"palette.action": true, // ANY command dispatch: palette pick, chord, forwarded shortcut
	"help.opened":    true,
	"view.switched":  true, // text-mode <-> terminal (tl.to)

	// -- images, clipboard, transfers --------------------------------------
	"gallery.opened":       true,
	"gallery.image_opened": true,
	"image.pasted":         true, // (tl.count, tl.ms)
	"image.uploaded":       true,
	"image.dropped":        true,
	"image.shown":          true, // show-image / sixel render
	"file.transferred":     true, // non-image drop
	"file.attached":        true, // a file kept beside a session (tl.session, tl.count = bytes, tl.client)

	// -- file preview & quick edit -----------------------------------------
	"file.previewed":   true, // (tl.kind = md|html|svg|code|text)
	"file.edit_opened": true,
	"file.saved":       true,

	// -- terminal surface ---------------------------------------------------
	"terminal.copied": true,
	"terminal.pasted": true,
	// The clipboard read was refused (tl.api = which call, tl.error = the
	// DOMException name, tl.focused, tl.coarse). Recorded because the refusal
	// is a property of the USER's browser and does not reproduce in the
	// headless Chromium the QA rig drives. Never the error MESSAGE, which can
	// quote clipboard content.
	"terminal.paste_failed": true,
	"terminal.softkey":      true, // mobile soft-key toolbar (tl.key)
	"terminal.gesture":      true, // pinch / long-press / swipe (tl.kind)

	// -- settings -----------------------------------------------------------
	"settings.opened": true,
	// tl.key is the DOTTED PATH of the single field that changed
	// ("fontSize", "session.newCommand", "notify.onAwaiting") and tl.to is its
	// new scalar value — one event per changed leaf, none when a write is a
	// no-op. Never the namespace with the sub-key NAME as the value: that shape
	// made "which value did it move to" unanswerable.
	"prefs.changed": true,
	"theme.changed": true, // (tl.to)

	// -- notifications ------------------------------------------------------
	"notify.opt_in":            true,
	"notify.push_subscribed":   true,
	"notify.push_unsubscribed": true,
	"notify.shown":             true,
	"notify.clicked":           true,
	// The iOS cold-launch chain, which has no instrument on this network and had
	// no trace either. A killed PWA fires no notificationclick, so the tapped
	// session travels only through the record sw.js writes at push time — and
	// every step of that was silent, so four fixes in a row were guesses. These
	// two make it answerable from the journal after the fact.
	"notify.stash_written": true, // sw.js wrote, or failed to write, the tap record (tl.kind=ok|fail)
	"notify.stash_read":    true, // boot read it, and what it decided (tl.reason)
	// The tap itself, as the SERVICE WORKER saw it. notificationclick emitted
	// nothing at all, so the one question the whole bug turns on — did the
	// handler run, and which arm did it take — was answerable only from a
	// WebKit bug thread. tl.kind is that arm: acked (a lobby answered the
	// switch message), posted (every lobby was posted to and none answered),
	// opened (no lobby was open, so openWindow was called), focused (a
	// session-less test tap: foreground only), failed (the chosen arm could not
	// be carried out). tl.session, tl.count = window clients seen.
	"notify.tap": true,
	// Whether the app-icon count could actually be DRAWN. iOS may not expose the
	// Badging API inside a service worker at all, in which case the badge can
	// never be painted while the app is shut — which is the one case it exists
	// for. Reported rather than guessed at (tl.kind=ok|unsupported|failed,
	// tl.count).
	"notify.badge_set": true,

	// -- the Claude conversation (session-events) --------------------------
	"claude.prompt_sent":   true,
	"claude.cancelled":     true,
	"claude.answered":      true, // a blocking prompt answered: keys (tl.client=api) or text (api-text); tl.count is the answer's SIZE, never its text
	"claude.state_changed": true, // running/awaiting/done transition (tl.to)
	"events.stream_opened": true, // SSE attach (tl.bytes, tl.count = the opening backfill)
	"events.stream_closed": true,
	// Text-view load, from the reverse-open design (2026-08-28).
	"text.first_paint": true, // stream open -> first row on screen (tl.ms, tl.count)
	"text.window_grew": true, // a step back through history (tl.bytes, tl.count, tl.reason)

	// -- server-side health -------------------------------------------------
	"api.error":    true, // an unexpected server failure (tl.kind)
	"api.rejected": true, // a request refused: bad input, rate cap (tl.kind)
}

// IsKnown reports whether name is in the catalog.
func IsKnown(name string) bool { return knownEvents[name] }

// KnownEvents lists the catalog, for the intake handler's error message and
// for tests that assert docs and code agree.
func KnownEvents() []string {
	out := make([]string, 0, len(knownEvents))
	for k := range knownEvents {
		out = append(out, k)
	}
	return out
}
