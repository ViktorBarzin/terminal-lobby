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
// tl.kind, tl.count, tl.ms, tl.reason, tl.client, tl.device, and tl.caller,
// which the emitter adds itself (SetCallerRule). NEVER conversation
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
	"session.reopened":      true, // the installed app relaunched onto its last session; tl.reason acted | gone
	"session.attached":      true, // the terminal actually mounted
	// Opening a session's transcript in Text mode: whether this device already
	// held it, how many events it seeded from, and how many the server still had
	// to send. The pair is what says whether the client-side transcript cache is
	// earning its keep in the wild rather than in a test.
	"text.open": true, // tl.cache, tl.cached, tl.fetched
	// A picture in the Text view opened full size (2026-09-24): tl.kind is
	// file | block (a file on disk, or a block the transcript carries) and
	// tl.source is bubble | prose | tool. Never the path, the name or the
	// bytes: those are conversation content (ADR-0008).
	"text.picture_opened": true,
	// Answering a blocking AskUserQuestion from the text view. The failure
	// carries WHERE the sequence stopped and WHY, never what the pane held:
	// a dialog can quote anything the session was working on.
	// tl.reason, tl.step, tl.steps, tl.multi, tl.questions, tl.options,
	// tl.source, tl.expect_len, tl.pane_read, and tl.action on the server's:
	// choose | toggle | commit | back | submit | keys. A multi-select answer
	// is several toggles and one commit, so these count requests; one answer
	// is one claude.answered, sent at the commit.
	//
	// Since 2026-09-24 the same two names carry the plan approval, tl.action
	// plan-approve | plan-feedback with no tl.questions or tl.multi (and
	// since 2026-09-27 permission-decline, the permission prompt declined
	// with words, and since 2026-09-28 permission-pick, a row of it picked
	// by its number), and the mode dial, tl.client api-mode and tl.action mode
	// with tl.from, tl.to and tl.count (the Shift+Tab presses). A query over answers reads tl.client
	// api-answer; the mode dial answers no prompt and sends no claude.answered.
	"text.answer_failed": true,
	"text.answer_sent":   true, // tl.multi, tl.questions, tl.steps, tl.action
	// A question the PermissionRequest hook held for the card (ADR-0034):
	// tl.outcome is held when it begins, then answered, terminal, hung-up,
	// replaced, gone, expired or already; tl.questions and tl.held_ms.
	// Retired with the hook on 2026-10-02 (ADR-0036); kept so the series
	// stays queryable.
	"question.hold": true,
	// A Claude's mod said hello to session-events (ADR-0036): tl.version is
	// the CLI's, tl.mod the mod's, tl.history whether its log was rebuilt.
	"mod.hello": true,
	// session-events restarted a Claude that predates the mod, on the same
	// conversation, once it was safe to (ADR-0036).
	"mod.rollout_restart": true,
	// A command the mod acked and then could not carry out: a prompt dropped or
	// rejected after its first ack, or a slash command that failed. tl.kind is
	// the op (ADR-0036 wire v3).
	"mod.command_failed": true,
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
	// titled|gave_up|titled_late. titled_late is a summary adopted after the
	// window, which can follow a gave_up for the same session.
	"session.autonamed": true,
	"session.moved":     true, // between projects / reordered (tl.from, tl.to)
	"session.killed":    true,
	"session.restored":  true, // tmux-persist restore (tl.count)
	// A session whose grid pin had gone stale, repinned by the sweep in
	// tmux-api/repair_grid_pins.go so the terminal resizes again. Emitted per
	// repaired session, so a run over many users emits many; tl.client says
	// which pass did it. tl.session, tl.client=sweep.
	"session.grid_repinned": true,
	// A pinned session's window pointed at the client reading it, because no
	// tmux hook can notice a lobby switching back to a session it kept mounted
	// (tmux-api/grid_size.go). Emitted only when something actually moved, so an
	// unpinned session — the majority — is silent. tl.session, tl.kind = the
	// grid asked for, tl.client.
	"session.grid_sized": true,
	// A session nobody has driven for days, suspended by tmux-api's sweep:
	// its claude killed, its tmux session and frozen pane kept, the
	// conversation one click from coming back (tmux-api/suspend.go). Automatic
	// only — there is no manual suspend. tl.session, tl.idleSeconds since the
	// last drive, tl.rssBytes reclaimed across the whole process tree.
	"session.suspended": true,
	// …and the click that brought it back. tl.session, tl.suspendedSeconds it
	// spent suspended, tl.resumeMs for the respawn call itself — Claude's own
	// boot happens after the pane exists and is the client's to measure.
	"session.resumed": true,
	// A person's Restart from the session menu: the same stop and resume, on
	// demand, so the session's Claude loads a new binary or new settings on
	// the same conversation (tmux-api/restart.go). tl.session, tl.from (the
	// state it was in), tl.restartMs for stop plus respawn, tl.client.
	"session.restarted": true,

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
	"agents.rail_toggled":    true, // the text view's agent margin folded/opened (tl.to)
	"agents.steer_sent":      true, // a message to an open agent: tl.result sent|unconfirmed|gone|finished|not-addressable|refused
	"agents.panel_held":      true, // running work the panel keeps hidden: tl.runs, tl.agents, tl.turn, tl.owed, tl.quiet_ms

	// -- workspaces ---------------------------------------------------------
	// A workspace document written (PUT /workspaces), which is what every
	// structural change to a Workspace ends in: a tile added, a tile closed, or
	// a session dragged from one workspace into another. tl.count is how many
	// workspaces the user holds afterwards, tl.tiles how many sessions are in
	// them and tl.max how many the largest one holds.
	//
	// The SHAPE is still absent and cannot be added: the split tree is
	// per-device and never reaches the server (ADR-0027), so this says how many
	// tiles a workspace has and nothing about the rows and columns they were
	// put in. A WRITE is also not a sighting — a workspace made once and used
	// all week emits here once — which is why tmux-api/metrics_endpoint.go
	// carries tl_workspaces and tl_workspace_tiles as gauges beside it.
	"workspace.arranged": true, // tl.count, tl.tiles, tl.max, tl.client

	// -- sharing ------------------------------------------------------------
	"share.granted": true, // (tl.kind = ro|rw)
	"share.revoked": true,
	// Public links (tmux-api/links.go, ADR-0039): a bearer URL to one session
	// for someone with no account. Emitted under the OWNER, since a visitor has
	// no identity. created carries tl.mode and the lifetime in tl.kind;
	// revoked's tl.kind says one link or a whole session (the Stop button);
	// visit is one attach through a link, tl.mode ro|rw.
	"link.created": true,
	"link.revoked": true,
	"link.visit":   true,
	// The other side of a share: which way a member chose to JOIN a session
	// they can reach, read-only or read-write (tl.to = ro|rw, tl.session).
	// tl.as is set when the joiner is acting as another user, which makes
	// "an admin chose to type in someone else's session" one query rather
	// than a join against the attach line. Browser-emitted (v2 lobby).
	"watch.switched": true,

	// -- acting as another user (admin) -------------------------------------
	// The audit trail for the act-as switch. user.id is always the REAL caller
	// and tl.to the target, so "who was in bob's account, and when" is
	// answerable. Server-emitted at /whoami (once per tab), at attach (once
	// per session) and by session-events when a text view opens or writes
	// (tl.session), with tl.client naming which; the SPA emits the same name
	// when the switch is asked for, and .exit when it is left.
	"admin.actas":         true, // (tl.to = target, tl.client = whoami|attach|text)
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

	// -- the session browser, as the lobby sees it -------------------------
	// Browser-emitted (v2 lobby, docs/plans/2026-10-01-session-browser-design.md).
	// Never a URL or anything from the page.
	"browser.panel_open":   true, // the Browser panel opened (tl.kind = card|bar, tl.to = text|terminal)
	"browser.take_control": true, // a person took control from the agent
	"browser.hand_back":    true, // ...and handed it back (tl.ms = how long they held it)

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
	"claude.prompt_sent": true,
	// A New-session composer's first prompt, timed from the Send press
	// (docs/plans/2026-10-03-first-prompt-latency-design.md): tl.post_ms to
	// Accepted (the mod's ack), tl.settle_ms to Shown (Claude's record of it),
	// tl.first = true, tl.n = its LENGTH, tl.hidden when the page was hidden
	// since Send. The journey design's (2026-09-12) name and attributes; this
	// arm emits from session-events because the browser rarely sees Shown.
	"prompt.landed": true,
	// The same first prompt timed from Send to Accepted on the BROWSER's clock,
	// which is where the person waits (docs/plans/2026-10-04-warm-slot-at-send-design.md):
	// tl.ms, tl.slot = what the claim and the hold found (warm | booting |
	// stale | none | unknown), tl.hidden. tmux-api counts these into
	// tl_first_prompt_total and tl_first_prompt_slow_total for the alert.
	"prompt.accepted":  true,
	"claude.cancelled": true,
	// Prompts held behind a running turn handed back to the composer
	// (session-events/held.go): tl.count prompts, tl.via = edit (the Text
	// view's Up) or stop. Their text is never recorded.
	"claude.queue_taken":   true,
	"claude.answered":      true, // a blocking prompt answered: keys (tl.client=api) or text (api-text); tl.count is the answer's SIZE, never its text
	"claude.state_changed": true, // running/awaiting/done transition (tl.to)
	// A PERSON set the state by hand, correcting a dot the hooks got wrong
	// (tl.from, tl.to). Its own name rather than claude.state_changed, which
	// is the hook script's: one says what the conversation did, this one says
	// what somebody decided about it, and counting them together would hide
	// how often the dots need correcting at all.
	"claude.state_set":     true,
	"events.stream_opened": true, // SSE attach (tl.bytes, tl.count = the opening backfill)
	"events.stream_closed": true,
	// A Text view asked for a session no mod has said hello for (tl.session,
	// tl.reason = shell | starting | nomod | exited). Only shell is a 404; the
	// rest hold the stream until the mod connects.
	"events.no_stream": true,
	// A held stream for a starting Claude ended (tl.ms, tl.outcome = hello |
	// timeout | left): how long a new Claude takes to reach the lobby.
	"events.starting_ended": true,
	// A Browser panel or card watching a session browser through
	// session-events (docs/plans/2026-10-01-session-browser-design.md):
	// tl.session, tl.mode = control|watch (the attach-mode ceiling, not
	// whether the viewer took control), tl.to = the owner when it is not the
	// caller. Closed carries tl.ms. Never a URL or page content.
	"browser.stream_opened": true,
	"browser.stream_closed": true,
	// Text-view load, from the reverse-open design (2026-08-28).
	"text.first_paint": true, // stream open -> first row on screen (tl.ms, tl.count)
	"text.window_grew": true, // a step back through history (tl.bytes, tl.count, tl.reason)
	// A Text view on screen for two seconds with no rows (CONTEXT.md "Blank"),
	// with the stream's state and what it has received, so a blank names its
	// own cause. blank_ended says how long it lasted and why it ended.
	"text.blank":       true,
	"text.blank_ended": true,
	// A Text view with rows that stopped receiving them: behind the server's
	// heartbeat head (tl.why=behind, tl.gap) or hearing no heartbeat
	// (tl.why=silent). stale_ended: caught-up | left, with tl.ms.
	"text.stale":       true,
	"text.stale_ended": true,

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
