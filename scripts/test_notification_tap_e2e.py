#!/usr/bin/env python3
"""A real browser taps a real notification, end to end.

Notification tap routing has been fixed six times since 2026-07-17 and has
regressed after every one of them. Each of those fixes was verified against a
mocked `navigator.serviceWorker` and a stubbed notification shade, and that kind
of test stayed green through all six breakages, because the thing that broke was
never the logic a mock exercises: it was the handshake between a real service
worker, a real notification and a real page.

So this suite owns no mock of the thing under test. It serves the BUILT
frontend-v2 bundle (index.html plus the same public/sw.js the Debian package
installs), registers the worker in Chromium, delivers a REAL push through
`ServiceWorker.deliverPushMessage`, takes the live Notification back out of
`self.registration.getNotifications()` and dispatches a genuine
`NotificationEvent` at the shipped handler. Then it asserts what a person would
see: the address bar and the tab title naming the session the banner was about.

The two bugs found on 2026-09-06, each with a case that fails without its fix:

  B1  When window clients exist, sw.js posts the switch and waits ACK_MS (400 ms)
      for a reply. WebKit resolves clients.matchAll() before the page can run JS
      and drops a postMessage to a waking client (WebKit bug 268797), so nobody
      answers and the handler used to return having written NO tap record. Over 7
      days of the deployed build 376 of 795 notify.stash_read reads came back
      `absent`. `test_a_frozen_lobby_still_lands_on_the_tapped_session` reproduces
      it: the page is stopped from receiving the message at all, and the next
      launch must still land on the session that was tapped.

  B2  After routing a warm tap, register.ts used to clear only the legacy `last`
      key, leaving the per-session record behind, so the next return to the
      foreground routed to that session AGAIN and pulled the reader off whatever
      they had moved to. `test_a_landed_warm_tap_is_not_replayed` reproduces it.

What is real here and what is simulated, stated plainly because the point of the
suite is that the difference matters:

  REAL   the built bundle, public/sw.js verbatim, the browser's own service
         worker registration, push delivery, the Notification object, IndexedDB,
         the page's boot and its message listener.
  SIMULATED  (1) the notification TAP, dispatched as a NotificationEvent inside
         the worker scope with `waitUntil` collected so the test can await the
         handler (headless Chromium draws no notification shade to click, and
         CDP has no "click the banner" command); (2) the return to the
         foreground, delivered as a window `focus` event, because headless
         Chromium reports every page visible and fires no visibilitychange when
         tabs change (measured 2026-09-06: switching tabs and bring_to_front
         produced zero focus, blur, pageshow or visibilitychange events); (3) the
         backend, which is a stub here rather than tmux-api; (4) in the frozen
         case only, the push-time receipt is deleted before the tap, so that the
         case can tell whether the CLICK left a record — see
         `Lobby.forget_push_receipts`.
  NOT COVERED AT ALL  iOS and WebKit. There is no Apple instrument on this
         network, so the Declarative Web Push path Apple actually runs — where
         event.data is null, the payload arrives as event.notification and
         notificationclick is never dispatched — is exercised by nothing in this
         file. What the declarative cases below DO check is that Chrome, which
         does not implement declarative push and receives the same JSON verbatim,
         still routes on the flat sibling keys.

Run: python3 -m pytest scripts/test_notification_tap_e2e.py -q
"""
from __future__ import annotations

import http.server
import json
import os
import subprocess
import threading
import time
from typing import TYPE_CHECKING, Any, Iterator

import pytest

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # a checkout without the browser driver installed
    sync_playwright = None

if TYPE_CHECKING:
    from playwright.sync_api import Browser, BrowserContext, CDPSession, Page, Worker


def _unavailable(reason: str) -> None:
    """Skip on a laptop, fail in CI.

    A skip is the honest answer where the browser or the node_modules simply are
    not installed. It is the wrong answer in CI: pytest exits 0 on a skipped
    suite, so a release gate that skips is a gate that is not there, and this
    file exists precisely because a green signal that checked nothing let six
    regressions through. GitHub Actions sets CI=true.
    """
    if os.environ.get("CI"):
        raise AssertionError(reason)
    pytest.skip(reason)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(REPO, "frontend-v2")
DIST = os.path.join(FRONTEND, "dist")

