# Skill manager in the lobby's Settings panel

**Status:** built, deployed and verified on 2026-08-19
**Date:** 2026-08-19
**Owner:** wizard
**Repo:** `terminal-lobby` (a small companion change lands in `infra`)

## Goal

Give every lobby user one place to see the skills their Claude sessions load,
switch them on and off, and pick up a skill another user on the box already
has. Today a skill reaches a second person through the hourly provisioner
(`t3-provision-users.sh`, allowlisted to `bob`, install-if-absent), which got a
starter set onto the box reliably and reproducibly. Two things it does not do
yet: a copy never refreshes after the first install, and the set is chosen
centrally rather than by each user. The manager adds the per-user, self-service
half.

Scope is a **Skills** group inside the existing Settings overlay, plus a small
backend that owns the filesystem work.

```stats
13 | skill names present in both accounts
9 | of those whose content differs
8 | skills only bob has today
17 | vendored skills the retirement drops
```

## Non-goals

- No marketplace, and no registry repo. A separate skills repo is a plan for
  later; it changes nothing here. For this feature, each user simply *has* a set
  of skills and where they came from is not modelled.
- No browsing of upstream marketplaces (`claude-plugins-official` and friends).
  `/plugin` already does that well.
- No authoring surface: the manager reads skills and moves them, it does not
  edit them.
- No changes to project-scoped skills (e.g. the ~10 under `infra/.claude/skills`),
  which load from the repo a session is working in.

## What is already here (and gets reused)

| Existing piece | What it gives us |
|---|---|
| `SettingsPanel.tsx` | The overlay, its focus trap, Escape/backdrop close, and the flat `tl-settings-group` section style the new group adopts |
| `session-events/commands.go` | A working reference implementation of skill discovery: `~/.claude/skills/*/SKILL.md`, `~/.claude/commands/**.md`, and enabled plugins resolved through `settings.json` → `enabledPlugins` + `plugins/cache/<market>/<name>/<version>` |
| `file-api/privop.go`, `session-events/privreader.go` | The `sudo -n -u <user> <binary> -privop` pattern for acting as another OS user, with the child re-validating every path |
| `authuser` | `X-Authentik-Username` → `/etc/ttyd-user-map`, and the `?as=` admin act-as gate against `/etc/ttyd-admins` |
| `telemetry` | The Loki-bound event helper each service already uses |
| The `wizard ALL=(bob) NOPASSWD: /usr/bin/tmux` grant | Restarting a session's Claude needs no new privilege |

## Decisions

Each of these was settled in the 2026-08-19 grilling session.

> [!NOTE]
> A dedicated skills repo for storing and distributing wizard's own skills is a
> separate plan for later. For this feature each user simply has a set of skills
> and their origin is not modelled.

