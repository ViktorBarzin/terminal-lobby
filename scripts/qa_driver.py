"""qa_driver — one isolated browser per QA agent, against the deployed dev tier.

Import this from a throwaway script; it handles the parts every sweep agent
would otherwise re-invent (and re-invent differently): an isolated chromium, the
console/pageerror/failed-request capture that turns "it looked wrong" into
evidence, `qa-*` session lifecycle, and a findings file the synthesis step can
read without parsing prose.

Isolation matters here: the Playwright MCP is a single shared browser, so a
fan-out of agents over it collides. Each QaAgent owns its own browser process
and profile, so twelve of these run at once without seeing each other.

    from qa_driver import QaAgent

    with QaAgent("timeline") as qa:
        qa.goto("/")
        qa.create_session("qa-timeline")
        qa.page.get_by_role("tab", name="Text").click()
        qa.expect_no_console_errors("after switching to Text view")

        if qa.page.locator(".tl-timeline").count() == 0:
            qa.finding(
                "Text view renders nothing for a live session",
                severity="high",
                detail="…what you saw vs expected…",
                repro=["open /", "create qa-timeline", "click the Text tab"],
            )

Artifacts land in --artifacts (default /tmp/qa-run/<area>/): findings.json,
console.log, and a PNG per finding. Sessions the agent created are killed on
exit, even on exception.

KNOWN HARNESS LIMITS — do not file these as app findings
--------------------------------------------------------
Background PUSH cannot be exercised here. Every agent runs in an incognito
browser context, and Chrome refuses `pushManager.subscribe()` there:
`AbortError: Registration failed - permission denied`, with the console note
"Chrome currently does not support the Push API in incognito mode
(crbug.com/401439)". So Settings always reads **Subscribed here: no**, and the
bell's best-effort `subscribePush()` always fails — in the harness, not in the
product. Measured 2026-08-06: the same page in a PERSISTENT profile subscribes
fine and gets a real FCM endpoint, and /api/sessions/push/vapid-public returns
200 with a real key, so neither the code nor the VAPID setup is at fault.

The driver deliberately does NOT switch to a persistent profile to buy this
back: a subscription made here is registered in wizard's REAL push store, and
the proxy guard refuses DELETE /push-subscriptions (it cannot tell a QA
endpoint from a real device), so every round would leave dead FCM endpoints the
server keeps trying to deliver to. Foreground notifications are unaffected and
DO work — `pushDelivers` is false, so the page path fires, which is the path
worth sweeping.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional

from playwright.sync_api import sync_playwright, Page, Error as PWError

HARNESS = os.environ.get("QA_HARNESS", "http://127.0.0.1:7998")
ARTIFACTS = Path(os.environ.get("QA_ARTIFACTS", "/tmp/qa-run"))
QA_NAME = re.compile(r"^qa-[A-Za-z0-9_-]{1,29}$")

# What the lobby mints for a session name (ADR-0019): 12 characters of
# Crockford base32, no i/l/o/u. Mirrors frontend-v2/src/lib/session-id.ts.
#
# Naming left the create path entirely, so the composer produces one of these
# and never a qa-* name. The harness guard admits a minted id that is not
# already a live session, which is what lets an agent drive the real
# new-session flow; this is the same shape, for the helpers below.
MINTED_NAME = re.compile(r"^[0-9a-hjkmnp-tv-z]{12}$")
MINTED_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def new_session_id() -> str:
    """A fresh session id, the way the browser mints one."""
    import secrets

    return "".join(secrets.choice(MINTED_ALPHABET) for _ in range(12))


def is_own_name(name: str) -> bool:
    """Names this harness may attach to: the qa-* namespace, or a minted id."""
    return bool(QA_NAME.match(name) or MINTED_NAME.match(name))

SEVERITIES = ("critical", "high", "medium", "low")

# The devvm has 32 cores but shares ~10 GB of free RAM with everyone's real
# sessions, and a chromium runs 200-400 MB. Agent count and browser count are
# decoupled here: however many sweep agents the workflow starts, only this many
# hold a browser at once, and the rest block in __enter__ until a slot frees.
BROWSER_SLOTS = int(os.environ.get("QA_BROWSER_SLOTS", "6"))
_SLOT_DIR = Path(os.environ.get("QA_SLOT_DIR", "/tmp/qa-browser-slots"))


class _BrowserSlot:
    """A cross-process semaphore over N lock files (agents are separate
    processes, so an in-process semaphore would not see them)."""

    def __init__(self, slots: int = BROWSER_SLOTS) -> None:
        self.slots = max(1, slots)
        self._fh = None
        _SLOT_DIR.mkdir(parents=True, exist_ok=True)

    def acquire(self, timeout: float = 900.0) -> None:
        import fcntl
        deadline = time.time() + timeout
        waited = False
        while time.time() < deadline:
            for i in range(self.slots):
                fh = open(_SLOT_DIR / f"slot-{i}", "a+")
                try:
                    fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self._fh = fh
                    if waited:
                        print(f"[qa_driver] got browser slot {i}", flush=True)
                    return
                except OSError:
                    fh.close()
            if not waited:
                print(f"[qa_driver] all {self.slots} browser slots busy, "
                      f"waiting…", flush=True)
                waited = True
            time.sleep(2.0)
        raise TimeoutError(
            f"no browser slot within {timeout:g}s (QA_BROWSER_SLOTS={self.slots})")

    def release(self) -> None:
        if self._fh:
            import fcntl
            try:
                fcntl.flock(self._fh, fcntl.LOCK_UN)
            finally:
                self._fh.close()
                self._fh = None


def _shm_args() -> list[str]:
    """Decide whether chromium should avoid /dev/shm — by measuring, not by habit.

    `--disable-dev-shm-usage` is a container workaround for the 64 MB /dev/shm
    Docker hands out. It makes chromium put its shared memory in TMPDIR
    instead. On this box that is exactly backwards: /tmp is a 2 GB tmpfs shared
    with everything else on the devvm and the fleet filled it, while /dev/shm is
    16 GB and essentially untouched. A full /tmp gave
    `net::ERR_INSUFFICIENT_RESOURCES` and `Target crashed` mid-sweep, which
    QaAgent.__exit__ then filed as bogus "sweep crashed" findings.

    So: pass the flag only when /dev/shm is genuinely too small to use.
    """
    try:
        st = os.statvfs("/dev/shm")
        free_mb = (st.f_bavail * st.f_frsize) / (1024 * 1024)
    except OSError:
        return ["--disable-dev-shm-usage"]
    return [] if free_mb >= 512 else ["--disable-dev-shm-usage"]


@dataclass
class Finding:
    area: str
    title: str
    severity: str
    detail: str
    repro: list[str] = field(default_factory=list)
    console: list[str] = field(default_factory=list)
    screenshot: Optional[str] = None
    url: Optional[str] = None
    at: float = field(default_factory=time.time)


class QaAgent:
    """One sweep area: one browser, one artifacts dir, one findings list."""

    def __init__(self, area: str, *, harness: str = HARNESS,
                 headless: bool = True, viewport: tuple[int, int] = (1440, 900),
                 artifacts: Optional[Path] = None, slow_mo: int = 0,
                 touch: bool = False) -> None:
        self.area = area
        self.harness = harness.rstrip("/")
        self.headless = headless
        self.viewport = viewport
        self.slow_mo = slow_mo
        # touch=True is what makes `(pointer: coarse)` match. Every mobile-only
        # affordance in the app is gated on that query — the soft-key row, the
        # keyboard-offset plumbing, and the phone layout flip — so a sweep that
        # only shrinks the viewport tests the DESKTOP page at 390px wide and
        # reports on a layout no phone ever sees. Sizing without touch is the
        # single easiest way to file a mobile finding that is not real.
        self.touch = touch
        self.dir = Path(artifacts or (ARTIFACTS / area))
        self.dir.mkdir(parents=True, exist_ok=True)
        self.findings: list[Finding] = []
        self.console: list[str] = []
        self.network_failures: list[str] = []
        self._created: list[str] = []
        self._pw = None
        self._browser = None
        self._context = None
        self.page: Page = None  # type: ignore[assignment]

    # ---- lifecycle --------------------------------------------------------

    def __enter__(self) -> "QaAgent":
        self._slot = _BrowserSlot()
        self._slot.acquire()
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(
            headless=self.headless, slow_mo=self.slow_mo,
            # channel="chromium" = the full browser build, still headless.
            # Playwright's DEFAULT headless build is the headless SHELL, which
            # ships no notification presenter: it pins Notification.permission
            # to "denied" no matter what is granted, while
            # navigator.permissions.query() cheerfully reports "granted". The
            # app's notification code gates on Notification.permission, so on
            # the shell the whole feature reads as dead and the bell as
            # permanently un-optable — two app bugs that do not exist.
            channel="chromium",
            args=["--no-sandbox", *_shm_args()])
        self._context = self._browser.new_context(
            viewport={"width": self.viewport[0], "height": self.viewport[1]},
            permissions=["clipboard-read", "clipboard-write"],
            base_url=self.harness,
            # is_mobile also honours the page's meta viewport, which is what
            # decides whether 390px means 390 CSS pixels or a zoomed-out 980.
            has_touch=self.touch,
            is_mobile=self.touch,
            device_scale_factor=3 if self.touch else 1,
        )
        # The lobby asks for notification permission (area 11). Granting it up
        # front keeps the prompt from eating clicks — and with the full browser
        # build above, the grant is visible to Notification.permission too.
        #
        # The clipboard pair is re-listed here on purpose. grant_permissions
        # REPLACES the granted set for the origin it names rather than adding to
        # it, so naming notifications alone revoked the clipboard grant made in
        # new_context above — and every clipboard read then failed with
        # "NotAllowedError: Read permission denied", which reads exactly like
        # the product bug a sweep would be hunting.
        self._context.grant_permissions(
            ["notifications", "clipboard-read", "clipboard-write"],
            origin=self.harness,
        )
        self.page = self._context.new_page()
        self._wire_capture(self.page)
        self._context.on("page", self._wire_capture)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is not None:
            # A crash mid-sweep is itself evidence; keep it.
            self.finding(f"sweep crashed: {exc_type.__name__}",
                         severity="medium", detail=str(exc))
        try:
            self.cleanup_sessions()
        finally:
            self.flush()
            for closer in (self._context, self._browser):
                try:
                    closer and closer.close()
                except PWError:
                    pass
            if self._pw:
                self._pw.stop()
            if getattr(self, "_slot", None):
                self._slot.release()

    def _wire_capture(self, page: Page) -> None:
        page.on("console", lambda m: self.console.append(
            f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: self.console.append(
            f"[pageerror] {e}"))
        page.on("requestfailed", lambda r: self.network_failures.append(
            f"{r.method} {r.url} — {r.failure}"))
        page.on("response", self._note_bad_response)

    def _note_bad_response(self, response) -> None:
        if response.status >= 400:
            self.network_failures.append(
                f"{response.request.method} {response.url} → {response.status}")

    # ---- navigation -------------------------------------------------------

    def goto(self, path: str = "/", *, wait: str = "networkidle") -> None:
        self.page.goto(path, wait_until="load")
        try:
            self.page.wait_for_load_state(wait, timeout=10_000)
        except PWError:
            pass  # SSE keeps the network busy forever; load is enough

    # ---- qa-* session lifecycle ------------------------------------------

    def create_session(self, name: str, *, timeout: float = 20.0) -> None:
        """Create a session by attaching its terminal, the way the app does.

        tmux-api has no create endpoint — a session is born from
        `tmux new-session -A` on the ttyd attach. So this drives the real path:
        open the LOBBY on a session that does not exist yet, in a background
        tab, and wait for tmux-api to report it.

        `/?session=<name>` is the spelling. `readInitialSelection`
        (frontend-v2/src/components/App.tsx) reads it, validates it against the
        same NAME_RE tmux-api uses, and selects it; a selected session the poll
        has never returned is what `selectedIsCreating` means, so the terminal
        attaches at once instead of waiting to be shown, and that attach is the
        `new-session -A` that births the tmux session. This is the same URL a
        stale /term.html bookmark now redirects to
        (handleTermPageRedirect, clipboard-upload/main.go).

        It WAS `/term.html?arg=<name>`, the framed terminal page, taking the
        name as ttyd's first positional arg. That page was deleted on
        2026-09-05, so the URL it created sessions through no longer exists.

        The name may be `qa-*` or a minted id (`new_session_id()`), which is
        what the new-session composer produces — the guard admits an id that is
        not already a live session. Anything else the guard refuses, so assert
        it here with a clearer message than a 403 body.
        """
        if not is_own_name(name):
            raise ValueError(
                f"{name!r} is neither a qa-* name nor a minted id; the harness "
                f"guard will refuse it (see new_session_id())")
        page = self._context.new_page()
        page.goto(f"/?session={name}", wait_until="load")
        deadline = time.time() + timeout
        while time.time() < deadline:
            if name in self.session_names():
                self._created.append(name)
                page.close()
                return
            time.sleep(0.5)
        page.close()
        raise TimeoutError(f"session {name!r} never appeared in /sessions")

    def create_session_direct(self, name: str, *, cwd: str = "/tmp",
                              command: Optional[str] = None) -> None:
        """Create the tmux session straight from the CLI, bypassing the app.

        Use this for SETUP — when an area needs a session to exist so it can
        test something else. `create_session` (the lobby attach) is the path
        under test and should stay the one areas 4 and 7 exercise; keeping setup
        off it means a sweep of some OTHER area is not blocked whenever the
        attach path regresses.

        That path does work: as of 2026-08-06 the harness authenticates the /ws
        upgrade too (before that it dialled ttyd anonymously, ttyd hung up, and
        every attach in the fleet sat at "Reconnecting…"), and it was re-pointed
        at `/?session=<name>` on 2026-09-05 when the framed terminal page it
        used to open was deleted.
        """
        if not QA_NAME.match(name):
            raise ValueError(f"{name!r} is not a qa-* name")
        argv = ["tmux", "new-session", "-d", "-s", name, "-c", cwd]
        if command:
            argv.append(command)
        import subprocess
        r = subprocess.run(argv, capture_output=True, text=True)
        if r.returncode != 0 and "duplicate session" not in r.stderr:
            raise RuntimeError(f"tmux new-session failed: {r.stderr.strip()}")
        self._created.append(name)

    def create_claude_session(self, name: str, *, cwd: str = "/tmp",
                              seed: Optional[str] = "say hello in five words",
                              settle: float = 25.0) -> None:
        """A qa-* session running a REAL Claude, so it produces a transcript.

        The Text view is rendered from Claude Code's transcript JSONL, so an
        empty session renders an empty timeline no matter how correct the code
        is. `seed` sends one short prompt to make a turn exist; pass None to
        leave the session idle.
        """
        self.create_session_direct(name, cwd=cwd, command="claude")
        import subprocess
        time.sleep(3)  # let the CLI paint its prompt before typing at it
        if seed:
            subprocess.run(["tmux", "send-keys", "-t", name, seed],
                           capture_output=True)
            time.sleep(0.5)
            subprocess.run(["tmux", "send-keys", "-t", name, "Enter"],
                           capture_output=True)
            deadline = time.time() + settle
            while time.time() < deadline:
                events = self.api(f"/events/{name}?probe=1")
                if events and not isinstance(events, dict):
                    return
                time.sleep(2.0)

    def session_names(self) -> list[str]:
        data = self.api("/api/sessions/sessions") or []
        if isinstance(data, dict):
            data = data.get("sessions", [])
        return [s.get("name", "") for s in data if isinstance(s, dict)]

    def kill_session(self, name: str) -> int:
        req = urllib.request.Request(
            f"{self.harness}/api/sessions/sessions/{name}", method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code
        except OSError:
            return 0

    def cleanup_sessions(self) -> None:
        for name in list(self._created):
            self.kill_session(name)
            self._created.remove(name)

    # ---- direct API access (for assertions the UI cannot make) ------------

    def api(self, path: str, method: str = "GET",
            body: Optional[dict] = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.harness}{path}", method=method, data=data,
            headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            return {"_status": e.code, "_body": e.read().decode(errors="replace")}
        except (OSError, ValueError) as e:
            return {"_error": str(e)}

    # ---- findings ---------------------------------------------------------

    def finding(self, title: str, *, severity: str = "medium", detail: str = "",
                repro: Optional[list[str]] = None, shoot: bool = True) -> Finding:
        if severity not in SEVERITIES:
            severity = "medium"
        shot = None
        if shoot and self.page:
            slug = re.sub(r"[^a-z0-9]+", "-", title.lower())[:60].strip("-")
            shot = str(self.dir / f"{len(self.findings):02d}-{slug}.png")
            try:
                self.page.screenshot(path=shot, full_page=True)
            except PWError:
                shot = None
        f = Finding(
            area=self.area, title=title, severity=severity, detail=detail,
            repro=repro or [], console=self.console[-25:], screenshot=shot,
            url=self.page.url if self.page else None,
        )
        self.findings.append(f)
        print(f"  FINDING [{severity}] {title}", flush=True)
        return f

    def expect_no_console_errors(self, context: str) -> None:
        """Record a finding if the page logged an error or a failed request.

        Filtered: SSE reconnects during navigation are expected noise, not bugs.
        """
        errs = [c for c in self.console
                if c.startswith(("[error]", "[pageerror]"))
                and "EventSource" not in c]
        bad = [n for n in self.network_failures if "/events/" not in n]
        if errs or bad:
            self.finding(
                f"console errors {context}",
                severity="medium",
                detail="\n".join(errs[-10:] + bad[-10:]),
            )

    def flush(self) -> None:
        (self.dir / "findings.json").write_text(
            json.dumps([asdict(f) for f in self.findings], indent=2))
        (self.dir / "console.log").write_text("\n".join(self.console))
        (self.dir / "network-failures.log").write_text(
            "\n".join(self.network_failures))
        print(f"[qa_driver] {self.area}: {len(self.findings)} finding(s) → "
              f"{self.dir}", flush=True)


DESTRUCTIVE_TMUX = {
    "kill-session", "kill-server", "kill-window", "kill-pane",
    "rename-session", "send-keys", "respawn-pane", "respawn-window",
}


def tmux(*argv: str, check: bool = True):
    """Run tmux with the same qa-* rule the proxy enforces.

    THE HARNESS GUARD IS PROXY-ONLY. It sees HTTP; it cannot see a script that
    shells out to `tmux kill-session`. On 2026-08-06 a sweep script did exactly
    that and killed a live session (`rewrite`) because the name it computed had
    been reshuffled by concurrent fleet churn — it was restored from the
    tmux-resurrect snapshot with its Claude conversation intact, but the
    scrollback did not survive.

    Route every tmux call through here. Destructive verbs must target a qa-*
    session; anything else raises before tmux runs. Read-only verbs
    (list-sessions, capture-pane, display) pass through untouched.
    """
    import subprocess
    argv = tuple(str(a) for a in argv)
    verb = argv[0] if argv else ""
    if verb in DESTRUCTIVE_TMUX:
        target = None
        for i, a in enumerate(argv):
            if a == "-t" and i + 1 < len(argv):
                target = argv[i + 1]
                break
        # A destructive verb with no -t hits the *current* session, which in a
        # fleet context is whatever happens to be attached. Never allow it.
        if target is None:
            raise PermissionError(
                f"qa_driver.tmux: refusing `tmux {verb}` with no -t target — "
                f"it would act on the current session")
        base = target.split(":", 1)[0].lstrip("=")
        if not QA_NAME.match(base):
            raise PermissionError(
                f"qa_driver.tmux: refusing `tmux {verb} -t {target}` — {base!r} "
                f"is not a qa-* session. Compute targets from names you created, "
                f"never from an index into a list the rest of the fleet is "
                f"mutating underneath you.")
    return subprocess.run(argv if argv[0] == "tmux" else ("tmux",) + argv,
                          capture_output=True, text=True,
                          check=False if not check else False)


def harness_up(harness: str = HARNESS) -> bool:
    try:
        with urllib.request.urlopen(f"{harness}/api/sessions/whoami",
                                    timeout=5) as r:
            return r.status == 200
    except OSError:
        return False
