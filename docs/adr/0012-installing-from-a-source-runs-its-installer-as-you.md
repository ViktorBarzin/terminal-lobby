# Installing from a source runs its installer as you

The skill manager could move a skill between accounts on this box and remove one,
but not bring a skill or plugin in from outside. Viktor asked for a field to paste
a source into, installed with `npx`, "with some check to ensure what we're
installing is indeed a skill and safe to install".

The decision: **the field takes a GitHub `owner/repo`, discovery is read-only, and
the install runs the ecosystem's own installer as the calling user** —
`npx -y skills@latest add <repo> -s <skill> -a claude-code -g -y` for skills,
`claude plugin marketplace add` + `claude plugin install` for a plugin
marketplace. One field decides which by looking at the repo. Nothing is staged for
review first: the install lands in the account and the panel reports what arrived.

Two measurements shaped it. `npx skills add … -a claude-code -g` writes a **real
directory** to `~/.claude/skills/<name>`, which is the layout the manager already
uses, so an installed skill is visible with no extra plumbing. And one call to the
GitHub tree API returns every `SKILL.md` path in the repo *and* whether
`.claude-plugin/marketplace.json` exists — so discovery needs no code execution
and answers "is this indeed a skill" before anything runs.

## What the checks are, and are not

They cover:

- **The input.** Only `owner/repo`, or an `https://github.com/owner/repo` URL
  normalised to it; a strict charset; passed as argv, never interpolated into a
  shell string.
- **Is it a skill.** The repo must contain at least one `SKILL.md`, or a
  marketplace manifest. A repo with neither is refused with that reason.
- **What you are taking on.** The panel reports the installed tree the way a peer
  install already does — file count, how many of those files are executable, and
  every script named — plus a note when the owner is not one you have installed
  from before, and the source recorded as provenance so the row says where it came
  from rather than "own".
- **Getting rid of it.** Delete is one click and permanent, and a skill reaches a
  session only when that session starts.

They do not cover:

- **The installer's own code.** `npx` downloads and executes the vercel CLI with
  the caller's credentials before any check of ours can run. That is inherent to
  installing this way, and it is the accepted trade-off.
- **What the skill tells a model to do.** A `SKILL.md` is instructions. Nothing
  here reads them for intent, and a skill with no scripts at all can still carry
  instructions worth reading.
- **`@latest`.** The CLI version is resolved at install time, so the code that
  runs as you is whatever the registry serves that moment.

## Considered options

- **Fetch and validate it ourselves** — `git clone --depth 1`, find the
  `SKILL.md`, validate, and copy it in through the same `Unpack` path a peer
  install uses. Nothing third-party executes at any point, and provenance can
  record the exact commit. Passed over because it gives up the ecosystem's
  installer and its `skills update`, and because the request was explicitly to use
  npx. It remains the obvious fallback if the CLI ever becomes a problem.
- **The same npx install under `bubblewrap`** (installed on this box): network on,
  only a staging directory writable, the rest of the home invisible; validate the
  staging tree, then move it in. Strongest of the three, and it makes the bwrap
  argument list part of the security surface — worth revisiting if untrusted
  sources ever become routine.
- **A staging gate without a sandbox** — run the install with `HOME` pointed at a
  staging directory (the CLI keys off `HOME`, measured), validate, show the
  `SKILL.md` and its scripts, and only then move it into the account. Passed over:
  given that the installer already ran as the user, the gate protects only against
  the skill's *content*, which the after-report and a one-click Delete cover.
- **A hard allowlist of GitHub owners**, refusing anything else. Passed over: it
  makes trying something new a two-step config edit, and the owner of a repo is
  weak evidence about the code in it.
- **Pinning the CLI version** with a staleness check in the panel. Passed over in
  favour of `@latest`, so upstream fixes and new source types arrive without a
  bump. The trade-off above is the cost.

## A repo can be both

`mattpocock/skills` contains 35 `SKILL.md` files **and** a
`.claude-plugin/marketplace.json`. A precedence rule would have chosen one without
saying so, and both readings are legitimate: the skills individually, or the whole
thing as one plugin (which is what its manifest offers, and what the `pluginName`
in the skills lockfile records). So where a repo is both, the picker offers both
and the person chooses.

## Consequences

- The GitHub tree API is called unauthenticated at 60 requests/hour **per IP**,
  shared by everyone on this box. When the caller's own token is present in their
  `~/.git-credentials` it is used instead (5,000/hour); otherwise a 403 is
  reported as the rate limit rather than as a missing repo.
- Private repos are out of scope: discovery reads a public API, and the CLI clones
  over https without our credentials.
- Installs are synchronous. Measured with a warm npm cache: 3s to list a 22-skill
  repo, 4s to install one skill. A cold cache is dominated by the npm download,
  so the request carries a generous timeout rather than a job queue.
- A repo with many skills is never installed wholesale — discovery lists what is
  there and the install names the ones chosen.
