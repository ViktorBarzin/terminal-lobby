// Package sessionio is the shared read/write side of a Claude session: the tmux
// server that runs it, the transcript it writes, and the durable bindings that
// tie the two together.
//
// It exists because several binaries need the same answers about the same
// session. session-events serves them to the lobby's Text view, agent-api
// creates and drives sessions for external callers, spendstore reads what a
// conversation cost. Every one of them has to paste a prompt the same way,
// read @claude_state the same way, and decide "this turn is over" the same
// way, so the rules live here once, with the measurements that produced them.
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
// A fifth seam used to live here: Index, a durable uuid → tmux-name binding
// that outlived the tmux session. It belonged to the T3 bridge and went with
// it (ADR-0029). Everything this package stores now dies with the session it
// describes, which is what keeps a reused name from serving a dead
// conversation.
package sessionio