| # | Decision | Why |
|---|---|---|
| 1 | A **Skills group inside the Settings overlay**, not a separate full-screen view | The panel already carries every other per-user setting; a group is the smallest surface that answers the ask. **Revised the same day** — see *As built*: the lists were too long for it, so the surface became its own overlay beside Settings, with a tab per list and a filter |
| 2 | **Every user's `~/.claude/skills` is visible to every lobby user**, no publish step and no per-skill privacy flag | Matches what OS permissions already allow — `/home/wizard` is `751` with `.claude/skills` at `775`, so bob can read those files today; wizard reads bob's `700` home via the sudo he already holds |
| 3 | **The recipient clicks Install.** Nothing is pushed into anyone's account | Skills carry executable code, so the person taking on that code is the one choosing to |
| 4 | **Install copies a snapshot**, and the manager flags later divergence | A copy is stable and editable; a live symlink into another home would work bob→wizard but not wizard→bob (his home is `700`), so it would be asymmetric |
| 5 | **Installs land directly in `~/.claude/skills/<name>`** as real directories | This is how wizard's 38 skills already live; nothing on the box reads the `~/.agents/skills` indirection any more once the provisioner step goes |
| 6 | **Name collisions block**, show a diff, and offer *Replace* with a timestamped backup; identical content is labelled "same as yours" with no action | 13 of bob's 22 skill names already exist in wizard's account and 9 of those genuinely differ, so this is the common path, not an edge case |
| 7 | The list covers **loose skills and marketplace plugins** in one inventory | That is what a session actually loads; disabling `superpowers` from the same place is worth the one extra call |
| 8 | After a change, the panel names the **sessions still running an older skill set** and offers Restart on those whose Claude state is `done`/`awaiting`, never mid-turn | A new skill only reaches a new session; the state dot the sidebar already shows tells busy from idle |
| 9 | Restart respawns the pane with **`claude --continue`** | Keeps the transcript, so loading the skill does not cost the thread |
| 10 | A **new `skills-api` service on :7688** owns the endpoints | Deploying it can never drop an open SSE transcript stream (`session-events`) or a file preview (`file-api`), and the one privileged write op stays auditable on its own |
| 11 | **`install_skills()`, `SKILL_USERS`, and `scripts/workstation/claude-skills/` are retired** from the infra repo | The manager becomes the only distribution path; bob's existing copies stay on disk and remain installable from him |
| 12 | Rows offer **View, Update, Enable/Disable, Remove** (backup first); plugin rows also offer **Update** | Reading a peer's skill before installing it matters when skills ship scripts |

### Two mechanisms chosen on evidence

**Enable/disable is a direct `settings.json` write.** `claude plugin disable
<name>@skills-dir` was tested in a throwaway HOME and writes exactly
`{"enabledPlugins": {"<name>@skills-dir": false}}`, with `enable` flipping it
back. Writing that key ourselves is instant and needs no external binary. The
format belongs to Claude Code, so the write lives behind one function with tests
asserting its shape.

**Plugin Update execs the user's own `claude`.** The binary is per-user
(`/home/bob/.local/bin/claude`), but the privileged child is already running *as*
that user, so exec'ing it grants nothing extra — it is the same thing that user
could run in a terminal. It costs a few seconds per call, which is acceptable for
an explicit Update button.

## Mockups

Slate theme, at the panel's real width of 420 px. Generated by
`assets/skill-manager/gen.py`, which takes its palette from
`frontend-v2/src/theme/theme.css` and its geometry from the `.tl-settings-*`
rules in `frontend-v2/src/app.css`, so these are the panel's own tokens rather
than approximations.

