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
// tl.kind, tl.count, tl.ms, tl.reason, tl.client. NEVER conversation content,
// prompt text, file contents or keystrokes — an event says WHICH feature ran,
// not what was typed into it.
var knownEvents = map[string]bool{
	// -- app lifecycle (browser) --------------------------------------------
	"app.loaded":        true, // a lobby tab booted (tl.client, tl.build)
	"app.reloaded":      true, // a self-update landed (tl.reason, tl.from, tl.to)
	"app.update_failed": true, // reloads at one asset id never landed (tl.to, tl.count)
	"app.error":         true, // a surfaced failure (tl.kind); no message text

	// -- session lifecycle --------------------------------------------------
	"session.created":  true,
	"session.selected": true, // a row was activated in the sidebar
	"session.attached": true, // the terminal actually mounted
	"session.detached": true,
	"session.renamed":  true,
	"session.moved":    true, // between projects / reordered (tl.from, tl.to)
	"session.killed":   true,
	"session.restored": true, // tmux-persist restore (tl.count)

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

	// -- file preview & quick edit -----------------------------------------
	"file.previewed":   true, // (tl.kind = md|html|svg|code|text)
	"file.edit_opened": true,
	"file.saved":       true,

	// -- terminal surface ---------------------------------------------------
	"terminal.copied":  true,
	"terminal.pasted":  true,
	"terminal.softkey": true, // mobile soft-key toolbar (tl.key)
	"terminal.gesture": true, // pinch / long-press / swipe (tl.kind)

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

	// -- the Claude conversation (session-events) --------------------------
	"claude.prompt_sent":   true,
	"claude.cancelled":     true,
	"claude.state_changed": true, // running/awaiting/done transition (tl.to)
	"events.stream_opened": true, // SSE attach
	"events.stream_closed": true,

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
