import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { createSessionStore } from "../store/session";
import { createViewMode } from "../store/viewmode";
import {
  pendingPermissions,
  sessionWorking,
  deriveRows,
} from "./timeline.logic";
import type { PermissionDecision } from "../types/events";
import { ViewSwitch } from "./ViewSwitch";
import { TextView } from "./TextView";
import { TerminalView } from "./TerminalView";
import {
  THEMES,
  THEME_LABELS,
  setTheme,
  theme,
} from "../theme/theme";

function readSession(): string {
  try {
    const q = new URLSearchParams(window.location.search).get("session");
    if (q) return q;
  } catch {
    /* no URL */
  }
  return "demo";
}

/**
 * The two-view app shell. Both views are PERMANENTLY MOUNTED and swapped by CSS
 * visibility (never unmounted) so terminal state survives — a full-swap XOR.
 * Cmd/Ctrl-J toggles (capture phase, so a focused terminal can't swallow it).
 * An activity dot marks the Text segment when structured events land while the
 * terminal view is showing.
 */
export const App: Component = () => {
  const session = readSession();
  const store = createSessionStore(session);
  const [mode, setMode, toggleMode] = createViewMode(() => session);

  const rows = createMemo(() => deriveRows(store.events));
  const working = createMemo(() => sessionWorking(rows()));
  const pending = createMemo(() => pendingPermissions(store.events));

  // Activity dot on the inactive Text segment: track the highest event id the
  // Text view has "seen" (updated whenever text mode is active); a higher live
  // id while in terminal mode raises the dot.
  const maxId = createMemo(() => {
    const last = store.events[store.events.length - 1];
    return last ? last.id : 0;
  });
  const [seenText, setSeenText] = createSignal(0);
  createEffect(() => {
    if (mode() === "text") setSeenText(maxId());
  });
  const textDot = createMemo(() => mode() !== "text" && maxId() > seenText());

  // Cmd/Ctrl-J toggle. Capture phase intercepts before a focused terminal.
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) {
      e.preventDefault();
      toggleMode();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const send = (t: string) => void store.send(t);
  const stop = () => void store.interrupt();
  const resolve = (reqId: string, d: PermissionDecision) =>
    void store.resolvePermission(reqId, d);

  return (
    <div class="tl-app" data-mode={mode()}>
      <header class="tl-header">
        <div class="tl-header-left">
          <span class="tl-brand">terminal-lobby</span>
          <span class="tl-session" title="session">
            {session}
          </span>
          <span
            class="tl-conn"
            data-status={store.status()}
            title={`stream: ${store.status()}`}
          >
            {store.status()}
          </span>
        </div>
        <div class="tl-header-right">
          <ViewSwitch mode={mode()} onSet={setMode} textDot={textDot()} />
          <select
            class="tl-theme-picker"
            aria-label="Theme"
            title="Theme"
            value={theme()}
            onChange={(e) => setTheme(e.currentTarget.value)}
          >
            <For each={THEMES}>
              {(t) => <option value={t}>{THEME_LABELS[t] ?? t}</option>}
            </For>
          </select>
        </div>
      </header>

      <main class="tl-views">
        {/* Both views stay mounted for the page lifetime; CSS hides the inactive
            one. Never key/unmount on mode — that would drop terminal state. */}
        <section
          class="tl-view"
          classList={{ "tl-hidden": mode() !== "text" }}
          aria-hidden={mode() !== "text"}
        >
          <TextView
            events={store.events}
            working={working()}
            pending={pending()}
            onSend={send}
            onStop={stop}
            onResolve={resolve}
          />
        </section>
        <section
          class="tl-view"
          classList={{ "tl-hidden": mode() !== "terminal" }}
          aria-hidden={mode() !== "terminal"}
        >
          <TerminalView session={session} active={mode() === "terminal"} />
        </section>
      </main>
    </div>
  );
};
