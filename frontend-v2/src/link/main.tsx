/* @refresh reload */
// The public-link visitor page (docs/plans/2026-10-06-public-links-design.md).
// Served at /s/ by the two link servers to people who are not signed in, so it
// carries none of the lobby: no sidebar, no API besides the link's own, no
// settings. A session title, a badge and a terminal, and once the session has
// ended its conversation, read-only (ADR-0040).
import "../lib/baseline-polyfills";
import { render } from "solid-js/web";
import { createSignal, lazy, onCleanup, onMount, Show, Suspense, type Component } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "../theme/theme.css";
import "./link.css";
import { attach, type Attachment } from "../terminal/attach";
import { toXtermTheme } from "../terminal/theme";
import type { LadderState } from "../terminal/reconnect";
import {
  argsFor,
  badgeFor,
  baseFor,
  fontToFit,
  pickToken,
  readRedeem,
  REDEEM_URL,
  TOKEN_KEY,
  type LinkMode,
} from "./link.logic";

function readStored(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function keep(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode: a reload will need the original link, which is fine */
  }
}

/**
 * Take the token off the address bar, so it is not left in history, synced
 * across devices, or read off the screen. It stays in this tab's
 * sessionStorage for a reload.
 */
function scrubAddressBar(): void {
  if (!location.hash) return;
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    /* an old engine without replaceState keeps the hash; nothing breaks */
  }
}

type Phase = "connecting" | "open" | "ended" | "nolink" | "transcript";

// The transcript view pulls in the markdown renderer, so it loads only when a
// link turns out to be an ended session.
const Transcript = lazy(() => import("./Transcript"));

