// Package sessionio is the shared read/write side of a Claude session: the tmux
// server that runs it, the transcript it writes, and the durable bindings that
// tie the two together.
//
// It exists because three binaries need the same answers about the same
// session. session-events serves them to the lobby's Text view; the T3 bridge
// (tl-t3-bridge) serves them to a T3 thread; the syncer (tl-t3-sync) reconciles
// the two lists. Every one of them has to paste a prompt the same way, read
// @claude_state the same way, and decide "this turn is over" the same way — so
// the rules live here once, with the measurements that produced them
// (docs/plans/2026-08-15-t3-code-bridge-design.md).
//
// The four seams, in the order a caller usually reaches for them:
//
//   - Injector — run tmux as a given OS user: paste a prompt, interrupt, read
//     and write session options, create/kill/list sessions.
//   - SessionMap + TranscriptPath/WithinProjects — resolve a tmux session name
//     to the transcript its Claude is writing, via the @claude_transcript stamp.
//   - Tail + Record — read that transcript incrementally as typed records.
//   - Normalizer + FileSource — fold records into the lobby's Event stream, with
//     the turn/settle model the renderer depends on.
//
// Index is the fifth, and the odd one out: a durable uuid → tmux-name binding
// that outlives the tmux session, which is what makes a dead session
// resurrectable. See index.go for why it lives here.
package sessionio