<figure style="margin:1.4rem 0">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 419" style="max-width:560px;width:100%;height:auto;display:block" role="img" aria-label="The Skills panel: its own overlay beside Settings">
  <title>The Skills panel: its own overlay beside Settings</title>
  <rect x="1" y="1" width="558" height="417" rx="18" fill="#161b22" stroke="#30363d" stroke-width="1"/>
  <text x="18" y="34" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="15" fill="#e6e8eb" font-weight="600">Skills</text>
  <text x="514" y="35" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="14" fill="#7d8590" text-anchor="end">⟳</text>
  <text x="538" y="35" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="15" fill="#7d8590" text-anchor="end">✕</text>
  <rect x="18" y="56" width="76.0" height="26" rx="10" fill="#132b4d" stroke="#4493f8" stroke-width="1"/>
  <text x="29" y="73" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#e6e8eb">Mine</text>
  <text x="83.0" y="73" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#e6e8eb" text-anchor="end">38</text>
  <rect x="99.0" y="56" width="69.0" height="26" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <text x="110.0" y="73" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#7d8590">bob</text>
  <text x="157.0" y="73" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" text-anchor="end">17</text>
  <rect x="173.0" y="56" width="90.0" height="26" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <text x="184.0" y="73" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#7d8590">Plugins</text>
  <text x="252.0" y="73" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" text-anchor="end">7</text>
  <rect x="268.0" y="56" width="104.0" height="26" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <text x="279.0" y="73" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#7d8590">Sessions</text>
  <text x="361.0" y="73" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" text-anchor="end">13</text>
  <line x1="18" y1="90" x2="542" y2="90" stroke="#1f242d" stroke-width="1"/>
  <rect x="18" y="102" width="524" height="30" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <text x="29" y="122" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#7d8590">Filter by name or description</text>
  <rect x="18" y="141.5" width="13" height="13" rx="3" fill="#4493f8" stroke="#4493f8" stroke-width="1"/>
  <path d="M21,148 l2.6,2.6 L28,144.6" fill="none" stroke="#0d1117" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="40" y="152" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="13" fill="#e6e8eb">grilling</text>
  <text x="542" y="152" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" text-anchor="end">own</text>
  <rect x="18" y="168.5" width="13" height="13" rx="3" fill="#4493f8" stroke="#4493f8" stroke-width="1"/>
  <path d="M21,175 l2.6,2.6 L28,171.6" fill="none" stroke="#0d1117" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="40" y="179" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="13" fill="#e6e8eb">publish-page</text>
  <text x="542" y="179" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" text-anchor="end">own</text>
  <rect x="18" y="195.5" width="13" height="13" rx="3" fill="#4493f8" stroke="#4493f8" stroke-width="1"/>
  <path d="M21,202 l2.6,2.6 L28,198.6" fill="none" stroke="#0d1117" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="40" y="206" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="13" fill="#e6e8eb">cluster-health</text>
  <text x="542" y="206" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#4493f8" text-anchor="end">from bob · ⟳ update</text>
  <rect x="18" y="222.5" width="13" height="13" rx="3" fill="none" stroke="#30363d" stroke-width="1"/>
  <text x="40" y="233" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="13" fill="#7d8590" opacity="0.75">caveman</text>
  <text x="542" y="233" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" text-anchor="end">from bob</text>
  <rect x="18" y="249.5" width="13" height="13" rx="3" fill="#4493f8" stroke="#4493f8" stroke-width="1"/>
  <path d="M21,256 l2.6,2.6 L28,252.6" fill="none" stroke="#0d1117" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="40" y="260" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="13" fill="#e6e8eb">email</text>
  <text x="542" y="260" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" text-anchor="end">own</text>
  <rect x="18" y="276.5" width="13" height="13" rx="3" fill="#4493f8" stroke="#4493f8" stroke-width="1"/>
  <path d="M21,283 l2.6,2.6 L28,279.6" fill="none" stroke="#0d1117" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="40" y="287" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="13" fill="#e6e8eb">spotify</text>
  <text x="542" y="287" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" text-anchor="end">own</text>
  <rect x="18" y="303.5" width="13" height="13" rx="3" fill="#4493f8" stroke="#4493f8" stroke-width="1"/>
  <path d="M21,310 l2.6,2.6 L28,306.6" fill="none" stroke="#0d1117" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="40" y="314" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="13" fill="#e6e8eb">tripit-cli</text>
  <text x="542" y="314" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" text-anchor="end">own</text>
  <text x="40" y="341" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">…  31 more, scrolling under the tabs</text>
  <line x1="18" y1="365" x2="542" y2="365" stroke="#1f242d" stroke-width="1"/>
  <text x="18" y="385" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">Everyone here can see everyone&#x27;s skills. Installing copies it into</text>
  <text x="18" y="400" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">your account; the owner&#x27;s copy is untouched.</text>
</svg>
<figcaption style="font-size:0.86em;line-height:1.55;opacity:0.78;margin-top:0.6rem"><strong>1 — the group in place.</strong> Every user's skills are visible with no publish step. <em>Mine</em> carries provenance and an update marker, <em>Plugins</em> brings the marketplace ones into the same inventory, and <em>From bob</em> is what is there to take — an identical skill says so and offers nothing to do.</figcaption>
</figure>

