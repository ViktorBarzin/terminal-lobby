# Session images persist in a per-user store served back as a gallery

Goal (Viktor, 2026-07-08): pasted and displayed images must persist per
session and be re-viewable from a gallery — an image pasted into a
session, or rendered with `show-image`, should still be openable from
that session's web view days later, not evaporate from `/tmp`.

Five decisions were interview-locked:

1. **What persists** — clipboard pastes/uploads, drag-dropped images
   (the frontend routes any dropped `image/*` file onto the same
   `image` upload field as a paste) AND `show-image` renders
   (registered by the script itself). Only NON-image drops stay
   ephemeral transfer conveniences in `/tmp/clipboard-files`: they are
   arbitrary file handoffs into a shell command, not gallery content.
2. **Where** — `/var/lib/clipboard-store/<osUser>/<session>/` on the
   devvm's durable disk, one flat directory per (OS user, session).
   `/tmp` was the whole problem (tmpfs semantics + the 7-day sweep);
   session-scoping is what makes a gallery of "this conversation's
   images" possible at all. Writes without a valid session name land
   in the literal `_unsorted` bucket.
3. **Retention** — an image lives as long as its session "exists":
   live in tmux (tmux-api `/sessions`) or still referenced by the
   user's saved sidebar layout (`/var/lib/tmux-api/layout/<user>.json`
   — the same reference that makes an OOM restore regroup it, ADR-0002).
   A dead session's directory first gets a `.deleted-at` marker and 30
   days of grace, so a restore within the window resurrects the images
   too; `_unsorted` ages out at a flat 90 days.
4. **Isolation** — enforced at the API, reusing the existing identity
   chain: Traefik forward-auth injects `X-Authentik-Username` (the
   ingress routes `/clipboard/*` through the same middleware as
   tmux-api), and clipboard-upload maps it through `/etc/ttyd-user-map`
   exactly like tmux-api does. No header → 401, unmapped user → 403,
   and `/list` + `/img` can only ever resolve inside the caller's own
   directory.
5. **Surface** — a 🖼 button in the terminal view opens an overlay
   grid (re-fetched on every open) that feeds the existing lightbox;
   `show-image` renders carry a "shown" badge. No new page, no new
   service — one button, one overlay, the lightbox we already had.

## Trust model

- **Browser routes** (`/upload` image field, `/list`, `/img`) are
  API-enforced per-user: the Authentik header is the identity, the
  user-map is the authority, and path handling is traversal-proof
  (charset-pinned session + basename, final path re-checked under the
  caller's directory).
- **`/register` is localhost-trusted**: `show-image` runs in the
  user's own shell where no forward-auth header exists, so the caller
  self-reports its OS user (`id -un`), accepted only if it appears in
  the user-map. Anything on the devvm could lie about that field —
  accepted, because on this box the OS is the real boundary anyway
  (see next point) and the worst a liar achieves is donating an image
  into someone's gallery. If the header IS present, it wins and the
  field is ignored.
- **Shell-level reads are permitted by org policy**: store files are
  mode 0644 under a 0755 tree, readable by any devvm account. That is
  deliberate — org rules already grant OS-level read across users on
  this shared workstation; the API isolation exists so the *web*
  surface (and anything that only holds an Authentik identity) stays
  per-user, not to out-restrict the OS.

## Lifecycle

```
image written ──► session alive (tmux OR saved layout)? ──► stays, marker removed
                             │ no
                             ▼
                  .deleted-at marker stamped (epoch)
                             │ 30 days pass (marker mtime)
                             ▼
                        directory rm -rf
```

`clipboard-store-clean` (daily, via the existing
`clipboard-cleanup.timer`) implements this; liveness errs toward
keeping — an unreachable tmux-api just starts/continues grace, never
deletes early. `_unsorted`: 90 days. Non-image drops: unchanged
7-day `/tmp/clipboard-files` sweep, now the final step of the same
script (dropped images ride the store lifecycle above, like pastes).

## The typed-path contract

`/upload` and `/register` respond `{"path": "<absolute path>"}` and
the frontend types that path straight into the PTY — that is how a
pasted image becomes an argument to the command being typed (and how
Claude in the session reads it). The store therefore had to be a
plain readable filesystem path, and the reply shape is load-bearing:
changing it breaks paste-to-prompt.

## Considered Options

- **Keep `/tmp` + longer sweep** — no session scoping (no gallery
  grouping), still lost on reboot/tmpfs, and retention stays
  disconnected from what the user actually cares about (the session).
- **A per-user DB / object store** — nothing else on the devvm wants
  it, and the typed-path contract wants plain files.
- **OS-enforced isolation (0700 per-user dirs, service per user)** —
  fights the org's explicit shared-workstation policy and buys nothing
  the API boundary doesn't already give the web surface.

## Consequences

- Existing `/tmp/clipboard-images` files are NOT migrated: they are
  ≤ 7-day ephemera by definition (the old sweep), so the store starts
  empty and `/tmp/clipboard-images` receives nothing new — the cleaner
  keeps sweeping it until it drains.
- A session named `_unsorted` shares its bucket with unsorted writes
  (the name matches the session charset). Accepted as harmless.
- `show-image` gained a localhost dependency on clipboard-upload, but
  strictly fire-and-forget (backgrounded curl, 5 s cap, output
  dropped): rendering never waits on, or fails with, registration.
- Deleting a session in the UI does not delete its images immediately;
  they ride the 30-day grace like any other death. Nothing in the UI
  promises otherwise.
- The store grows with living sessions; bounded by the 25 MB
  `/register` cap and upload limits, and by session lifetime — no
  global quota yet. Revisit if `du` ever says so.
