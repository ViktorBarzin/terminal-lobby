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
import { NAME_RE, type Layout } from "../types/lobby";
import { Sidebar } from "./Sidebar";
import { SessionView } from "./SessionView";
import { SettingsPanel } from "./SettingsPanel";
import { Toaster } from "./Toaster";
import { createPrefsStore } from "../store/prefs";
import { toasts } from "../store/toast";
import { createKeybindingEngine } from "../keybindings/engine";
import { keyContext } from "../keybindings/bindings.logic";
import { createPaletteController, type PaletteAction } from "../keybindings/palette-controller";
import { createRunAppCommand } from "../keybindings/commands";
import { refocusTerminal } from "../keybindings/refocus";
import { flatSessionOrder } from "../keybindings/navigation.logic";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsHelp, createHelpController } from "./ShortcutsHelp";
import { createNotificationSystem } from "../notify/notifications";
import type { TitleSession } from "../notify/title";
import { createGalleryStore } from "../store/gallery";
import { Gallery } from "./Gallery";
import { createDeployHealer } from "../deploy/healer";
import { createDockStore } from "../store/dock";
import { createCoarsePointer } from "../mobile/pointer";
import { Dock } from "./Dock";
import { track, tracker } from "../telemetry/track";
import { isCoarsePointer } from "../mobile/pointer";

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
 * The base directory a session should be born in: the `dir` of the layout
 * project that owns it. /api/layout has carried a project dir all along and the
 * attach URL has an arg3 slot for it (terminal-url.ts) — the two were simply
 * never joined, so a session created inside a project started in $HOME. A
 * project with no dir, an ungrouped session, or an unknown name all yield
 * undefined and no arg3 is sent.
 */