<figure style="margin:1.4rem 0">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 232" style="max-width:420px;width:100%;height:auto;display:block" role="img" aria-label="An expanded skill row with its actions">
  <title>An expanded skill row with its actions</title>
  <rect x="1" y="1" width="418" height="230" rx="18" fill="#161b22" stroke="#30363d" stroke-width="1"/>
  <text x="18" y="34" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" letter-spacing="0.9">SKILLS</text>
  <text x="402" y="34" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" text-anchor="end">⟳ refresh</text>
  <rect x="18" y="51.5" width="13" height="13" rx="3" fill="#4493f8" stroke="#4493f8" stroke-width="1"/>
  <path d="M21,58 l2.6,2.6 L28,54.6" fill="none" stroke="#0d1117" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="40" y="62" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="13" fill="#e6e8eb">diagnose</text>
  <text x="402" y="62" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#4493f8" text-anchor="end">from bob · ⟳ update</text>
  <rect x="40" y="74" width="362" height="118" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <text x="52" y="96" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">Diagnosis loop for hard bugs and performance</text>
  <text x="52" y="111" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">regressions. Use when the user says &quot;diagnose&quot;.</text>
  <text x="52" y="134" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="11" fill="#7d8590">4 files · 2 executable · 6.1 KB</text>
  <text x="52" y="150" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="11" fill="#4493f8">bob changed SKILL.md 3 days ago</text>
  <rect x="52" y="162.0" width="46.8" height="24" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <text x="75.4" y="178" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#e6e8eb" text-anchor="middle">View</text>
  <rect x="105.8" y="162.0" width="60.2" height="24" rx="10" fill="#132b4d" stroke="#4493f8" stroke-width="1"/>
  <text x="135.9" y="178" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#cfe3ff" text-anchor="middle">Update</text>
  <rect x="173.0" y="162.0" width="66.9" height="24" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <text x="206.45" y="178" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#e6e8eb" text-anchor="middle">Disable</text>
  <rect x="246.9" y="162.0" width="60.2" height="24" rx="10" fill="#0d1117" stroke="#f47067" stroke-width="1"/>
  <text x="277.0" y="178" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#f47067" text-anchor="middle">Remove</text>
  <text x="18" y="212" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">Remove backs the directory up first, it never just deletes.</text>
</svg>
<figcaption style="font-size:0.86em;line-height:1.55;opacity:0.78;margin-top:0.6rem"><strong>2 — a row opened.</strong> The description, the file count, and how many of those files are executable, because installing a skill puts its scripts in your sessions. Update appears only when the owner's copy has moved on.</figcaption>
</figure>

<figure style="margin:1.4rem 0">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 268" style="max-width:420px;width:100%;height:auto;display:block" role="img" aria-label="Installing a skill whose name you already use">
  <title>Installing a skill whose name you already use</title>
  <rect x="1" y="1" width="418" height="266" rx="18" fill="#161b22" stroke="#30363d" stroke-width="1"/>
  <text x="18" y="34" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" letter-spacing="0.9">FROM BOB — NOT INSTALLED</text>
  <text x="18" y="64" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="13" fill="#e6e8eb">tdd</text>
  <rect x="52" y="53" width="58" height="15" rx="7" fill="#2a1f16" stroke="#f47067" stroke-width="1"/>
  <text x="81" y="64" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="10" fill="#f47067" text-anchor="middle">differs</text>
  <text x="402" y="64" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590" text-anchor="end">you have your own</text>
  <rect x="18" y="78" width="384" height="96" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <text x="30" y="98" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="11" fill="#7d8590">SKILL.md</text>
  <line x1="30" y1="106" x2="390" y2="106" stroke="#1f242d" stroke-width="1"/>
  <text x="30" y="124" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="11" fill="#f47067">-</text>
  <text x="44" y="124" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="11" fill="#f47067">red-green-refactor, property-based tests</text>
  <text x="30" y="141" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="11" fill="#56d364">+</text>
  <text x="44" y="141" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="11" fill="#56d364">red-green-refactor; integration first</text>
  <text x="30" y="158" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="11" fill="#7d8590"> </text>
  <text x="44" y="158" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="11" fill="#7d8590" opacity="0.85">…3 more changed lines</text>
  <rect x="18" y="178.0" width="113.8" height="24" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <text x="74.9" y="194" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#e6e8eb" text-anchor="middle">View full diff</text>
  <rect x="139.8" y="178.0" width="174.1" height="24" rx="10" fill="#132b4d" stroke="#4493f8" stroke-width="1"/>
  <text x="226.85000000000002" y="194" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#cfe3ff" text-anchor="middle">Replace (backs up mine)</text>
  <text x="18" y="220" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">Your copy moves to .backup/tdd-20260819T0912Z/ before</text>
  <text x="18" y="235" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">bob&#x27;s is written. Identical skills show &quot;= same as yours&quot;</text>
  <text x="18" y="250" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">and offer nothing to do.</text>
