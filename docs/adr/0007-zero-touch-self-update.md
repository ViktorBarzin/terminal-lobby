# The app updates itself, and only when it actually changed

Viktor, 2026-08-04: *"the update notifications come too frequently. we don't
have that many updates. something seems to be causing the refresh and/or tapping
it doesn't really update it, hence the notifications keeps popping up."* The ask:
**the user does nothing — it just updates itself on the next open.**

Two independent defects produced that experience, and the pill that reported
them was itself the third.

## What was wrong

**1. The update identity was the git SHA, so every commit was an "update".**
`deploy.sh` stamped `__TL_BUILD__` with `git rev-parse --short HEAD` and the
detector compared a djb2 hash of the **whole served body** — and the stamp lives
inside that body. "A new build is being served" therefore meant "someone
committed something": a `tmux-api` fix, a telemetry tweak, a docs commit. In the
month before this ADR, **178 of 323 commits (55%) left `frontend/index.html`
byte-identical**, and every one of them would have notified every open tab.
Proof the stamp was the only per-deploy delta:
`diff <(sed "s/__TL_BUILD__/caad926/" frontend/index.html) /usr/local/share/ttyd/index.html`
→ empty.

**2. Detection was not idempotent and reloads were never confirmed.**
`bootPageHash` was assigned in exactly one place (inside `armBaseline`), and the
mismatch branch never re-armed it — so one stale document re-detected on every
5s tick for its whole life, held back only by a single `updatePending` boolean.
All four reload call sites were fire-and-forget: nothing recorded what build was
being targeted, and nothing checked afterwards whether it was reached. The
tab-hide path went further and cleared the dedupe *before* the navigation it
could not confirm, without closing the card — so a hidden-time reload that did
not commit came back with the gate open and the stale card still on screen, and
the next tick added another.

**3. The pill had a dismiss button that did not update anything.** Every toast
card gets a `✕`, and the whole-card tap handler explicitly excludes it
(`if (e.target.closest('.t-x, .t-expand, .t-copy')) return;`). Tapping it closed
the card and left `updatePending === true` — which, being the only dedupe, meant
that document could never raise another pill. The observable result is exactly
the report: *tapped it, it went away, nothing updated, and it was back on the
next open.*

Ruled out with measurements, so nobody re-investigates them: the origin is
byte-stable across requests (6 fetches, one hash), `?arg=` does not vary it,
neither service worker has a `fetch` handler or any Cache Storage, there is no
caching layer or replica divergence at the ingress, and the "the tap is
storm-gated" note in `docs/plans/2026-07-11-t3-ux-parity.md:1621` was fixed in
d52cd0c and is simply stale.

## The decision

**Identity, not bytes.** Detection compares `TL_ASSET` — a 12-hex fingerprint of
the frontend artifact's own content, stamped at deploy from the **unstamped**
source. Identical frontend → identical id → nothing happens, *by construction
rather than by policy*. `TL_BUILD` (the git SHA) stays exactly as it was, for
provenance and telemetry: the two were one overloaded field and are now two.

Rejected: **ttyd's ETag** — verified to be size+mtime, not content
(`etag: "c96bb-6a719a13"` = 825019 bytes / 2026-08-04 07:51:47, exactly
`stat -c '%s %Y'`), so it flips on every `install` regardless of content, and it
is a header an edge could rewrite. Rejected: **keeping the whole-body hash** —
that is the bug, and it is sensitive to anything else that varies per response.
Fingerprinting the source (not a git tree object) also catches a deploy of
uncommitted frontend edits, which `deploy.sh` has always supported.

**Zero touch.** The pill is deleted — markup, CSS, state flag, tap handler,
dismiss button. An update applies itself at a boundary that happens anyway:

| Situation | What happens |
|---|---|
| No terminal attached (pure lobby), visible | reload now |
| Back after ≥5s away — app switch, window refocus, bfcache restore | reload now ("the next open") |
| Terminal attached, visible, focused, no resume edge | **defer**, silently, indefinitely |
| Document hidden | **never navigate** — wait for the open |
| Same asset id | nothing at all |

Deleting the UI deletes three of the defects outright: no card means no
unclosable card and no stacking; no `updatePending` means no gate to reopen early
and no `✕` that silently disarms the healer; and comparing a constant identity
instead of a mutable baseline makes idempotency structural rather than a fix that
can regress.

**Confirmation, not fire-and-forget.** Before navigating, the healer writes
`tl-update = {target, from, at, n}` to sessionStorage. At the next boot it reads
it back: target reached → clear it and emit `app.reloaded {tl.reason:"update",
tl.from, tl.to}`; not reached → keep the count, and at 3 attempts emit
`app.update_failed` **once** and go quiet for that target instead of thrashing.
v1 previously emitted nothing on this path at all (`grep -c app.reloaded
frontend/index.html` → 0; 30 days of journal → 0 events), which is why "the user
tapped and it failed" and "the user ignored it" were indistinguishable.

Accepted trade-offs, stated plainly:

- **A desktop tab left visible, focused and attached forever never
  self-updates** (Viktor's call, 2026-08-04: no idle-timeout reload while
  visible+focused — an earlier iteration's idle signal flashed readers
  mid-session). Escape hatches are ordinary: any tab switch, any window blur past
  5s, or closing the session back to the lobby.
- **A backend-only deploy that genuinely requires clients to refresh no longer
  triggers one.** If that ever comes up, touch the frontend — the fingerprint
  follows content, deliberately.
- **No user-visible signal remains when an update cannot land.** That failure is
  now reported to telemetry (`app.update_failed`) instead of to the user.

## Keeping the three copies honest

The policy exists three times: `frontend-v2/src/deploy/healer.logic.ts` and
inline in `frontend/index.html` + `frontend/term.html` (v1 has no build step, so
no test harness of its own). That duplication is *why* they drifted — v2 cleared
its state before reloading, v1 never did, and only v1 is the daily driver. The v1
kernel is now bracketed by `// >>> tl-update-kernel` / `// <<< tl-update-kernel`
sentinels, and `frontend-v2/test/healer.parity.test.ts` slices it out of the
shipped HTML, runs it in a `node:vm` context, and puts it through the same case
table as the v2 unit tests — plus text guards that the deleted machinery stays
deleted. Edit one implementation and not the other and the suite goes red.

Real de-duplication means giving v1 a build step, which is a larger decision than
this bug warranted.
