# Skills move between users by copy, from their own Skills panel

Every lobby user has a set of skills their Claude sessions load from
`~/.claude/skills`. Until now a skill reached a second person only through the
hourly provisioner (`infra/scripts/t3-provision-users.sh` → `install_skills()`),
which copied a vendored snapshot into an allowlisted user's home if the
directory was absent. That got a starter set onto the box, and it does two
things we now want differently: a skill never updates after its first copy, and
nobody chooses their own set.

We add a **Skills overlay to the lobby**, its own dialog off the shell bar
beside Settings, backed by a new `skills-api` service on `:7688`. Every mapped user's skills are visible to every
other one; **the recipient installs**, which **copies a snapshot** into
`~/.claude/skills/<name>` and records `{from, sourceHash, installedAt}` in
`.manager.json`. Enable/disable is a direct write of Claude Code's own
`enabledPlugins` key in `~/.claude/settings.json`, so nothing is deleted to turn
a skill off. `install_skills()`, its `SKILL_USERS` allowlist, and the vendored
snapshot are retired.

Visibility grants nothing new: `/home/wizard` is `751` with `.claude/skills` at
`775`, so bob can already read those files, and wizard reads bob's `700` home
through the sudo he already holds. The manager surfaces what OS permissions
already allow.

## Considered options

- **A marketplace repo in Claude Code's native format** — a git repo with
  `.claude-plugin/marketplace.json`, driven by `claude plugin
  install|disable|list --json`. This is the most standard shape available, gives
  versioning and `/plugin` interop for free, and the CLI's JSON output is a
  stable contract. It also makes a shared skill a repo artefact: publishing means
  a commit, and every recipient's copy is a released version rather than a
  snapshot of somebody's home directory. We chose not to: the skills we want to
  exchange live in people's homes right now, and routing them through a registry
  adds a publish step to every share. A dedicated skills repo remains a separate
  plan, and it can grow a marketplace manifest later without disturbing this
  design.
- **A live symlink into the owner's home** — always the owner's current version,
  no update tracking, no second copy. It only works one way: bob can read
  `/home/wizard` (`751`), but wizard's own session cannot traverse bob's `700`
  home, so his sessions would fail with `EACCES` on bob's skill. Symmetry would
  need either a broker directory with a sync timer or loosening a home
  directory's mode.
- **A broker directory** (`/var/lib/skill-share/<owner>/<skill>`, group-readable,
  recipients symlink in) — solves the permission asymmetry and keeps recipients
  current automatically. It needs a sync timer, and the owner's edit changes
  every recipient's session behaviour with no review step. Copy-plus-flagged-updates
  keeps the recipient in the loop for the same information.
- **Pushing a shared skill into the target's account** — the literal "share with
  bob and it is just there". Rejected because a skill can carry executable
  scripts (`spotify/scripts/spotify.py`, `visualize/scripts/viz-publish.sh` and
  others do today), so the person who takes on that code should be the one who
  chose to.
- **Extending `session-events` or `file-api`** rather than adding a service.
  `session-events` already implements skill discovery (`commands.go`) and holds
  the restart seam (`POST /keys`); `file-api` already has a privileged read *and*
  write child with path containment, and nesting routes under `/files/` would
  have needed no terraform change at all. Both were passed over on blast radius:
  a `session-events` deploy drops every open text-view SSE stream, and its
  privileged child is read-only today. A separate binary keeps the one privileged
  write op auditable on its own and its deploys harmless.
- **Keeping `install_skills()` with a tombstone file** so a removal survives the
  hourly reconcile. Sound, and it would have preserved a default set for a future
  user. Retiring the step outright was chosen instead: with every user's skills
  visible, a new person can pull a sensible set from a colleague, and one
  distribution path is easier to reason about than two.

## Where the surface went (2026-08-19, same day)

It shipped as a group inside the Settings overlay and moved out within hours of
being used. The reason is the row counts: 38 own skills, 7 plugins, 21 of one
peer's and every live session, in a 420px column under six other settings groups.
The panel it moved to is wider, gives each list its own tab with a count, and
carries a name/description filter; the row behaviour — the verdicts, the diff, the
backups, the restart rule — is unchanged and still lives in `skills.logic.ts`.
Settings went back to being settings.

The full-screen variant was one of the options considered at design time and was
passed over then in favour of the smaller change. Seeing the real lists is what
settled it.

## Removal has two forms (2026-08-19)

**Remove** keeps a backup and is what the panel offers first; **Delete** is
permanent — the skill, every backup of it, its enabled state and its provenance —
and asks a question that names what cannot come back, which differs by row: a
skill installed from a peer is one click from returning, one this account authored
is not, and a symlinked entry loses only its link.

Plugins get **Uninstall**, which is the CLI's own (`claude plugin uninstall`).
Measured on 2.1.235: it drops the `installed_plugins.json` entry and the
`enabledPlugins` key — no stale marker, unlike the skill path, which is why that
one needed fixing ourselves — but it does not delete the files. It writes
`.orphaned_at` into the cached version directory and leaves it, and `claude plugin
prune` does not take those either, so the manager reclaims them and reports the
bytes. It also rewrites the whole `settings.json` through its own serializer,
reordering top-level keys and reformatting nested values; nothing is lost, and it
owns that file, but it is why a plain enable/disable is written by us instead.

## Consequences

- A skill can now diverge between users on purpose. The manager makes that
  visible (`update available`, `locally modified`) rather than resolving it.
- 13 of bob's 22 skill names already exist in wizard's account and 9 of those
  differ, so the collision path — block, diff, Replace with a timestamped backup
  — is ordinary traffic and is treated as such.
- A newly installed skill reaches only new sessions. The panel names the sessions
  still running an older set and offers a `claude --continue` respawn for the ones
  that are idle.
- `~/.agents/skills` loses its last consumer. bob's 17 symlinks keep resolving
  and are left alone.
- Retiring the vendored snapshot means the 6 skills only bob has stay available
  from him rather than from the infra repo. They are upstream skills, re-fetchable
  if ever lost.
