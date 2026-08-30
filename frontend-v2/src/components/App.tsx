import {
  createEffect,
  createMemo,
  createSignal,
  For,
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
import { canActAs } from "../lib/mode";
import { NAME_RE, sessionLabel, type Layout } from "../types/lobby";
import {
  EMPTY_KEEP,
  KEEP_TTL_MS,
  keepSelected,
  keyOf,
  pruneKept,
  type Selected,
} from "../store/keepalive";
import { Sidebar } from "./Sidebar";
import { SessionView } from "./SessionView";
import { SettingsPanel, type PageId } from "./SettingsPanel";
import { openerAction } from "./settings/rail";
import { Toaster } from "./Toaster";
import { startNetworkWatch } from "../diagnostics/network";
import { createPrefsStore } from "../store/prefs";
import { createSkillsStore } from "../store/skills";
import { SkillsIcon } from "./Icons";
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
import { createCoarsePointer, createMobileFlip, isMobileFlip } from "../mobile/pointer";
import { installSwipe } from "../mobile/swipe";
import { installViewportSync } from "../mobile/viewport";
import { installFocusReveal } from "../mobile/reveal";
import { Dock } from "./Dock";
import { track, tracker } from "../telemetry/track";
import { isCoarsePointer } from "../mobile/pointer";
import { actAsUrl, lensTarget } from "../lib/act-as";
import { ACT_AS } from "../lib/config";
import { listUsers } from "../lib/lobby-api";

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
    // Opening a session on a phone IS the navigation: show the terminal. Fires
    // even when the same session is re-tapped, which is how you get back to a
    // terminal you left to browse the list.
    onActivate: () => {
      if (isMobileFlip()) setCollapsed(true);
    },
  });
  onCleanup(() => store.dispose());

  const prefs = createPrefsStore();
  // The skill manager's store (ADR-0011). Created here so it survives the panel
  // being closed and reopened, but it fetches nothing until the group renders.
  const skills = createSkillsStore();
  // What the Skills group needs to say which sessions still run an older skill
  // set: the live list, name and Claude state only.
  const skillSessions = createMemo(() =>
    store.sessions.map((s) => ({ name: s.name, state: s.state || "" })),
  );
  // One event per tab boot: the denominator every other count is read against.
  onMount(() => track("app.loaded", { "tl.kind": isCoarsePointer() ? "touch" : "desktop" }));
  onCleanup(() => {
    tracker.flushSync();
    tracker.dispose();
  });
  onMount(() => void prefs.bootSync());
  onCleanup(() => prefs.dispose());

  // Which network this device is on, which is what lets Data used separate a
  // month's cellular from its WiFi. Started at the shell so the answer is in
  // place before the first 60s window closes, and re-asked when the device
  // comes back online or the tab returns from a pocket.
  onMount(() => onCleanup(startNetworkWatch()));

  // ---- soft-keyboard plumbing (shell-wide) --------------------------------
  // Publishes --kb-offset / --sk-h / --app-vh, and re-reveals whatever field
  // has focus once the keyboard settles.
  //
  // At the SHELL, not per session. Two reasons, and the second is a bug this
  // fixes: SessionView mounts once per session kept in the tab, so the sync ran
  // as many times as there were open sessions; and it did not run at all until
  // a session was opened, which left the LIST screen with no live --kb-offset —
  // so the sidebar had no way to know a keyboard was covering its bottom third,
  // and a project's "new session" box opened underneath one.
  //
  // The terminal callbacks are global bridges TerminalView owns while it is
  // mounted, so they no-op cleanly on the list screen.
  onMount(() => {
    const stopViewport = installViewportSync({
      onRefit: () => window.__tlRefitTerminal?.(),
      // The terminal frame reserves the keyboard's space itself — see
      // .tl-kb-inline in app.css and keyboardReserve in term.html.
      onKeyboard: (px) => window.__tlKeyboardOffset?.(px),
    });
    const stopReveal = installFocusReveal();
    onCleanup(() => {
      stopViewport();
      stopReveal();
    });
  });

  // ---- PWA notifications (pillar #2 — inventory Cat.9) ---------------------
  // A plain snapshot of the poll list feeds the tab title/favicon badge + the
  // foreground transition notifications. The system owns the header bell, web
  // push, and the attention latch fed by the terminal iframe's tl-attention.
  const sessionSnapshot = createMemo<TitleSession[]>(() =>
    store.sessions.map((s) => ({
      name: s.name,
      // The tab title and the OS notification body speak in titles like every
      // other surface; the name still identifies the session underneath.
      title: s.title,
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

  // ---- phone layout: one view at a time -----------------------------------
  // `collapsed` is re-read under the phone query as a VIEW, not a width:
  // false = BROWSING (the session list owns the screen), true = TERMINAL.
  const flip = createMobileFlip();
  // Boot: a phone starts on the list unless the URL already names a session —
  // a deep link goes straight to the terminal with no flash of the list. The
  // persisted desktop collapse is deliberately ignored here: it is a width
  // preference for a device with room for both, and honouring it on a phone
  // would open the app into a terminal the user did not ask for.
  const [collapsed, setCollapsed] = createSignal(
    isMobileFlip() ? !!readInitialSelection() : readSidebarCollapsed(),
  );
  const toggleSidebar = () => {
    const next = !collapsed();
    track("sidebar.toggled", { "tl.to": next ? "collapsed" : "expanded" });
    setCollapsed(next);
    // On a phone this is a VIEW, not a width preference — persisting it would
    // decide which screen the app opens on next time.
    if (flip()) return;
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
    } catch {
      /* no storage */
    }
  };

  const [settingsOpen, setSettingsOpen] = createSignal(false);
  // Skills is a page on the Settings rail, so both header buttons open the same
  // overlay. This is the page SHOWING — seeded by whoever opened it, then kept
  // honest by the panel's onPageChange, because the rail moves it afterwards
  // and a copy that ignored that would make the buttons lie.
  const [settingsPage, setSettingsPage] = createSignal<PageId | undefined>(undefined);
  /**
   * Open the panel, or act on it when it is already open. What a press means
   * with two buttons over one dialog is decided in rail.ts, where it is
   * testable; this wires the verdict up.
   */
  const openSettings = (page?: PageId): void => {
    const act = openerAction({
      isOpen: settingsOpen(),
      showing: settingsPage(),
      pressed: page,
    });
    if (act.kind === "close") {
      setSettingsOpen(false);
      return;
    }
    if (act.kind === "goto") {
      setSettingsPage(act.page);
      return;
    }
    // Skills has always been its own thing to reach for; counting it as a
    // Settings visit would overstate how often people open Settings.
    if (act.page !== "skills") track("settings.opened");
    setSettingsPage(act.page);
    setSettingsOpen(true);
  };
  const skillsOpen = () => settingsOpen() && settingsPage() === "skills";

  // --- act as another user (admin only) -------------------------------------
  //
  // actingAs comes from the SERVER's /whoami (realUser present ⇒ switched), not
  // from ACT_AS: the URL is only the ask, and a tab whose ?as= the server
  // refused must not paint itself as somebody else. ACT_AS is used solely to
  // pre-select the dropdown before whoami lands.
  const actingAs = createMemo(() => {
    const w = store.whoami();
    return w?.realUser ? w.osUser : "";
  });
  // canActAs, not admin alone: a single-user box has one account, so there is
  // nobody to act as even for someone the server calls an administrator.
  const isAdmin = createMemo(() => canActAs(store.whoami()));
  // Whose account this tab is a lens on ("" = an ordinary tab). It decides that
  // a session here opens WATCHING, and which namespace a take-control choice is
  // remembered under (lib/act-as.ts). Same derivation the sidebar's cards make
  // from the same /whoami, so the two surfaces cannot disagree.
  const lens = createMemo(() => lensTarget(store.whoami(), ACT_AS));
  const [actAsUsers, setActAsUsers] = createSignal<string[]>([]);
  createEffect(() => {
    if (!isAdmin() || actAsUsers().length > 0) return;
    const real = store.whoami()?.realUser ?? store.whoami()?.osUser ?? "";
    void listUsers().then((us) => setActAsUsers(us.filter((u) => u !== real)));
  });
  const switchToUser = (osUser: string): void => {
    if (osUser === actingAs()) return;
    track(osUser ? "admin.actas" : "admin.actas.exit", { "tl.to": osUser });
    window.location.href = actAsUrl(window.location.href, osUser);
  };
  const actAsControl = createMemo(() =>
    isAdmin()
      ? { users: actAsUsers, current: actingAs, switchTo: switchToUser }
      : undefined,
  );

  const selectedName = createMemo(() => store.selected()?.name ?? null);
  // Nothing selected (killed, or the last session closed) => walk back to the
  // list. Without this the phone shows an empty terminal pane whose only exit
  // is the back control, and the user has no session to go back to.
  createEffect(() => {
    if (flip() && selectedName() === null) setCollapsed(false);
  });
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

  // ---- sessions kept mounted (store/keepalive.ts) --------------------------
  // A session you have opened stays mounted and hidden, so going back to it
  // shows what is already there instead of rebuilding an iframe, an xterm, a
  // ttyd socket and an SSE stream — 1,797 ms of cover per switch, measured.
  const selectedSession = createMemo<Selected | null>(() => {
    const sel = store.selected();
    return sel ? { name: sel.name, owner: sel.owner } : null;
  });
  const [kept, setKept] = createSignal(EMPTY_KEEP);
  const selectedKey = createMemo(() => {
    const sel = selectedSession();
    return sel ? keyOf(sel) : null;
  });
  createEffect(() => {
    const sel = selectedSession();
    setKept((state) => keepSelected(state, sel, Date.now()));
  });
  /** Drop what is not worth holding: a day unvisited, or gone from the lobby. */
  const prune = () =>
    setKept((state) =>
      pruneKept(
        state,
        selectedSession(),
        Date.now(),
        KEEP_TTL_MS,
        store.loading() ? undefined : new Set(store.sessions.map((s) => s.name)),
      ),
    );
  createEffect(() => {
    // Re-run whenever the list changes, so a session killed from another device
    // loses its mount without waiting for the timer.
    store.sessions.length;
    prune();
  });
  // The TTL only bites in a tab left open for a day, which the timer covers.
  const pruneTimer = setInterval(prune, 5 * 60 * 1000);
  onCleanup(() => clearInterval(pruneTimer));

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
        { label: "Skills", hint: "install, disable, share", run: () => openSettings("skills") },
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

  /**
   * Swipe left/right moves between sessions on a phone, so switching does not
   * require the round trip back to the list. It dispatches the SAME commands
   * the keyboard uses, so the order, the wrap and the foreign-session handling
   * are the sidebar's, in one place.
   */
  const installSessionSwipe = (el: HTMLElement): void => {
    const off = installSwipe(el, {
      enabled: () => flip() && !collapsed(),
      onSwipe: (dir) => run(dir === "next" ? "session.next" : "session.prev"),
    });
    onCleanup(off);
  };

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

  // The act-as chip, rendered into whichever bar is on screen alongside the
  // gear. With a full identity switch there is no server-side difference
  // between you and the person you are acting as, so this plus the tinted frame
  // is what separates a deliberate action from typing into the wrong tab.
  const actAsChip = () => (
    <Show when={actingAs()}>
      {(who) => (
        <button
          type="button"
          class="tl-actas-chip"
          title={`Acting as ${who()} — click to return to your own lobby`}
          aria-label={`Acting as ${who()}. Return to your own lobby`}
          onClick={() => switchToUser("")}
        >
          <span class="tl-actas-who">{who()}</span>
          <span class="tl-actas-x" aria-hidden="true">
            ✕
          </span>
        </button>
      )}
    </Show>
  );

  // The shell bar's Settings control. It carries a LABEL, not just the gear:
  // as a bare glyph it measured 23x18 in muted grey in the extreme top-right
  // corner of a 1440px bar, which is findable only if you already know it is
  // there. The bar has the room — everything else in it sits on the left — and
  // the label collapses back to the icon under 1000px via .tl-btn-label.
  //
  // The phone never renders this: its shell bar is hidden by the flip, and the
  // sidebar footer carries its own gear instead.
  const settingsButton = () => (
    <button
      class="tl-icon-btn tl-settings-btn"
      aria-label="Settings"
      title="Settings"
      aria-expanded={settingsOpen()}
      onClick={() => openSettings()}
    >
      ⚙<span class="tl-btn-label">Settings</span>
    </button>
  );

  // Beside Settings, and labelled for the same reason: a bare glyph in the far
  // corner of a wide bar is findable only if you already know it is there. It
  // opens the same overlay on its own page, so the one-click path to Skills
  // survives the move back into Settings.
  const skillsButton = () => (
    <button
      class="tl-icon-btn tl-skills-btn"
      aria-label="Skills"
      title="Skills"
      aria-expanded={skillsOpen()}
      onClick={() => openSettings("skills")}
    >
      <SkillsIcon />
      <span class="tl-btn-label">Skills</span>
    </button>
  );

  return (
    <div
      class="tl-shell"
      classList={{
        "tl-shell-collapsed": collapsed(),
        "tl-flip": flip(),
        // Paints the coloured frame + tinted bars. Driven by the server's
        // answer, so a refused ?as= leaves the tab looking exactly like yours.
        "tl-acting-as": !!actingAs(),
      }}
    >
      <aside class="tl-shell-sidebar">
        <Sidebar
          store={store}
          prefs={prefs}
          altActive={engine.altActive}
          notifications={notifications}
          // The phone folds the shell bar (and with it the gear) into the
          // session bar, which only exists once a session is open. Without this
          // the sidebar's own screen has no route to Settings at all.
          onOpenSettings={flip() ? () => openSettings() : undefined}
          // The Skills panel needs the same phone route as Settings: its button
          // lives on the folded-away shell bar, and the session-bar menu that
          // also carries it is only there once a session is open.
          onOpenSkills={flip() ? () => openSettings("skills") : undefined}
          // Same reason as onOpenSettings: on a phone the shell bar that
          // carries the chip is folded away, so the list screen needs its own
          // one-tap route back to your own lobby.
          actAsChip={flip() ? actAsChip() : undefined}
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
          {actAsChip()}
          {skillsButton()}
          {settingsButton()}
        </div>

        <div class="tl-shell-body" ref={(el) => installSessionSwipe(el)}>
          <Show when={!selectedName()}>
            <div class="tl-shell-empty tl-muted">
              Select a session from the sidebar, or create one to begin.
            </div>
          </Show>
          {/* Every session opened in this tab stays mounted, and the one being
              read is the one not hidden. The slots are appended and never
              reordered: moving an iframe in the DOM reloads it, which is the
              whole cost this avoids. */}
          <For each={kept().list}>
            {(k) => {
              const shown = () => k.key === selectedKey();
              const label = () =>
                sessionLabel(store.sessions.find((s) => s.name === k.name) ?? { name: k.name });
              return (
                <div class="tl-session-slot" classList={{ "tl-hidden": !shown() }}>
                  <SessionView
                    session={k.name}
                    label={label()}
                    owner={k.owner}
                    me={store.me}
                    lens={lens}
                    otherSessions={() =>
                      flatSessionOrder(store.model())
                        .filter((o) => o.name !== k.name)
                        .map((o) => ({
                          ...o,
                          // Titled sessions read by their title here too.
                          label: sessionLabel(
                            store.sessions.find((s) => s.name === o.name) ?? { name: o.name },
                          ),
                        }))
                    }
                    onSwitchSession={(n, owner) => store.select(n, owner)}
                    visible={shown() && (!flip() || collapsed())}
                    leading={
                      <Show when={flip()}>
                        <button
                          class="tl-icon-btn tl-back-btn"
                          aria-label="Back to sessions"
                          onClick={() => setCollapsed(false)}
                        >
                          ‹<span class="tl-btn-label">Sessions</span>
                        </button>
                      </Show>
                    }
                    menuExtra={
                      <Show when={flip()}>
                        <button
                          class="tl-menu-item"
                          role="menuitem"
                          onClick={() => openSettings("skills")}
                        >
                          Skills
                        </button>
                        <button
                          class="tl-menu-item"
                          role="menuitem"
                          onClick={() => openSettings()}
                        >
                          Settings
                        </button>
                      </Show>
                    }
                    driven={() =>
                      store.sessions.some((s) => s.name === k.name && s.driven === true)
                    }
                    creating={shown() && selectedIsCreating()}
                    dir={shown() ? selectedDir() : undefined}
                    newCommand={newCommand}
                    prefs={prefs}
                    notify={notify}
                    overlayOpen={overlayOpen}
                    // Everything below reaches the LOBBY, so only the session on
                    // screen may speak: a hidden mount raising a chord, a badge or
                    // an app reload would be a session acting from behind another.
                    // A chord pressed INSIDE the terminal iframe is matched by
                    // term.html against the TERMINAL page's own context and arrives
                    // here as a bare command name — so it has to clear the same
                    // when-clause the window keydown path clears, or an open
                    // overlay guards exactly one of the two.
                    onFrameCommand={(cmd) => {
                      if (shown() && engine.allows(cmd)) run(cmd);
                    }}
                    onFrameAlt={(down) => shown() && engine.setFrameAlt(down)}
                    onFrameAttention={(kind, session) => {
                      if (shown()) notifications.onFrameAttention(kind, session);
                    }}
                    onFrameBuildStale={() => shown() && healer.onBuildStale()}
                    onOpenGallery={() => void gallery.open()}
                    onPreviewState={(st) => shown() && setPreviewState(st)}
                  />
                </div>
              );
            }}
          </For>
          <Dock dock={dock} onFrameCommand={(cmd) => run(cmd)} />
        </div>
      </div>

      <Show when={settingsOpen()}>
        <SettingsPanel
          prefs={prefs}
          onClose={() => setSettingsOpen(false)}
          initialPage={settingsPage()}
          onPageChange={setSettingsPage}
          keybindings={{
            enabled: engine.enabled,
            setEnabled: engine.setEnabled,
            altLabel: engine.altLabel,
          }}
          notifications={notifications}
          actAs={actAsControl()}
          skills={skills}
          skillSessions={skillSessions}
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