</svg>
<figcaption style="font-size:0.86em;line-height:1.55;opacity:0.78;margin-top:0.6rem"><strong>3 — a name you already use.</strong> 13 of bob's 22 names already exist in wizard's account and 9 of those differ, so this is ordinary traffic: the diff comes first, and Install becomes Replace, which backs your copy up before writing.</figcaption>
</figure>

<figure style="margin:1.4rem 0">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 230" style="max-width:420px;width:100%;height:auto;display:block" role="img" aria-label="After an install: which sessions can pick it up">
  <title>After an install: which sessions can pick it up</title>
  <rect x="1" y="1" width="418" height="228" rx="18" fill="#161b22" stroke="#30363d" stroke-width="1"/>
  <circle cx="25" cy="32" r="8" fill="none" stroke="#56d364" stroke-width="1.6"/>
  <path d="M21.5,31.5 l2.6,2.6 L29,28" fill="none" stroke="#56d364" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="42" y="36" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="13" fill="#e6e8eb">installed diagnose from bob</text>
  <text x="18" y="60" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">Loads in new sessions. 3 of yours are running now:</text>
  <rect x="18" y="74" width="384" height="108" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <circle cx="38" cy="96" r="4.2" fill="#4493f8"/>
  <text x="52" y="100" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="12" fill="#e6e8eb">infra-work</text>
  <text x="158" y="100" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#4493f8">running</text>
  <text x="390" y="100" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="10" fill="#7d8590" text-anchor="end">picks it up on next start</text>
  <circle cx="38" cy="128" r="4" fill="none" stroke="#56d364" stroke-width="1.6"/>
  <text x="52" y="132" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="12" fill="#e6e8eb">notes</text>
  <text x="158" y="132" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#56d364">idle</text>
  <rect x="312" y="116.0" width="78" height="24" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <text x="351.0" y="132" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#e6e8eb" text-anchor="middle">Restart</text>
  <circle cx="38" cy="160" r="4" fill="none" stroke="#a371f7" stroke-width="1.6"/>
  <text x="52" y="164" font-family="'JetBrains Mono','SFMono-Regular',ui-monospace,monospace" font-size="12" fill="#e6e8eb">tripit</text>
  <text x="158" y="164" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#a371f7">awaiting</text>
  <rect x="312" y="148.0" width="78" height="24" rx="10" fill="#0d1117" stroke="#1f242d" stroke-width="1"/>
  <text x="351.0" y="164" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="12" fill="#e6e8eb" text-anchor="middle">Restart</text>
  <text x="18" y="198" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">Restart respawns the pane with claude --continue, so the</text>
  <text x="18" y="213" font-family="'DM Sans','Inter',system-ui,-apple-system,sans-serif" font-size="11" fill="#7d8590">conversation survives. A session mid-turn is never offered one.</text>
</svg>
<figcaption style="font-size:0.86em;line-height:1.55;opacity:0.78;margin-top:0.6rem"><strong>4 — after an install.</strong> A skill only loads in a new session, so the panel names the ones already running and offers Restart on those that are idle. A session mid-turn is never offered one.</figcaption>
</figure>

## Architecture

