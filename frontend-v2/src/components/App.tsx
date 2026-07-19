import {
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import {
  createLobbyStore,
  type NotifyKind,
  type SelectedSession,
} from "../store/lobby";
import { NAME_RE } from "../types/lobby";
import { Sidebar } from "./Sidebar";
import { SessionView } from "./SessionView";
import { SettingsPanel } from "./SettingsPanel";
import { Toaster } from "./Toaster";
import { createPrefsStore } from "../store/prefs";
import { toasts } from "../store/toast";

const SIDEBAR_KEY = "tmux-sidebar-collapsed";

function readInitialSelection(): SelectedSession | null {
  if (typeof window === "undefined") return null;
  try {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash) {
      const at = hash.indexOf("@");
      if (at > 0) return { name: hash.slice(0, at), owner: hash.slice(at + 1) };
      if (NAME_RE.test(hash)) return { name: hash };
    }
    const q = new URLSearchParams(window.location.search).get("session");
    if (q && NAME_RE.test(q)) return { name: q };
  } catch {
    /* no URL */
  }
  return null;
}

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The lobby shell: a sidebar of sessions/projects beside the selected session's
 * two-view surface. The lobby store owns the session list, layout, and all
 * mutations (tmux-api); selecting a card mounts a SessionView for it (remounted
 * per session so its SSE stream is scoped correctly). Store errors surface as
 * toasts; roamed prefs (prefsStore) + the theme picker live in the Settings
 * panel opened from the shell bar.
 */
export const App: Component = () => {
  const notify = (message: string, kind: NotifyKind) =>
    toasts.push({ kind, message });

  const store = createLobbyStore({
    initialSelected: readInitialSelection(),
    notify,
  });
  onCleanup(() => store.dispose());

  const prefs = createPrefsStore();
  onMount(() => void prefs.bootSync());
  onCleanup(() => prefs.dispose());

  const [collapsed, setCollapsed] = createSignal(readSidebarCollapsed());
  const toggleSidebar = () => {
    const next = !collapsed();
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
    } catch {
      /* no storage */
    }
  };

  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const selectedName = createMemo(() => store.selected()?.name ?? null);
  const newCommand = () => prefs.prefs().session.newCommand;

  return (
    <div class="tl-shell" classList={{ "tl-shell-collapsed": collapsed() }}>
      <aside class="tl-shell-sidebar">
        <Sidebar store={store} />
      </aside>

      <div class="tl-shell-content">
        <div class="tl-shellbar">
          <button
            class="tl-icon-btn tl-sidebar-toggle"
            aria-label={collapsed() ? "Show sidebar" : "Hide sidebar"}
            title={collapsed() ? "Show sidebar" : "Hide sidebar"}
            onClick={toggleSidebar}
          >
            {collapsed() ? "›" : "‹"}
          </button>
          <span class="tl-brand">terminal-lobby</span>
          <span class="tl-shellbar-spacer" />
          <button
            class="tl-icon-btn tl-settings-btn"
            aria-label="Settings"
            title="Settings"
            aria-expanded={settingsOpen()}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            ⚙
          </button>
        </div>

        <div class="tl-shell-body">
          <Show
            when={selectedName()}
            keyed
            fallback={
              <div class="tl-shell-empty tl-muted">
                Select a session from the sidebar, or create one to begin.
              </div>
            }
          >
            {(name) => (
              <SessionView
                session={name}
                owner={store.selected()?.owner}
                newCommand={newCommand}
                notify={notify}
              />
            )}
          </Show>
        </div>
      </div>

      <Show when={settingsOpen()}>
        <SettingsPanel prefs={prefs} onClose={() => setSettingsOpen(false)} />
      </Show>

      <Toaster controller={toasts} />
    </div>
  );
};
