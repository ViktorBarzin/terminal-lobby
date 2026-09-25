# A user's skills live where the machine's harness policy says

ADR-0011 put every skill in `~/.claude/skills/<name>` as a real directory and
treated a link there as pointing at something another tool owns. That matched
how the box worked in August. Since 2026-09-25 one user, wizard, keeps every
skill in `~/.agents/skills/<name>` instead. Codex reads that directory directly,
Claude Code reads only `~/.claude/skills`, and `~/.claude/skills/<name>` is a
relative link to the real directory. It is the layout the vercel skills CLI
makes when it installs for more than one harness, and the nightly skills updater
now installs his upstream skills that way.

Before this change the manager read that layout as foreign. Every one of his
skills showed as "own · linked". Removing one dropped the link and left the
directory, which Codex went on loading. Installing one, from a peer or from a
GitHub source, wrote a loose copy into `~/.claude/skills` that Codex never saw.

We make the layout a per-user property that skills-api reads from the machine's
skills policy: `/usr/local/share/claude-skills/<user>/agents`, one harness per
line, shipped by infra's `playbooks/devvm.yml`. The nightly updater reads the
same file, so a skill lands in the same place whichever tool installed it. No
file, or `claude-code` alone, is the original layout (`skillscan.InClaude`), and
nothing about it changes. Any other harness in the list selects
`skillscan.InAgents`:

| operation | InAgents |
|---|---|
| install from a peer | real directory in `~/.agents/skills/<name>`, relative link in `~/.claude/skills/<name>`; a loose copy already in `~/.claude/skills` is backed up and replaced by the link |
| install from a source | the skills CLI gets every harness in the list as an `-a` flag, so it writes the same pair |
| list | a link to the user's own `~/.agents/skills/<name>` is an ordinary skill, not "linked" |
| remove | the backup holds the `~/.agents/skills` directory, and both halves go |
| delete | both halves and every backup go; if `~/.agents/skills/<name>` is itself a link (a skill kept in a repo checkout), that link goes and its target is left alone |

A `~/.claude/skills` link that points anywhere other than the user's own
`~/.agents/skills/<name>` keeps the ADR-0011 meaning in both layouts: only the
link is ever dropped.

## Considered options

- **Detect the layout from the filesystem per skill.** A link into
  `~/.agents/skills` would count as the user's own. emo has two such links from
  the skills CLI's older layout, and he was not part of this change, so his
  removes would have started deleting directories he has never managed through
  the panel. An explicit per-user setting keeps the change to the users who
  opted in.
- **A setting of the manager's own.** A second list of harnesses could drift
  from the updater's, and then a skill would land in `~/.claude/skills` or
  `~/.agents/skills` depending on which tool installed it. Reading the updater's
  file means one list decides both.
- **Leave the manager as it was and link skills in a sync job.** wizard's
  agents-sync could move any real directory in `~/.claude/skills` into
  `~/.agents/skills` every 15 minutes. Remove and delete would still drop only
  the link, and the panel would still show every skill as linked.

## Consequences

- The manager's layout now depends on a file infra ships. When the file is
  missing, as in CI and on a machine without the playbook, the original layout
  applies.
- For wizard, removing one of his own skills (the ones his dotfiles manage)
  through the panel lasts only until his agents-sync next applies the dotfiles.
  Those are removed with `chezmoi forget`; upstream skills the updater installs
  come back the next night unless listed in his `exclude`.
