# Contributing

Patches are welcome, and if you change terminal-lobby we would rather see the
change here than lose it in a fork.

## Send changes upstream

The AGPL already requires you to make your modified source available to anyone
who uses your version over a network (see [LICENSING.md](LICENSING.md)). Opening
a pull request is the easiest way to meet that obligation, and it means the next
person benefits from your work. It is a request rather than a licence term, but
it is the one thing that keeps this project worth sharing.

If your change is specific to your own setup and would not help anyone else,
publishing your fork is enough.

## Before you open a PR

- **Write the test first.** Everything with testable behaviour is built
  test-first. Go services use the standard library plus table tests; the
  frontend uses Vitest. Terraform, config and docs are exempt.
- **Run the suites.** `go test ./...` in each Go module, and
  `npx vitest run` in `frontend-v2/`. Both are green on master and should stay
  that way.
- **Keep the commit message useful.** The subject says what changed, the body
  says why in plain words.
- **No lint or type suppressions**, and no `any` where a real type exists.

## Copyright

You keep the copyright in what you write. By opening a pull request you agree
that your contribution is licensed under AGPL-3.0-or-later, and that Viktor
Barzin may also include it in commercially licensed copies. Without that second
part the dual-licence arrangement in [LICENSING.md](LICENSING.md) cannot work.

If you are not comfortable with that, say so in the PR. A patch is still useful
even if we end up reimplementing it.

## Reporting problems

Open an issue with what you ran, what happened, and what you expected. If it is
a terminal or rendering problem, the browser, OS and terminal size matter more
than usual.
