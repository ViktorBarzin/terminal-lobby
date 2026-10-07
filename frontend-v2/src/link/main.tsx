/* @refresh reload */
// The public-link visitor page (docs/plans/2026-10-06-public-links-design.md,
// ADR-0041). Served at /s/ to people who are not signed in, so it carries none
// of the lobby: a session title, whether it is live or finished, and the
// conversation, read-only. No terminal: links share the conversation.
import "../lib/baseline-polyfills";
import { render } from "solid-js/web";
import { createSignal, onMount, Show, type Component } from "solid-js";
import "../theme/theme.css";
import "./link.css";
import Transcript from "./Transcript";
import { pickToken, readRedeem, REDEEM_URL, TOKEN_KEY } from "./link.logic";

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

function forget(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing stored */
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

type Phase = "loading" | "reading" | "gone" | "nolink";

const LinkPage: Component = () => {
  const token = pickToken(location.hash, readStored());
  if (token) keep(token);
  scrubAddressBar();

  const [phase, setPhase] = createSignal<Phase>(token ? "loading" : "nolink");
  const [link, setLink] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [live, setLive] = createSignal(true);

  const showTitle = (t: string): void => {
    setTitle(t);
    document.title = t ? `${t} · shared conversation` : "Shared conversation";
  };
  const gone = (): void => {
    forget();
    setPhase("gone");
  };

  onMount(async () => {
    if (!token) return;
    // Redeem until it answers: a phone coming back online, or a deploy
    // restarting tmux-api, is a moment to wait out, not an ended link.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(REDEEM_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          // same-origin, not omit: the answer sets the view cookie the read
          // routes take, and an omit fetch drops Set-Cookie.
          credentials: "same-origin",
        });
        const out = readRedeem(res.status, await res.json().catch(() => null));
        if (out.kind === "gone") return gone();
        if (out.kind === "ok") {
          showTitle(out.value.title);
          setLive(out.value.endedAt === 0);
          setLink(out.value.link);
          setPhase("reading");
          return;
        }
      } catch {
        /* offline; the wait below covers it */
      }
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
    }
  });

  return (
    <div class="tl-visit">
      <header class="tl-visit-bar">
        <span class="tl-visit-title">{title() || "Shared conversation"}</span>
        <Show when={phase() === "reading"}>
          <span class="tl-visit-badge" classList={{ "tl-visit-badge-live": live() }}>
            {live() ? "Live" : "Ended"}
          </span>
          <span class="tl-visit-status">Read-only</span>
        </Show>
      </header>
      <Show when={phase() === "gone" || phase() === "nolink"}>
        <div class="tl-visit-ended" role="status">
          <Show
            when={phase() === "gone"}
            fallback={<p>This page needs the full link you were sent.</p>}
          >
            <p>This link has ended. It expired or was revoked.</p>
          </Show>
          <p class="tl-visit-hint">Ask whoever shared it for a new one.</p>
        </div>
      </Show>
      <Show when={phase() === "reading" && link()}>
        {(l) => <Transcript link={l()} onGone={gone} onLive={setLive} onTitle={showTitle} />}
      </Show>
      <Show when={phase() === "loading"}>
        <p class="tl-visit-note tl-visit-loading">Opening the conversation…</p>
      </Show>
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