export function projectDirFor(layout: Layout, session: string): string | undefined {
  const project = layout.projects.find((p) => p.sessions.includes(session));
  return project?.dir || undefined;
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
  // One event per tab boot: the denominator every other count is read against.
  onMount(() => track("app.loaded", { "tl.kind": isCoarsePointer() ? "touch" : "desktop" }));
  onCleanup(() => {
    tracker.flushSync();
    tracker.dispose();
  });
  onMount(() => void prefs.bootSync());
  onCleanup(() => prefs.dispose());

  // ---- PWA notifications (pillar #2 — inventory Cat.9) ---------------------
  // A plain snapshot of the poll list feeds the tab title/favicon badge + the
  // foreground transition notifications. The system owns the header bell, web
  // push, and the attention latch fed by the terminal iframe's tl-attention.
  const sessionSnapshot = createMemo<TitleSession[]>(() =>
    store.sessions.map((s) => ({
      name: s.name,
      state: s.state,
      pane_current_command: s.pane_current_command,
    })),
  );
  const notifications = createNotificationSystem({
    sessions: sessionSnapshot,
    selected: () => store.selected()?.name ?? null,
    osUser: store.me,
    notifyPrefs: () => prefs.prefs().notify,
    loading: store.loading,
    toast: notify,
    onActivateSession: (name) => store.select(name),
  });
  onCleanup(() => notifications.dispose());

  // ---- session image gallery (pillar #2 — inventory Cat.8) ----------------
  // The gallery is per-session but lives at the shell level so gallery.open
  // (palette action / 🖼 button / forwarded chord) opens it over any view. It
  // fetches the SELECTED session's images on open; switching sessions closes it.
  const gallery = createGalleryStore({
    session: () => store.selected()?.name ?? null,
    notify,
  });

  // ---- deploy self-heal (pillar #3 — inventory Cat.10) --------------------
  // The lobby is the ONLY deploy channel (no server build header): it polls its
  // own served bytes on a 5s timer + on resume/bfcache, and on a real change
  // owns the SINGLE reload. A terminal is "attached" when a session is selected
  // (SessionView + its ttyd iframe are mounted) — the v2 analog of the vanilla
  // `currentActive`; that gates the immediate-vs-deferred reload policy. The
  // iframe's own `tl-build-stale` signal routes up through SessionView →
  // onFrameBuildStale → healer.onBuildStale (the TOP-owned reload contract).
  const healer = createDeployHealer({
    hasAttachedTerminal: () => store.selected() !== null,
  });
  onCleanup(() => healer.dispose());

  // ---- Ctrl/Cmd+J scratch shell (the vanilla dock) ------------------------
  // A second live terminal under the session you are in, roamed as layout.dock.
  // Desktop only: a coarse pointer has room for one terminal, so the chord is
  // inert there — the same line the vanilla page draws.
  const dock = createDockStore({ store });
  const dockAllowed = createCoarsePointer();
  const onDockKey = (e: KeyboardEvent): void => {
    if (!((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J"))) return;
    if (dockAllowed()) return; // coarse pointer: no dock
    e.preventDefault();
    void dock.toggle();
  };
  onMount(() => window.addEventListener("keydown", onDockKey, true));
  onCleanup(() => window.removeEventListener("keydown", onDockKey, true));

  const [collapsed, setCollapsed] = createSignal(readSidebarCollapsed());
  const toggleSidebar = () => {
    const next = !collapsed();
    track("sidebar.toggled", { "tl.to": next ? "collapsed" : "expanded" });
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

  // A selected session the poll has never returned does not exist in tmux yet:
  // `store.create` only writes the layout, and the session comes into being when
  // a terminal attaches. That one terminal must attach immediately; every other
  // session's waits for the Terminal view, because attaching resizes the tmux
  // WINDOW to the iframe and would reflow a wide client already using it.
  // `loading` covers the pre-first-poll window, where everything looks unseen.
  const selectedIsCreating = createMemo(() => {
    const name = selectedName();
    if (!name || store.loading()) return false;
    return !store.sessions.some((s) => s.name === name);
  });

  const selectedDir = createMemo(() => {
    const name = selectedName();
    return name ? projectDirFor(store.layout(), name) : undefined;
  });

  // The mounted session's file-preview overlay, published up by SessionView.
  // A session switch disposes that view and the unsaved draft inside it, so the
  // keyboard routes into a switch have to know about it (the mouse route
  // already does — it goes through the overlay's own discard confirm).
  const [previewState, setPreviewState] = createSignal({ open: false, dirty: false });

  // ---- keybinding engine + command palette + shortcuts help (pillar #2) ----
  // The lobby SPA is always the "lobby" side: it owns the sidebar, palette and
  // session switching. The terminal iframe forwards its chords up over
  // tl-command (onFrameCommand -> runAppCommand) and its Alt state over
  // tl-kb-alt (onFrameAlt -> engine.setFrameAlt) for the Alt-hold badges.
  const engine = createKeybindingEngine();
  // Both overlays render OUTSIDE the terminal iframe, so dismissing one leaves
  // focus on <body> and the pty deaf. refocusTerminal calls the bridge the
  // mounted TerminalView publishes; it is a no-op with no session selected or
  // while the text view owns the keyboard.
  const help = createHelpController({ refocus: refocusTerminal });

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
      // Same guard the switch chords carry: the palette is reachable over the
      // open preview, and picking a session here would bin the draft too.
      if (previewState().dirty) {
        notify("Unsaved changes in the file editor — save or discard them first", "warning");
        return;
      }
      const t = flatSessionOrder(store.model()).find((s) => s.name === name);
      store.select(name, t?.owner);
    },
    refocus: refocusTerminal,
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
    openGallery: () => void gallery.open(),
    pasteToTerminal: () => window.__tlDoPaste?.() ?? false,
    toggleDock: () => void dock.toggle(),
    forwardToTerminal: (cmd) => {
      const f = window.__tlForwardToTerminal;
      return typeof f === "function" ? !!f(cmd) : false;
    },
  });

  // The shell's when-context, built in ONE place (keyContext) and read by all
  // three key paths: the engine's window keydown, the terminal iframe's
  // forwarded commands (engine.allows, below) and SessionView's always-on
  // Ctrl/Cmd+J. Each of those used to decide for itself what an open overlay
  // meant, so a chord refused on one path fired on another.
  const keyCtx = createMemo(() =>
    keyContext({
      paletteOpen: palette.isOpen(),
      helpOpen: help.isOpen(),
      settingsOpen: settingsOpen(),
      galleryOpen: gallery.view() !== "closed",
      previewOpen: previewState().open,
      previewDirty: previewState().dirty,
    }),
  );
  const overlayOpen = () => keyCtx().overlayOpen;

  engine.init({
    getContext: () => keyCtx(),
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
    // Another overlay owns the keyboard: opening this one over it is the same
    // context leak the chords carried. This overlay itself is exempt — "/" is
    // one of its own dismiss keys.
    if (overlayOpen() && !help.isOpen()) return;
    e.preventDefault();
    help.toggle();
  };
  onMount(() => window.addEventListener("keydown", onSlashKey, true));
  onCleanup(() => window.removeEventListener("keydown", onSlashKey, true));

  return (
    <div class="tl-shell" classList={{ "tl-shell-collapsed": collapsed() }}>
      <aside class="tl-shell-sidebar">
        <Sidebar
          store={store}
          prefs={prefs}
          altActive={engine.altActive}
          notifications={notifications}
        />
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
          {/* The bell lives in the sidebar's lobby header, beside the title —
              where the vanilla page keeps it. The shell bar carries the
              collapse arrow, the brand and Settings. */}
          <span class="tl-shellbar-spacer" />
          <button
            class="tl-icon-btn tl-settings-btn"
            aria-label="Settings"
            title="Settings"
            aria-expanded={settingsOpen()}
            onClick={() => {
              if (!settingsOpen()) track("settings.opened");
              setSettingsOpen((v) => !v);
            }}
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
                // Whether someone is already DRIVING this session, so a second
                // device joins as a viewer instead of taking the grid. Polled,
                // so it can lag a few seconds — being wrong costs one click.
                driven={() =>
                  store.sessions.some((s) => s.name === name && s.driven === true)
                }
                creating={selectedIsCreating()}
                dir={selectedDir()}
                newCommand={newCommand}
                prefs={prefs}
                notify={notify}
                overlayOpen={overlayOpen}
                // A chord pressed INSIDE the terminal iframe is matched by
                // term.html against the TERMINAL page's own context and arrives
                // here as a bare command name — so it has to clear the same
                // when-clause the window keydown path clears, or an open
                // overlay guards exactly one of the two.
                onFrameCommand={(cmd) => {
                  if (engine.allows(cmd)) run(cmd);
                }}
                onFrameAlt={(down) => engine.setFrameAlt(down)}
                onFrameAttention={notifications.onFrameAttention}
                onFrameBuildStale={() => healer.onBuildStale()}
                onOpenGallery={() => void gallery.open()}
                onPreviewState={setPreviewState}
              />
            )}
          </Show>
          <Dock dock={dock} onFrameCommand={(cmd) => run(cmd)} />
        </div>
      </div>

      <Show when={settingsOpen()}>
        <SettingsPanel
          prefs={prefs}
          onClose={() => setSettingsOpen(false)}
          keybindings={{
            enabled: engine.enabled,
            setEnabled: engine.setEnabled,
            altLabel: engine.altLabel,
          }}
          notifications={notifications}
        />
      </Show>

      <Show when={palette.isOpen()}>
        <CommandPalette controller={palette} />
      </Show>

      <Show when={help.isOpen()}>
        <ShortcutsHelp controller={help} altLabel={engine.altLabel} isMac={engine.isMac} />
      </Show>

      <Show when={gallery.view() !== "closed"}>
        <Gallery store={gallery} />
      </Show>

      {/* No update UI, by design (ADR-0007): a new build applies itself at the
          next open. Nothing to tap, nothing to dismiss. */}

      <Toaster controller={toasts} />
    </div>
  );
};
