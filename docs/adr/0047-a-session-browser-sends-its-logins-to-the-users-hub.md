# A session browser sends its logins to the user's hub

Status: accepted 2026-11-08. Extends
[ADR-0035](0035-each-session-gets-its-own-browser-started-on-first-use.md).

A session browser starts with the user's cookies from
`~/.cache/playwright-shared-storage-state.json`, which an hourly job copies
from the cluster. Until now that was one-way: a login made inside a session
browser (Viktor typing an SMS code while in control, say) lived only as long as
that browser and reached no other browser of his.

Each devvm user can now have a **hub**: a cluster Chrome that holds that
user's logins and merges what its clients send. The hub is built separately,
in infra; this record covers the session browser's side, which is a client of
the hub's interface.

## What we decided

| Question | Decision |
|---|---|
| Who pushes | The browser host (`tl-browser/host/lib/cookiepush.mjs`), in the session's own process, as the user |
| Where to | The hub named in `~/.config/chrome-hub/hub.json`: `POST cookies_url` with the write token, `source: "tl-browser"` |
| No hub | No `hub.json`, or one that cannot be read or lacks a URL or token: nothing is read, sent or logged |
| When | Just before the browser freezes; every 5 minutes while it is live (`TL_BROWSER_COOKIE_PUSH_MS`); once more on close, best effort |
| Never | While the browser is frozen. Freezing is SIGSTOP of Chrome, so any call into the browser would hang until it woke |
| Which cookies | Persistent and unexpired (`expires > now`), and not for `viktorbarzin.me` or its subdomains, `*.lan`, `localhost` or `*.localhost`, or a bare IP address |
| How many | Only cookies new or changed since this session's last accepted push, keyed by name, domain, path and partition, compared on value and expiry. Nothing changed means no request |
| Size | Batches of at most 3000 cookies and about 1.9 MB, under the hub's 3000 and 2 MB limits |
| After a push | Fetch the hub's merged snapshot with the read token and replace the local snapshot file atomically (temporary file, rename, mode 0600) while holding `flock` on `<snapshot>.lock`, the lock the hourly refresh also takes |
| Failures | Logged and swallowed. A refused batch is not marked sent, so it goes again next time |
| Logs | Counts and HTTP statuses only. Never a cookie value, a token or a URL |

### Timing on close

The launcher sends SIGTERM and SIGKILLs the host 5 seconds later, and the host
already gives Chrome up to 5 seconds to close. The close push fits inside that:
the host reads the cookies first (at most 500 ms, normally a few milliseconds),
then posts them while Chrome closes, and waits for the post no longer than 4
seconds. A close usually finishes the push. When it does not, the freeze push
and the periodic pushes have already sent everything older than 5 minutes.

A browser closed while frozen sends nothing on close: it pushed on the way to
frozen, and nothing changes while Chrome is stopped.

### Why the host, and why on these moments

The host is the one process that holds the browser context, so it reads
cookies through Playwright with no second connection to Chrome. Pushing
before a freeze catches the common case (a person logs in, hands back, the
agent finishes, the browser goes idle) at the last moment Chrome can answer.
The 5-minute push covers browsers that stay busy for hours. The close push is
best effort because the shutdown budget belongs to closing Chrome cleanly.

### How it was checked

- Unit tests (`test/cookiepush.test.mjs`) against a stand-in hub: the domain
  and expiry filter, change detection including partitioned cookies, batching
  of 3500 cookies, a 500 answer retried next time, an unreachable hub, and the
  snapshot write waiting for a `flock(1)` holder.
- Integration tests (`test/integration.test.mjs`) drive real headless Chrome
  through the host: a cookie set on `.example.com` reaches the stand-in hub
  before the browser freezes, a cookie for the page's own `127.0.0.1` does
  not, the local snapshot is rewritten, and a live browser closed with SIGTERM
  sends its unsent cookies and exits inside 5 seconds.

## Open questions

- **A share guest's logins.** A person with an rw share may take control of
  the owner's session browser (ADR-0043). A login they make there is pushed to
  the owner's hub like any other. The host cannot tell the owner from a guest
  today: the viewer hello session-events sends carries a display name and
  `canControl`, and nothing that says whether the viewer is the owner. Skipping
  pushes after a guest held control would need session-events to add that to
  the hello (it already knows, in `resolveBrowserAccess`). The existing stance
  is that an rw share is already a grant to run as the owner, so this record
  does not change it, but write-back widens what a guest's actions reach.
- **Logouts.** Only cookies that exist are sent. A cookie the browser deleted
  (a logout) is not reported, so the hub keeps it until it expires or another
  client replaces it.
- **The first push of a session** sends every pushable cookie the browser was
  seeded with, since this session has sent nothing yet. The hub merges them by
  expiry, so this is extra traffic rather than a wrong result; a session could
  instead start from the seed as already sent.
