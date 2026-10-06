/* @refresh reload */
// The public-link visitor page (docs/plans/2026-10-06-public-links-design.md).
// Served at /s/ by the two link servers to people who are not signed in, so it
// carries none of the lobby: no sidebar, no API besides redeem, no settings. A
// session title, a badge and a terminal.
import "../lib/baseline-polyfills";
import { render } from "solid-js/web";
import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
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

type Phase = "connecting" | "open" | "ended" | "nolink";

const LinkPage: Component = () => {
  const token = pickToken(location.hash, readStored());
  if (token) keep(token);
  scrubAddressBar();

  const [title, setTitle] = createSignal("");
  const [mode, setMode] = createSignal<LinkMode | null>(null);
  const [phase, setPhase] = createSignal<Phase>(token ? "connecting" : "nolink");
  let host!: HTMLDivElement;

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

    // One redeem per connect attempt: a ticket is spent by the attach it rides
    // on, so a reconnect needs a new one. A 404 means the link has ended for
    // good, and the page stops trying rather than retrying forever.
    const prepare = async (): Promise<void> => {
      const res = await fetch(REDEEM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        credentials: "omit",
      });
      const body = await res.json().catch(() => null);
      const out = readRedeem(res.status, body);
      if (out.kind === "ended") {
        setPhase("ended");
        try {
          sessionStorage.removeItem(TOKEN_KEY);
        } catch {
          /* nothing stored */
        }
        queueMicrotask(() => attachment?.dispose());
        throw new Error("link ended");
      }
      if (out.kind === "retry") throw new Error("redeem failed");
      ticket = out.value.ticket;
      setTitle(out.value.title);
      setMode(out.value.mode);
      document.title = out.value.title ? `${out.value.title} · shared terminal` : "Shared terminal";
      if (baseFor(out.value.mode) !== base) {
        // The mode decides which server attaches; the first answer sets it.
        base = baseFor(out.value.mode);
        deps.base = base;
      }
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
      watch: () => mode() !== "rw",
    };
    attachment = attach(deps);
    term.onData((d) => attachment?.send(d));
    term.onBinary((d) => attachment?.sendBinary(d));

    const refit = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      attachment?.resize();
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    onCleanup(() => {
      ro.disconnect();
      attachment?.dispose();
      term.dispose();
    });
  });

  return (
    <div class="tl-link">
      <header class="tl-link-bar">
        <span class="tl-link-title">{title() || "Shared terminal"}</span>
        <Show when={mode()}>
          {(m) => (
            <span class="tl-link-badge" classList={{ "tl-link-badge-rw": m() === "rw" }}>
              {badgeFor(m())}
            </span>
          )}
        </Show>
        <Show when={phase() === "connecting" && token}>
          <span class="tl-link-status">Connecting…</span>
        </Show>
      </header>
      <Show when={phase() === "ended" || phase() === "nolink"}>
        <div class="tl-link-ended" role="status">
          <Show when={phase() === "ended"} fallback={<p>This page needs the full link you were sent.</p>}>
            <p>This link has ended. It expired, was revoked, or its session finished.</p>
          </Show>
          <p class="tl-link-hint">Ask whoever shared it for a new one.</p>
        </div>
      </Show>
      <div class="tl-link-term" ref={host} classList={{ "tl-link-term-gone": phase() === "ended" }} />
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
