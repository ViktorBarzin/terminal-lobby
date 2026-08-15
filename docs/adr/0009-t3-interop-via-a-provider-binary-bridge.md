# T3 interop goes through a provider binary, not a fork

We want a session to be operable from both the lobby and T3 Code. T3 is external
software that auto-upgrades, so the integration had to use a seam T3 already
advertises. We chose the one it documents for users: a provider instance whose
`binaryPath` points at **our** binary instead of `claude`. That binary — the bridge —
speaks the Agent SDK's stdio protocol upward and attaches to a tmux session downward,
so a thread and a session are one Claude process seen through two windows.

The alternative shapes were a fork of T3 (rejected: every nightly becomes a rebase),
and a catalogue that mirrors listings while each side keeps its own runtime (rejected:
T3 can't be taught to drive tmux, so "manageable from either surface" would only ever
have worked in one direction). Resuming a lobby session as a separate T3-owned process
was ruled out on memory: earlyoom fired 34 times in one day on this box, and each
Claude is 0.4–0.8 GB across three users.

## Consequences

- We own a subset of a protocol we don't control, under software that upgrades
  nightly. The stock `claudeAgent` instance stays configured as a one-switch escape
  hatch, and the syncer self-tests the handshake rather than degrading quietly.
- Because `t3-serve@%i` runs `User=%i`, the bridge runs as the session's own owner
  with no sudo and no user-map — the identity boundary is the uid. Cross-user sharing
  therefore has to be a deliberate later design, not an emergent behaviour.
- Only a process T3 spawns can put content into a thread, which is why adoption needs
  a sentinel turn and why live mirroring depends on the bridge staying unreaped.

Design and the full decision set: `docs/plans/2026-08-15-t3-code-bridge-design.md`.