async function redeem(token: string, peek: boolean): Promise<{ status: number; body: unknown }> {
  const res = await fetch(REDEEM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(peek ? { token, peek: true } : { token }),
    // same-origin, not omit: for an ended link the answer sets the view
    // cookie the transcript routes read, and an omit fetch drops Set-Cookie.
    credentials: "same-origin",
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const LinkPage: Component = () => {
  const token = pickToken(location.hash, readStored());
  if (token) keep(token);
  scrubAddressBar();

  const [title, setTitle] = createSignal("");
  const [mode, setMode] = createSignal<LinkMode | null>(null);
  const [phase, setPhase] = createSignal<Phase>(token ? "connecting" : "nolink");
  const [ended, setEnded] = createSignal("");
  let host!: HTMLDivElement;
  let stopTerminal = (): void => {};

  /** The session has ended: stop the terminal, make sure this browser holds
   *  the link's view cookie, and show the conversation. */
  const showTranscript = async (link: string, title: string): Promise<void> => {
    if (phase() === "transcript") return;
    stopTerminal();
    setTitle(title);
    document.title = title ? `${title} · shared conversation` : "Shared conversation";
    const { status, body } = await redeem(token, false);
    const out = readRedeem(status, body);
    if (out.kind !== "transcript") return void setPhase("ended");
    setEnded(link);
    setPhase("transcript");
  };

  onMount(() => {
    if (!token) return;
    const css = getComputedStyle(document.body);
    const term = new Terminal({
      cursorInactiveStyle: "outline",
      fontFamily: css.getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 14,
      theme: toXtermTheme((name) => css.getPropertyValue(name).trim()),
      minimumContrastRatio: 4.5,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    let ticket = "";
    let attachment: Attachment | null = null;
    let base = "/s";
    // The session's window, for a watcher. 0 until the first answer.
    let grid = { cols: 0, rows: 0 };
    const watching = (): boolean => mode() !== "rw";

    stopTerminal = () => {
      window.clearInterval(poll);
      attachment?.dispose();
      attachment = null;
    };

    const end = (): void => {
      setPhase("ended");
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        /* nothing stored */
      }
      queueMicrotask(() => attachment?.dispose());
    };

    // One redeem per connect attempt: a ticket is spent by the attach it rides
    // on, so a reconnect needs a new one. A 404 means the link has ended for
    // good, and the page stops trying rather than retrying forever.
    const prepare = async (): Promise<void> => {
      const { status, body } = await redeem(token, false);
      const out = readRedeem(status, body);
      if (out.kind === "transcript") {
        queueMicrotask(() => void showTranscript(out.value.link, out.value.title));
        throw new Error("the session has ended");
      }
      if (out.kind === "ended") {
        end();
        throw new Error("link ended");
      }
      if (out.kind === "retry") throw new Error("redeem failed");
      ticket = out.value.ticket;
      grid = { cols: out.value.cols, rows: out.value.rows };
      setTitle(out.value.title);
      setMode(out.value.mode);
      document.title = out.value.title ? `${out.value.title} · shared terminal` : "Shared terminal";
      if (baseFor(out.value.mode) !== base) {
        // The mode decides which server attaches; the first answer sets it.
        base = baseFor(out.value.mode);
        deps.base = base;
      }
      refit();
    };

    const deps = {
      base,
      get args() {
        return argsFor(ticket);
      },
      prepare,
      write: (b: Uint8Array) => term.write(b),
      size: () => ({ cols: term.cols, rows: term.rows }),
      onPhase: (p: LadderState["phase"]) => {
        if (phase() === "ended") return;
        if (p === "open") setPhase("open");
        else if (p === "ended") setPhase("ended");
        else setPhase("connecting");
      },
      // A watcher's keystrokes go nowhere (ttyd-link-ro takes no input), so
      // the attachment drops them here too rather than holding them for a
      // replay that cannot happen.
      watch: watching,
    };
    attachment = attach(deps);
    term.onData((d) => attachment?.send(d));
    term.onBinary((d) => attachment?.sendBinary(d));

    // One cell's width over the font size, from the real face, so the fit is
    // right for whatever monospace actually loaded.
    const cellRatio = (): number => {
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) return 0.6;
      ctx.font = `100px ${term.options.fontFamily ?? "monospace"}`;
      return ctx.measureText("M").width / 100 || 0.6;
    };

    // A driver sizes the window to its screen, like any read-write client. A
    // watcher is drawn at the window's size with the font scaled to fit, so a
    // phone sees the whole window rather than its left edge.
    function refit(): void {
      if (watching() && grid.cols > 0 && grid.rows > 0) {
        const size = fontToFit(host.clientWidth - 8, grid.cols, cellRatio());
        if (term.options.fontSize !== size) term.options.fontSize = size;
        if (term.cols !== grid.cols || term.rows !== grid.rows) term.resize(grid.cols, grid.rows);
        return;
      }
      try {
        fit.fit();
      } catch {
        return;
      }
      attachment?.resize();
    }
    refit();
    const ro = new ResizeObserver(() => refit());
    ro.observe(host);

    // A watcher's window moves when the owner resizes, and nothing on the
    // socket says so. A peek mints no ticket, so polling costs one small
    // request; it also notices a link that ended while its socket stayed up.
    //
    // A driver polls too, for the second reason: when the session is killed
    // the page should move to the transcript rather than sit on a dead socket.
    const poll = window.setInterval(async () => {
      if (phase() === "ended" || phase() === "transcript") return;
      try {
        const { status, body } = await redeem(token, true);
        const out = readRedeem(status, body, true);
        if (out.kind === "ended") return end();
        if (out.kind === "transcript") return void showTranscript(out.value.link, out.value.title);
        if (out.kind !== "ok" || !watching()) return;
        grid = { cols: out.value.cols, rows: out.value.rows };
        refit();
      } catch {
        /* the next tick asks again */
      }
    }, 5000);

    onCleanup(() => {
      stopTerminal();
      ro.disconnect();
      term.dispose();
    });
  });

  return (
    <div class="tl-visit">
      <header class="tl-visit-bar">
        <span class="tl-visit-title">{title() || "Shared terminal"}</span>
        <Show when={phase() !== "ended" && phase() !== "transcript" && mode()}>
          {(m) => (
            <span class="tl-visit-badge" classList={{ "tl-visit-badge-rw": m() === "rw" }}>
              {badgeFor(m())}
            </span>
          )}
        </Show>
        <Show when={phase() === "transcript"}>
          <span class="tl-visit-badge">Read-only</span>
        </Show>
        <Show when={phase() === "connecting" && token}>
          <span class="tl-visit-status">Connecting…</span>
        </Show>
      </header>
      <Show when={phase() === "ended" || phase() === "nolink"}>
        <div class="tl-visit-ended" role="status">
          <Show
            when={phase() === "ended"}
            fallback={<p>This page needs the full link you were sent.</p>}
          >
            <p>This link has ended. It expired, was revoked, or its session finished.</p>
          </Show>
          <p class="tl-visit-hint">Ask whoever shared it for a new one.</p>
        </div>
      </Show>
      <Show when={phase() === "transcript" && ended()}>
        {(link) => (
          <Suspense fallback={<p class="tl-visit-note">Loading the conversation…</p>}>
            <Transcript link={link()} onGone={() => setPhase("ended")} />
          </Suspense>
        )}
      </Show>
      <div
        class="tl-visit-term"
        ref={host}
        classList={{ "tl-visit-term-gone": phase() === "ended" || phase() === "transcript" }}
      />
    </div>
  );
};

// A link pasted into a tab that already has this page open is a fragment
// change, not a load, so the startup above never sees it and the token would
// stay on the address bar. Store it and start over as a fresh load would.
window.addEventListener("hashchange", () => {
  const t = pickToken(location.hash, null);
  if (!t) return;
  keep(t);
  scrubAddressBar();
  location.reload();
});

const root = document.getElementById("root");
if (root) render(() => <LinkPage />, root);
