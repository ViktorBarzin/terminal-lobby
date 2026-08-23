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
	// Emitted when a create input OPENS. Paired with session.created it gives
	// the window a speculative pre-warm has to cover Claude's ~2.4s boot in.
	"session.create_opened": true,
	"session.created":       true,
	"session.selected":      true, // a row was activated in the sidebar
	"session.attached":      true, // the terminal actually mounted
	"session.detached":      true,
	"session.renamed":       true,
	"session.moved":         true, // between projects / reordered (tl.from, tl.to)
	"session.killed":        true,
	"session.restored":      true, // tmux-persist restore (tl.count)

	// -- skills & plugins (skills-api) --------------------------------------
	"skill.installed":          true, // took a peer's skill (tl.key, tl.from, tl.kind=new|replace)
	"skill.removed":            true, // backed up and dropped one (tl.key)
	"skill.deleted":            true, // permanent: skill + its backups + its state (tl.key)
	"plugin.uninstalled":       true, // marketplace plugin removed and its cache reclaimed (tl.key)
	"plugin.installed":         true, // installed from a source repo (tl.key, tl.from, tl.kind=source)
	"skill.toggled":            true, // enabledPlugins write (tl.key, tl.kind=on|off)
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

	// -- acting as another user (admin) -------------------------------------
	// The audit trail for the act-as switch. user.id is always the REAL caller
	// and tl.to the target, so "who was in emo's account, and when" is
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