```mermaid
flowchart TD
  subgraph browser["Browser — terminal.viktorbarzin.me"]
    SP["SettingsPanel<br/>Skills group"]
  end

  SP -->|"/skills/*"| TR["Traefik<br/>+ Authentik forward-auth"]
  TR -->|"X-Authentik-Username"| API["skills-api :7688<br/>runs as wizard"]

  API -->|"inline (own home)"| WHOME["/home/wizard/.claude/skills"]
  API -->|"sudo -n -u bob skills-api -privop"| CHILD["privop child<br/>runs as bob"]
  CHILD --> EHOME["/home/bob/.claude/skills"]
  CHILD -->|"Update only"| CLI["~/.local/bin/claude<br/>plugin update"]

  API -->|"sudo -u USER tmux respawn-pane"| TMUX["tmux server<br/>per uid"]
  API -->|"install / remove / toggle events"| LOKI["telemetry → Loki"]
```

The privileged child is the same shape as `session-events`': one long-lived
process per user speaking a fixed request/response protocol on stdin/stdout,
re-validating every path against its own `$HOME/.claude/skills` root, so the
sudo grant trusts nothing from the caller.

## Installing a peer's skill

```mermaid
sequenceDiagram
  autonumber
  participant U as wizard (browser)
  participant A as skills-api
  participant C as privop child (as bob)
  participant F as ~/.claude/skills

  U->>A: GET /skills
  A->>C: scan
  C-->>A: bob's skills + hashes
  A-->>U: mine · plugins · from bob
  U->>A: GET /skills/view?owner=bob&name=diagnose
  A-->>U: SKILL.md + file list + size
  U->>A: POST /skills/install {owner: bob, name: diagnose}
  A->>C: read-tree diagnose
  C-->>A: files (mode-preserving)
  A->>F: write diagnose.incoming-<pid> → rename
  A->>F: record provenance in .manager.json
  A-->>U: installed · 2 idle sessions can restart
  U->>A: POST /skills/restart {session: notes}
  A->>A: tmux respawn-pane -k -t notes 'claude --continue'
```

A collision changes only the middle: `install` refuses with `409` and the client
fetches `GET /skills/diff`, then re-posts with `replace: true`, which moves the
existing directory to `.backup/<name>-<UTC timestamp>/` before writing.

## HTTP surface

All routes take the standard `X-Authentik-Username` header and the optional
`?as=<user>` admin switch, resolved through `authuser` exactly as the sibling
services do.

| Method + path | Purpose |
|---|---|
| `GET /skills` | Full inventory: the caller's skills (with enabled state and provenance), their marketplace plugins, and every other mapped user's skills |
| `GET /skills/view?owner=&name=` | `SKILL.md` body plus the file list, sizes, and which files are executable |
| `GET /skills/diff?owner=&name=` | Unified diff of the peer's copy against the caller's same-named skill |
| `POST /skills/install` | `{owner, name, replace?}` — copy in; `409` when a differing skill of that name exists and `replace` is not set |
| `POST /skills/toggle` | `{id, enabled}` — one `enabledPlugins` write; `id` is `<name>@skills-dir` or `<plugin>@<marketplace>` |
| `POST /skills/remove` | `{name}` — back up, then delete |
| `POST /skills/plugin-update` | `{plugin}` — exec the caller's own `claude plugin update` |
| `POST /skills/restart` | `{session}` — respawn that session's pane with `claude --continue`; refuses a session whose state is `running` |
| `GET /health` | Unauthenticated, like every sibling |

## On-disk contract

```
~/.claude/skills/
  grilling/                    a skill this user authored
  diagnose/                    installed from bob
  .manager.json                provenance, written only by skills-api
  .backup/diagnose-20260819T091200Z/
```

`.manager.json`:

```json
{
  "version": 1,
  "installed": {
    "diagnose": {
      "from": "bob",
      "sourceHash": "sha256:9f2c…",
      "installedAt": "2026-08-19T09:12:00Z"
    }
  }
}
```

> [!WARNING]
> A skill can ship executable code — `spotify/scripts/spotify.py`,
> `visualize/scripts/viz-publish.sh` and `diagnosing-bugs/scripts/hitl-loop.template.sh`
> do today. Installing one means those scripts run in your sessions, which is why
> the recipient initiates every install and View comes before Install.

