# The session browser runs headed and presses Cloudflare checkboxes

Status: accepted 2026-11-15. Amends
[ADR-0035](0035-each-session-gets-its-own-browser-started-on-first-use.md).

Viktor asked for the agent's own browser to stop being blocked by Cloudflare.
The session browser ran headless Chrome, and Cloudflare Turnstile (the
"Verify you are human" checkbox) rejects headless Chrome with error 600010.
Measured on the devvm on 2026-11-15 against `turnstile-lab.viktorbarzin.me`:
headless Chrome 148 and chrome-headless-shell 157 failed every run, with a
normal user agent and with the stealth patches the cluster browser uses. The
same Chrome headed under Xvfb passed.

## What we decided

| Question | Decision |
|---|---|
| Headed or headless | Headed, on an Xvfb the host starts for its own browser (`lib/display.mjs`). `TL_BROWSER_HEADLESS=1` asks for headless. A box without Xvfb falls back to headless and logs it |
| Xvfb's life | Started with the browser, stopped on close, frozen with Chrome (stopped last, thawed first). `-terminate` ends it when Chrome goes, so a host killed outright leaves none behind. `-displayfd` picks a free display, so hosts never race for one |
| Automation markers | Chrome starts without Playwright's `--enable-automation` and with `AutomationControlled` disabled. With them, `navigator.webdriver` is true and Turnstile failed 2 of 2 runs |
| The cursor binding | A CDP `Runtime.addBinding` on each page's own session, not Playwright's `exposeBinding`. That one lands in every frame, Cloudflare's included, and Turnstile failed 2 of 2 runs with it. A page's session reaches no cross-origin frame, and the cursor script never reported from those anyway |
| Pressing the checkbox | The host watches every page for a `challenges.cloudflare.com` frame (`lib/turnstile.mjs`). It finds the checkbox through the frame's own CDP session (`DOM.getDocument` with `pierce`, because the checkbox is in a closed shadow root), focuses it and presses Space. A mouse click passed 1 of 2 runs; the key press passed every run |
| The agent meanwhile | Its next tool call waits for the press, up to 50 s (`hold` in `lib/gate.mjs`). An agent snapshot taken during the challenge broke 1 of 3 runs; with the wait, 5 of 5 passed |
| Library | `playwright-core`, kept. `patchright-core` hides more of Playwright and passed the full-page check below, but it also stops every console message and page error reaching the agent, which `browser_console_messages` and debugging depend on |

## Consequences

- Turnstile widgets on a site's own pages pass without the agent doing
  anything: 5 of 5 visits to the lab through the real host over MCP, where
  the host before this change passed 0 of 2.
- The full-page "Just a moment..." check still fails here: on
  `scrapingcourse.com/cloudflare-challenge` Cloudflare spins and never shows
  a checkbox to plain Playwright. The `homelab browser` pool, which runs
  patchright, passes that page, so it stays the escalation for it.
- Each browser costs about 40 MB more Chrome memory than headless on a news
  page (532 MB against 494 MB), plus the Xvfb process.
- The package recommends `xvfb`.