# Two opaque 12-character session ids (ADR-0019), and the titles a banner would
# actually say. The name is only an address; what the user reads is the title,
# which is why the assertions below check for the TITLE in the tab and the NAME
# in the address bar.
SESSION_A = "k7m2q9x4tp0v"
TITLE_A = "Alpha"
SESSION_B = "b3n8h1x5r2wq"
TITLE_B = "Bravo"

# How long the app gets to react to a tap. Generous: a CI runner under load is
# slower than this box, and the failure this suite exists to catch is "never",
# not "late".
REACT_MS = 8000


# --------------------------------------------------------------------------
# The bundle under test
# --------------------------------------------------------------------------

def _newest_source_mtime() -> float:
    """The newest mtime among everything `vite build` reads."""
    newest = 0.0
    roots = [os.path.join(FRONTEND, "src"), os.path.join(FRONTEND, "public")]
    files = [
        os.path.join(FRONTEND, name)
        for name in ("index.html", "vite.config.ts", "package.json")
    ]
    for root in roots:
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                files.append(os.path.join(dirpath, name))
    for path in files:
        try:
            newest = max(newest, os.path.getmtime(path))
        except OSError:
            continue
    return newest


def _ensure_bundle() -> None:
    """Build frontend-v2 into dist/ when it is missing or behind the sources.

    Rebuilt rather than assumed present: a stale dist/ would test the previous
    fix and pass, which is precisely the failure mode this suite exists to end.
    `npm ci` is deliberately NOT run here — the workflow installs dependencies in
    its own step, and a test that silently reinstalls node_modules hides which
    step is slow.
    """
    index = os.path.join(DIST, "index.html")
    if os.path.exists(index) and os.path.getmtime(index) >= _newest_source_mtime():
        return
    if not os.path.isdir(os.path.join(FRONTEND, "node_modules")):
        _unavailable("frontend-v2/node_modules is missing; run npm ci there first")
    subprocess.run(
        ["npm", "run", "build"], cwd=FRONTEND, check=True, capture_output=True, text=True
    )


# --------------------------------------------------------------------------
# The origin: the built bundle plus a stub tmux-api
# --------------------------------------------------------------------------

SESSIONS = [
    {
        "name": SESSION_A,
        "title": TITLE_A,
        "attached": 0,
        "lastActivity": 0,
        "created": 0,
        "state": "done",
    },
    {
        "name": SESSION_B,
        "title": TITLE_B,
        "attached": 0,
        "lastActivity": 0,
        "created": 0,
        "state": "running",
    },
]