**Copy rules.** The source must be a directory containing `SKILL.md`. `.git`,
`node_modules` and `__pycache__` are excluded (`claudeception/` carries a nested
`.git` today). Symlinks pointing outside the skill directory are skipped rather
than followed. Mode bits are preserved so scripts stay executable. A copy is
capped at 5 MB and 500 files, written to `<name>.incoming-<pid>` and renamed into
place, and performed by the child running as the recipient so ownership is right
without a `chown`.

**Hashing.** `sourceHash` is a sha256 over the sorted `(relative path, mode,
content)` triples of the copied set. Comparing it three ways gives the whole
update story: peer hash ≠ stored hash means *update available*; local hash ≠
stored hash means *locally modified*; both differing means the Update button
offers the same Replace-with-backup flow as a first-time collision.

**bob's 17 existing symlinks** into `~/.agents/skills` keep resolving and appear
as ordinary skills. Removing one deletes the symlink and backs up the resolved
content, leaving `~/.agents/skills` alone — inert once the provisioner step is
retired.

## Frontend shape

The four mockups above are the target. `SkillsPanel.tsx` is its own dialog —
reusing `.tl-settings` for chrome so the two overlays cannot drift on border,
radius or padding — holding a tab strip, a filter, and one list per tab: **Mine**
(toggle + row actions), one tab per other account (install / replace), **Plugins**
(toggle + Update) and **Sessions** (restart). State lives in `store/skills.ts`
over `lib/skills-api.ts`, following the `file-api.ts` error-handling shape; the
tab and filter state is local to the panel. Row expansion shows the description,
file count, size and the action buttons; View and diff render in place.

## Companion change in `infra`

- Delete `install_skills()`, the `SKILL_USERS` variable, and
  `scripts/workstation/claude-skills/` (17 vendored skills).
- `stacks/terminal/main.tf`: add a `kubernetes_service` + `kubernetes_endpoints`
  + `IngressRoute` for `skills-api` on `:7688`, matching
  `PathPrefix('/skills/')` with the `authentik-forward-auth` middleware and no
  prefix strip — the same shape as the `file-api` block.
- Update the memory entry describing the vendoring flow (id 6530) so it points
  at the manager instead.

> [!IMPORTANT]
> Retiring `install_skills()` means a brand-new user starts with no skills and
> pulls what they want from a colleague. Existing copies on disk are untouched.

`devvm/sudoers.d-ttyd-users` (in this repo, hand-maintained by decision) gains
`/usr/local/bin/skills-api` on each per-user line, with a comment explaining the
op set the child accepts.

## Rollout order

1. `skillscan` package: scan, hash, copy, and the `.manager.json` reader/writer, test-first.
2. `skills-api` with its privop child, auth wiring, and telemetry.
3. `devvm/skills-api.service` + the sudoers line; add `skills-api` to `scripts/deploy-services.sh` (`SERVICES`, the per-service install loop, `enable --now`, and a `/health` + `401` verification like its siblings).
4. `infra` terraform route, pushed and left to CI; verify with read-only kubectl.
5. Frontend group + store + vitest coverage; ship with `deploy-v2.sh`.
6. Retire the provisioner step and the vendored snapshot.
7. ADR-0011, README component table, and the `CONTEXT.md` glossary entries.

## Testing

Go, mirroring the 117 existing `_test.go` files: table tests for scan and hash
stability, copy exclusions and caps, collision classification (same / differs /
absent), containment refusals for `..` and escaping symlinks, the `enabledPlugins`
write preserving unknown keys, and the privop protocol. Auth tests follow
`file-api/actas_test.go`.

Frontend, mirroring the 119 vitest files: store transitions for install / update /
toggle / remove, the three collision states, and the restart affordance appearing
only for idle sessions.

Manual check: install one of the 8 skills only bob has, restart an idle session,
confirm the skill appears in that session's `/` menu.

## As built

