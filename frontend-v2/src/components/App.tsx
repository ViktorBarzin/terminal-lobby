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
import { createKeybindingEngine } from "../keybindings/engine";
import { createPaletteController, type PaletteAction } from "../keybindings/palette-controller";
import { createRunAppCommand } from "../keybindings/commands";
import { flatSessionOrder } from "../keybindings/navigation.logic";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsHelp, createHelpController } from "./ShortcutsHelp";

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

  // ---- keybinding engine + command palette + shortcuts help (pillar #2) ----
  // The lobby SPA is always the "lobby" side: it owns the sidebar, palette and
  // session switching. The terminal iframe forwards its chords up over
  // tl-command (onFrameCommand -> runAppCommand) and its Alt state over
  // tl-kb-alt (onFrameAlt -> engine.setFrameAlt) for the Alt-hold badges.
  const engine = createKeybindingEngine();
  const help = createHelpController();

  // Session rows for the palette (recents-first is applied inside the palette).
  const paletteSessions = () => {
    const m = store.model();
    const out: { name: string; state?: string }[] = [];
    for (const g of m.groups) for (const s of g.sessions) out.push({ name: s.name, state: s.state || "" });
    for (const s of m.foreign) out.push({ name: s.name, state: s.state || "" });
    return out;
  };

  // `run` is assigned just below; the palette's action rows call it lazily.
  let run: (cmd: string) => void = () => {};
  const palette = createPaletteController({
    sessions: () => Promise.resolve(paletteSessions()),
    current: () => store.selected()?.name ?? null,
    attach: (name) => {
      if (store.selected()?.name === name) return;
      const t = flatSessionOrder(store.model()).find((s) => s.name === name);
      store.select(name, t?.owner);
    },
    refocus: () => {},
    actions: () => {
      const cur = store.selected()?.name ?? null;
      const acts: PaletteAction[] = [
        { label: "New session", hint: "name box", keepFocus: true, run: () => run("session.new") },
        { label: "Keyboard shortcuts", hint: "/", run: () => run("shortcuts.help") },
      ];
      if (cur) {
        acts.push(
          { label: "Rename current session", hint: cur, run: () => run("session.rename.current") },
          { label: "Open image gallery", hint: cur, run: () => run("gallery.open") },
          { label: "Paste into terminal", hint: cur, run: () => run("terminal.paste") },
          { label: "Kill current session", hint: cur, danger: true, run: () => run("session.kill.current") },
        );
      }
      return acts;
    },
  });

  run = createRunAppCommand({
    store,
    palette,
    help,
    toggleSidebar: () => toggleSidebar(),
    focusNewSession: () => {
      if (collapsed()) toggleSidebar(); // the box lives in the sidebar
      window.dispatchEvent(new CustomEvent("tl:focus-new-session"));
    },
    notify,
    forwardToTerminal: (cmd) => {
      const f = window.__tlForwardToTerminal;
      return typeof f === "function" ? !!f(cmd) : false;
    },
  });

  engine.init({
    getContext: () => ({ terminalFocus: false, lobbyOpen: true, galleryOpen: false }),
    runCommand: (cmd) => run(cmd),
  });
  onCleanup(() => engine.dispose());

  // The bare "/" or "?" help opener — lobby chrome only (never in a field, and
  // modifier combos fall through to the engine so Alt+/ still works). Lives here
  // so it works while the overlay is closed. Esc closes an open overlay.
  const onSlashKey = (e: KeyboardEvent) => {
    if (help.isOpen() && e.key === "Escape") {
      e.preventDefault();
      help.close();
      return;
    }
    if (e.key !== "/" && e.key !== "?") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    e.preventDefault();
    help.toggle();
  };
  onMount(() => window.addEventListener("keydown", onSlashKey, true));
  onCleanup(() => window.removeEventListener("keydown", onSlashKey, true));

  return (
    <div class="tl-shell" classList={{ "tl-shell-collapsed": collapsed() }}>
      <aside class="tl-shell-sidebar">
        <Sidebar store={store} altActive={engine.altActive} />
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
                onFrameCommand={(cmd) => run(cmd)}
                onFrameAlt={(down) => engine.setFrameAlt(down)}
              />
            )}
          </Show>
        </div>
      </div>

      <Show when={settingsOpen()}>
        <SettingsPanel
          prefs={prefs}
          onClose={() => setSettingsOpen(false)}
          keybindings={{ enabled: engine.enabled, setEnabled: engine.setEnabled }}
        />
      </Show>

      <Show when={palette.isOpen()}>
        <CommandPalette controller={palette} />
      </Show>

      <Show when={help.isOpen()}>
        <ShortcutsHelp controller={help} altLabel={engine.altLabel} isMac={engine.isMac} />
      </Show>

      <Toaster controller={toasts} />
    </div>
  );
};