class _Handler(http.server.SimpleHTTPRequestHandler):
    """dist/ as a static origin, with just enough tmux-api to boot the lobby.

    127.0.0.1 is a secure context, so the service worker registers exactly as it
    does behind the ingress. The API surface is the one the app touches on boot:
    /whoami, /sessions, /layout, /prefs, and the telemetry intake. Push
    enrolment (/push/vapid-public) answers 404 on purpose — this suite delivers
    pushes through CDP, and a live VAPID key would only add a subscribe round
    trip the app already degrades from quietly.
    """

    telemetry: list[dict[str, Any]] = []

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=DIST, **kwargs)

    def log_message(self, *args: Any) -> None:  # noqa: A003 - stdlib hook name
        pass

    def _send_json(self, obj: Any, code: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def do_POST(self) -> None:  # noqa: N802 - stdlib hook name
        body = self._read_body()
        if self.path.split("?")[0] == "/api/sessions/telemetry":
            # Kept so a failure message can say what the page and the worker
            # thought happened (notify.tap / notify.stash_read). Diagnostic
            # only: every assertion below is on what a person would see.
            try:
                doc = json.loads(body or b"{}")
                for event in doc.get("events", []):
                    _Handler.telemetry.append(
                        {"client": doc.get("client"), **event}
                    )
            except ValueError:
                pass
        self._send_json({})

    def do_PUT(self) -> None:  # noqa: N802 - stdlib hook name
        self._read_body()
        self._send_json({})

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook name
        path = self.path.split("?")[0]
        if path.startswith("/api/sessions/"):
            route = path[len("/api/sessions"):]
            if route == "/whoami":
                return self._send_json(
                    {"authentik": "qa", "osUser": "qa", "multiUser": False}
                )
            if route == "/sessions":
                return self._send_json(SESSIONS)
            if route == "/layout":
                return self._send_json(
                    {
                        "version": 1,
                        "projects": [],
                        "ungrouped": [SESSION_A, SESSION_B],
                        "ungroupedIndex": 0,
                    }
                )
            if route == "/prefs":
                return self._send_json({})
            if route.startswith("/push"):
                return self._send_json({"error": "push is off in this harness"}, 404)
            return self._send_json({})
        if path in ("/", "/index.html"):
            self.path = "/index.html"
        return super().do_GET()


@pytest.fixture(scope="session")
def origin() -> Iterator[str]:
    _ensure_bundle()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()


# --------------------------------------------------------------------------
# The push payloads, byte-shaped like the ones pushsender.go marshals
# --------------------------------------------------------------------------

def flat_payload(session: str, title: str, origin: str) -> dict[str, Any]:
    """What a subscription with no recorded origin gets, unchanged since 2026-07.

    `origin` is unused and accepted so both builders share one signature.
    """
    del origin
    return {
        "title": title,
        "body": "Claude finished its turn.",
        "tag": "tl-" + session,
        "session": session,
        "badge": 1,
        "waiting": {"a": [session], "d": []},
    }


def declarative_payload(session: str, title: str, origin: str) -> dict[str, Any]:
    """The Declarative Web Push envelope, with the flat keys still alongside.

    `mutable` is a TOP-LEVEL sibling of `notification`, and `navigate` is
    ABSOLUTE: WebKit parses that URL with no base, so a relative one is a
    SyntaxError and the whole message is dropped, banner and all. Chrome does not
    implement declarative push and receives this JSON verbatim on event.data, so
    what this shape checks HERE is that the envelope rides along without
    disturbing the flat routing every non-Apple browser uses.
    """
    return {
        "web_push": 8030,
        "mutable": True,
        "notification": {
            "title": title,
            "body": "Claude finished its turn.",
            "navigate": f"{origin}/?session={session}",
            "tag": "tl-" + session,
            "app_badge": 1,
            "data": {"session": session, "waiting": {"a": [session], "d": []}},
        },
        "title": title,
        "body": "Claude finished its turn.",
        "tag": "tl-" + session,
        "session": session,
        "badge": 1,
        "waiting": {"a": [session], "d": []},
    }


PAYLOADS = {"flat": flat_payload, "declarative": declarative_payload}


# --------------------------------------------------------------------------
# The lobby under test
# --------------------------------------------------------------------------

# Runs before any page script, in every page of the context. It wraps the
# 'message' listener the app installs on navigator.serviceWorker so a test can
# stop the switch message reaching it, which is what an iPhone does on its own:
# the page is not running JS when the worker posts, and WebKit drops the message
# rather than queueing it (bug 268797). The app's own handler is untouched and
# runs verbatim whenever the flag is off.
_DROP_SW_MESSAGES = """
window.__tlDropSwMessages = false;
(() => {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  const add = sw.addEventListener.bind(sw);
  sw.addEventListener = (type, fn, opts) => {
    if (type !== 'message' || typeof fn !== 'function') return add(type, fn, opts);
    return add(type, (ev) => {
      if (window.__tlDropSwMessages) return;
      fn(ev);
    }, opts);
  };
})();
"""

# Takes the live Notification back out of the shade and dispatches a real
# NotificationEvent at the shipped handler.
#
# `waitUntil` is collected rather than called: a script-dispatched ExtendableEvent
# is untrusted, so the browser's own waitUntil would throw InvalidStateError, and
# the test would be measuring the shim instead of the handler. Everything else —
# the Notification, the registration, the clients, IndexedDB — is the browser's.
_CLICK_NOTIFICATION = """
async (tag) => {
  const open = await self.registration.getNotifications();
  const n = open.find((x) => x.tag === tag);
  if (!n) return { clicked: false, tags: open.map((x) => x.tag) };
  const ev = new NotificationEvent('notificationclick', { notification: n });
  const waits = [];
  ev.waitUntil = (p) => { waits.push(p); };
  self.dispatchEvent(ev);
  await Promise.all(waits);
  return { clicked: true, tags: open.map((x) => x.tag) };
}
"""


class Lobby:
    """One browser context with the lobby open, and the levers a tap needs."""

    def __init__(
        self,
        context: BrowserContext,
        page: Page,
        cdp: CDPSession,
        registration_id: str,
        origin: str,
    ):
        self.context = context
        self.page = page
        self.cdp = cdp
        self.registration_id = registration_id
        self.origin = origin

    # -- the worker -------------------------------------------------------
    def worker(self) -> Worker:
        """The live service worker, re-read each time.

        The browser may stop and restart the worker between a push and a click,
        and a stopped worker's handle is dead, so nothing here caches one.
        """
        self.page.wait_for_function(
            "() => navigator.serviceWorker.getRegistration()"
            ".then((r) => !!(r && r.active))"
        )
        for worker in reversed(self.context.service_workers):
            if worker.url.endswith("/sw.js"):
                return worker
        raise AssertionError("no service worker attached to the context")

    def shade(self) -> list[str]:
        """The tags in the shade, asked of the WORKER'S OWN registration.

        Asked here and not from the page on purpose: the click is dispatched in
        the worker scope, so the worker's answer is the one that decides whether
        there is anything to click. An earlier version waited on the PAGE's
        answer instead and 2 or 3 of the 8 cases failed per run, with the worker
        reporting an empty shade a moment after the page had reported the banner
        (measured 2026-09-06). Whichever way round the two views settle, asking
        the scope that does the clicking removes the gap.
        """
        return list(
            self.worker().evaluate(
                "() => self.registration.getNotifications()"
                ".then((list) => list.map((n) => n.tag))"
            )
        )

    def _wait_for_banner(self, tag: str) -> None:
        deadline = time.monotonic() + REACT_MS / 1000
        while True:
            if tag in self.shade():
                return
            if time.monotonic() > deadline:
                raise AssertionError(
                    f"no notification tagged {tag} after {REACT_MS} ms; "
                    f"the shade holds {self.shade()}, telemetry: {self.telemetry()}"
                )
            self.page.wait_for_timeout(100)

    def deliver_push(self, session: str, title: str, shape: str) -> None:
        """A real push, through the browser's own push plumbing."""
        payload = PAYLOADS[shape](session, title, self.origin)
        self.cdp.send(
            "ServiceWorker.deliverPushMessage",
            {
                "origin": self.origin,
                "registrationId": self.registration_id,
                "data": json.dumps(payload),
            },
        )
        # The banner is the proof the push landed and the handoff for the click.
        self._wait_for_banner("tl-" + session)

    def click(self, session: str) -> None:
        tag = "tl-" + session
        self._wait_for_banner(tag)
        result = self.worker().evaluate(_CLICK_NOTIFICATION, tag)
        assert result["clicked"], (
            f"no notification tagged {tag} in the shade; found {result['tags']}"
        )

    # -- the page ---------------------------------------------------------
    def open_session(self, title: str) -> None:
        """Pick a session the way a person does: tap its card."""
        self.page.get_by_text(title, exact=True).first.click()
        self.page.wait_for_timeout(200)

    def foreground(self) -> None:
        """Return the app to the foreground.

        Delivered as a window `focus` event because headless Chromium reports
        every page visible and fires nothing of its own when tabs change
        (measured 2026-09-06). The listener that runs is the shipped one; only
        the platform's decision to fire is simulated.
        """
        self.page.evaluate("window.dispatchEvent(new Event('focus'))")

    def cold_launch(self) -> None:
        """What a killed PWA does: load start_url, carrying no session at all.

        Away and back, rather than straight to `/`. Going from `/#<session>` to
        `/` differs only in the fragment, which is a SAME-DOCUMENT navigation:
        the app would never re-boot and the case would be testing the wake path
        again under another name.
        """
        self.page.goto("about:blank")
        self.page.goto(self.origin + "/")
        self.page.wait_for_function("() => !document.getElementById('tl-shell')")

    def forget_push_receipts(self) -> None:
        """Empty the tap stash, so only a record written LATER can route.

        sw.js writes a receipt for every push it shows (tapped: false), and a
        receipt on its own routes for two minutes (RECEIPT_FRESH_MS). Left in
        place it would land the launch on a session whether or not the click
        handler left any trace, which is precisely the bug B1 is about. Clearing
        it here is the only way to ask the question the case exists to ask: did
        the TAP leave a record?
        """
        cleared = self.page.evaluate(
            """() => new Promise((resolve) => {
                 const req = indexedDB.open('tl-notif', 1);
                 req.onupgradeneeded = () => {
                   try { req.result.createObjectStore('pending'); } catch (e) {}
                 };
                 req.onerror = () => resolve(false);
                 req.onsuccess = () => {
                   const db = req.result;
                   try {
                     const tx = db.transaction('pending', 'readwrite');
                     tx.objectStore('pending').clear();
                     const done = (ok) => { try { db.close(); } catch (e) {} resolve(ok); };
                     tx.oncomplete = () => done(true);
                     tx.onerror = () => done(false);
                     tx.onabort = () => done(false);
                   } catch (e) { resolve(false); }
                 };
               })"""
        )
        assert cleared, "could not clear the tap stash"

    # -- what a person would see ------------------------------------------
    def wait_until_showing(self, session: str, title: str) -> None:
        self.page.wait_for_function(
            "(s) => location.hash === '#' + s", arg=session, timeout=REACT_MS
        )
        assert title in self.page.title(), (
            f"address bar says {session} but the tab title is "
            f"{self.page.title()!r}; telemetry: {self.telemetry()}"
        )

    def showing(self) -> str:
        return str(self.page.evaluate("location.hash"))

    def settle(self) -> None:
        """Give any pending routing a chance to happen before asserting it did NOT.

        A negative assertion needs a wait or it passes for the wrong reason. The
        wake path is one IndexedDB read plus one getNotifications, so this is
        several times what it costs.
        """
        self.page.wait_for_timeout(1200)

    def telemetry(self) -> list[dict[str, Any]]:
        return [
            {"name": e.get("name"), **e.get("attrs", {})} for e in _Handler.telemetry
        ]


# MODULE scope, not session: Playwright must be torn down before pytest moves
# on to another file. Its sync API drives an asyncio loop on a greenlet and
# leaves it installed and RUNNING as the thread's current loop for as long as
# it is up; pytest-asyncio's per-test event_loop fixture then closes that loop
# and raises "Cannot close a running event loop" on every async test after it.
# Measured 2026-09-06: this file alone 8 passed, test_qa_harness.py alone 110
# passed, and `pytest scripts/` together 8 failed with 7 teardown errors, all of
# them in the other file. CI runs the two in separate steps and would never
# have shown it. One module here means one browser either way, so the scope
# costs nothing.
@pytest.fixture(scope="module")
def browser() -> Iterator[Browser]:
    if sync_playwright is None:
        _unavailable("playwright is not installed")
    with sync_playwright() as pw:
        # channel="chromium" is load-bearing, not a preference. The default
        # headless build is chromium-headless-shell, which refuses the
        # notifications permission outright: measured 2026-09-06,
        # Notification.permission read "denied" in both the page and the worker
        # after grant_permissions, and showNotification threw "No notification
        # permission has been granted for this origin". The full Chromium in new
        # headless mode grants it and keeps a real shade.
        instance = pw.chromium.launch(channel="chromium")
        try:
            yield instance
        finally:
            instance.close()


@pytest.fixture()
def lobby(browser: Browser, origin: str) -> Iterator[Lobby]:
    _Handler.telemetry.clear()
    context = browser.new_context(base_url=origin)
    context.grant_permissions(["notifications"])
    context.add_init_script(_DROP_SW_MESSAGES)
    page = context.new_page()
    page.goto(origin + "/")
    # The app has mounted when it removes its own first-paint skeleton.
    page.wait_for_function("() => !document.getElementById('tl-shell')")
    page.wait_for_function(
        "() => navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active))"
    )
    cdp = context.new_cdp_session(page)
    registrations: list[dict[str, Any]] = []
    cdp.on(
        "ServiceWorker.workerRegistrationUpdated",
        lambda params: registrations.extend(params["registrations"]),
    )
    cdp.send("ServiceWorker.enable")
    page.wait_for_timeout(300)
    live = [r for r in registrations if not r.get("isDeleted")]
    assert live, "CDP reported no service worker registration for the origin"
    try:
        yield Lobby(context, page, cdp, live[0]["registrationId"], origin)
    finally:
        context.close()


# --------------------------------------------------------------------------
# The cases
# --------------------------------------------------------------------------

@pytest.mark.parametrize("shape", list(PAYLOADS))
def test_a_warm_tap_switches_the_app_to_the_notified_session(lobby: Lobby, shape: str) -> None:
    """The path that works: a lobby is open, answers the switch, and moves."""
    lobby.deliver_push(SESSION_A, TITLE_A, shape)
    lobby.click(SESSION_A)
    lobby.wait_until_showing(SESSION_A, TITLE_A)


@pytest.mark.parametrize("shape", list(PAYLOADS))
def test_a_tap_moves_the_app_off_the_session_on_screen(lobby: Lobby, shape: str) -> None:
    """A tap for A while B is on screen lands on A.

    The original resident-PWA bug was a tap that FOCUSED the app and left it on
    whatever it was already showing, so the case has to start somewhere else.
    """
    lobby.open_session(TITLE_B)
    assert lobby.showing() == "#" + SESSION_B

    lobby.deliver_push(SESSION_A, TITLE_A, shape)
    lobby.click(SESSION_A)
    lobby.wait_until_showing(SESSION_A, TITLE_A)


def test_a_landed_warm_tap_is_not_replayed(lobby: Lobby) -> None:
    """B2: a tap that ALREADY routed must not route a second time.

    The worker writes a per-session record on every click now, so the page has to
    consume the one it acted on. Clearing only the legacy `last` key left the
    real row behind, and the next return to the foreground read it, called it a
    tap, and pulled the reader off the session they had moved to.
    """
    lobby.deliver_push(SESSION_A, TITLE_A, "flat")
    lobby.click(SESSION_A)
    lobby.wait_until_showing(SESSION_A, TITLE_A)

    # The reader moves on, by hand.
    lobby.open_session(TITLE_B)
    assert lobby.showing() == "#" + SESSION_B

    lobby.foreground()
    lobby.settle()
    assert lobby.showing() == "#" + SESSION_B, (
        "the app was pulled back to the tapped session on the next foreground; "
        f"telemetry: {lobby.telemetry()}"
    )


@pytest.mark.parametrize("wake", ["foreground", "cold launch"])
def test_a_frozen_lobby_still_lands_on_the_tapped_session(lobby: Lobby, wake: str) -> None:
    """B1: nobody answers the switch, and the tap must survive anyway.

    The lobby is stopped from receiving the switch message at all, which is what
    an iPhone does on its own. The worker posts into silence, ACK_MS elapses, and
    the only thing left of the tap is the record the click handler writes.

    The push-time receipt is cleared before the tap so this cannot pass for the
    wrong reason: a receipt routes on its own for two minutes, so with one left
    in place the app would land on the session whether the click wrote anything
    or not. Verified against a build with the write removed, 2026-09-06: both
    wake shapes go red.
    """
    lobby.open_session(TITLE_B)
    lobby.deliver_push(SESSION_A, TITLE_A, "flat")
    lobby.forget_push_receipts()

    lobby.page.evaluate("window.__tlDropSwMessages = true")
    lobby.click(SESSION_A)
    lobby.settle()
    assert lobby.showing() == "#" + SESSION_B, (
        "the page acted on the switch message, so this case is not testing the "
        "frozen path any more"
    )

    if wake == "foreground":
        lobby.foreground()
    else:
        lobby.cold_launch()
    lobby.wait_until_showing(SESSION_A, TITLE_A)


def test_a_session_less_test_push_never_switches_session(lobby: Lobby) -> None:
    """The /push/test diagnostic focuses the app and must not move it.

    It carries session "" precisely so a test push cannot conjure a session, and
    the handler must not default to one either.
    """
    lobby.open_session(TITLE_B)
    lobby.cdp.send(
        "ServiceWorker.deliverPushMessage",
        {
            "origin": lobby.origin,
            "registrationId": lobby.registration_id,
            "data": json.dumps(
                {
                    "title": "Test notification",
                    "body": "If you can read this, push delivery works on this device.",
                    "tag": "tl-test",
                    "session": "",
                }
            ),
        },
    )
    lobby.page.wait_for_function(
        "() => navigator.serviceWorker.getRegistration()"
        ".then((r) => r.getNotifications())"
        ".then((list) => list.some((n) => n.tag === 'tl-test'))",
        timeout=REACT_MS,
    )
    lobby.worker().evaluate(_CLICK_NOTIFICATION, "tl-test")
    lobby.settle()
    assert lobby.showing() == "#" + SESSION_B, (
        f"a session-less test push moved the app; telemetry: {lobby.telemetry()}"
    )

    # And it leaves nothing behind for a later launch to route on.
    lobby.foreground()
    lobby.settle()
    assert lobby.showing() == "#" + SESSION_B