Landed and live the same day. What is running: `skillscan/` and `skills-api` on
`:7688` (unit + sudoers grant + `deploy-services.sh`), the `/skills/` ingress
route (applied by CI, pipeline #1173), the Skills group in the deployed lobby SPA,
and the provisioner's vendoring step retired. 75 Go tests and 36 frontend tests,
plus a run against the two real accounts: 38 own skills, 7 plugins, and of bob's
21 exactly the 4 identical / 9 divergent / 8 absent the design predicted.

Five things came out differently from the design above, all of them from building or using it:

- **The surface moved out of Settings.** It shipped as decision 1 described and was
  moved within hours of being used, because the row counts do not fit that shape:
  38 own skills, 7 plugins, 21 of one peer's and every live session, in a 420px
  column under six other settings groups. It is now its own overlay off the shell
  bar beside Settings, one tab per list with a count, and a filter over name and
  description. The row behaviour did not change — the verdicts, the diff, the
  backups and the mid-turn restart rule are the same functions in
  `skills.logic.ts`; a new `skills.tabs.ts` owns the tab strip, the filter and
  the empty states. Mockup 1 above shows the shipped panel; 2–4 show row-level
  behaviour and are unchanged.

- **An install is a packed hand-off, not a directory copy.** The design said copy;
  the constraint that forced the shape is that peer homes are `0700` in *both*
  directions, so no single process can read the owner's skill and write the
  recipient's. `skillscan.Pack` runs as the owner, `Unpack` as the recipient, and
  the skill travels between them as a validated value. Unpack re-checks every path
  for traversal and excluded directories, requires the assembled tree to hash to
  what the owner reported, and leaves nothing behind when it refuses.
- **The hash ignores every mode bit except the executable one.** Users here have
  different umasks — the same file is `0664` in wizard's home and `0644` in bob's —
  so hashing the full mode would have reported all 13 shared names as divergent.
  Copy normalises modes for the same reason, which is what makes a copied skill
  hash identically to its source.
- **Remove clears the enabled state as well.** Found by exercising the live
  service: a skill removed while switched off left `"<name>@skills-dir": false`
  behind, so installing it again later would have come back silently disabled from
  a marker nobody would think to look for.
- **The session list shows every live session**, with the mid-turn ones marked,
  rather than only the ones running an older skill set. Nothing records when a
  session's Claude last read its skills, so "affected" is honestly all of them.

Two of the repo's own guards earned their keep. The docs-truth test refused the
frontend until the new dev-proxy prefix and the four new files were in the README
layout map. The Safari-baseline gate refused the deploy over a class static
block — which turned out to be a CSS class named `tl-skill-static` matching
`\bstatic\s*\{` in the single-file bundle; the pattern now has a lookbehind and a
test in both directions, and the class was renamed.

## Open questions and known limits

- **`--continue` picks the most recent conversation for the pane's directory.**
  Where two sessions share a cwd, a restart could resume the other thread.
  wizard's shell wrapper already records a pane→session-id map at
  `~/.local/state/claude-pane-sessions.json`, so `--resume <id>` would be exact
  where that map exists; worth doing if it proves to be a real problem.
- **`enabledPlugins` is Claude Code's format, not ours.** Verified on 2.1.235,
  and exercised against the real `settings.json`: a toggle produced a two-line
  diff and a remove left the file byte-identical to before, with mode `0600`
  preserved. If a future version changes the format, toggles need a matching
  update — the tests are there to catch it loudly.
- **`/commands/` and `/search/` are still not routed** by the ingress (only
  `/events/ /prompt/ /cancel/ /earlier/ /result/ /pane/ /keys/` are), so the
  composer's per-user slash-command catalogue still falls back to built-ins.
  Deliberately left alone: it is a pre-existing gap unrelated to this feature, and
  the terraform change here was kept to the three resources the plan named. Still
  a one-line fix in that file when someone wants it.
- **`devvm/sudoers.d-ttyd-users` still carries a line for `carol`**, who left
  the roster on 2026-08-17. Noted for a separate tidy, not changed here.
- **Trust remains manual.** Nothing scans an installed skill for what its scripts
  do. The safeguards are View before Install, provenance recorded in
  `.manager.json`, and a backup taken before any replace.
