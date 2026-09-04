import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Component,
  type JSX,
} from "solid-js";
import { createSessionStore, JUMP_STEP_BYTES, type NotifyKind } from "../store/session";
import type { SseStatus } from "../sse/client";
import { createViewMode } from "../store/viewmode";
import { createWatchMode, clearResolvedWatch } from "../store/watchmode";
import { pendingPermissions, sessionWorking, deriveRows } from "./timeline.logic";
import type { PermissionDecision } from "../types/events";
import { ViewSwitch } from "./ViewSwitch";
import { TextView } from "./TextView";
import { TerminalView } from "./TerminalView";
import { FilePreview } from "./FilePreview";
import { FindInSession } from "./FindInSession";
import { isLoaded, MAX_JUMP_STEPS } from "./find.logic";
import { createPreviewStore } from "../store/preview";
import { SoftKeys } from "./SoftKeys";
import { createCoarsePointer, createMobileFlip } from "../mobile/pointer";
import { createDismissableMenu } from "./menu";
import { installImageClipboard } from "../clipboard/attach";
import { pasteIntoTerminal } from "../clipboard/paste-into-terminal";
import { ownWhile } from "../lib/ownwhile";
import {
  CameraIcon,
  ClipboardIcon,
  EyeIcon,
  FileTextIcon,
  ImageIcon,
} from "./Icons";
import { clampFontSize, type PrefsStore } from "../store/prefs";
import { listDir as fileList } from "../lib/file-api";
import { uploadAttachments } from "../clipboard/attach-files";
import type { ComposerSinks } from "./Composer";
import type { DraftAttachment } from "../store/drafts";
import { StatusDot } from "./StatusDot";
import { TerminalNative } from "./TerminalNative";
import { terminalFrameArgs } from "../lib/terminal-url";
import { SESSION_CHANNELS, type Channel, type TerminalReport } from "../diagnostics/status";
import type { BackgroundWork } from "../types/lobby";

/** The `?native` values that mean yes, and the ones that mean no. */
const NATIVE_YES = ["1", "true", "yes", "on"];
const NATIVE_NO = ["0", "false", "no", "off"];

/**
 * Which terminal a URL asks for, or null when it does not say.
 *
 * PRESENCE was the whole test until now (`.has("native")`), so `?native=0`
 * turned native ON and the flag had no way to say no. That matters because the
 * same flag is the escape hatch in the other direction once native is the
 * default: the de-iframe plan asks for "a URL override that works in both
 * directions" (docs/plans/2026-09-04-native-terminal-de-iframe-design.md).
 *
 * A bare `?native` reads as yes, the way a valueless flag does, and that is
 * also what it used to do. Anything unrecognised reads as NO ANSWER rather
 * than as a vote, so a typo leaves the default standing instead of silently
 * swapping someone's terminal.
 */
export function nativeFromSearch(search: string): boolean | null {
  const raw = new URLSearchParams(search).get("native");
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  if (value === "") return true;
  if (NATIVE_YES.includes(value)) return true;
  if (NATIVE_NO.includes(value)) return false;
  return null;
}

/**
 * The per-session two-view surface (text + terminal), extracted from the old
 * top-level App so the lobby shell can mount ONE of these for the selected
 * session and remount it when the selection changes. Both views stay mounted
 * (CSS-hidden) so terminal state survives the Cmd/Ctrl-J toggle; the store's SSE
 * connection is opened the first time the Text view is shown (see the effect
 * below) and closed on unmount (createSessionStore onCleanup).
 */
export const SessionView: Component<{
  session: string;
  /** What the bar SHOWS for this session: its title when it has one, else its
   *  name. Passed in rather than looked up because this view is given a name,
   *  not a session — and it stays reactive, so a retitle repaints the bar
   *  without re-mounting the terminal. */
  label?: string;
  /** FALSE while an ancestor is display:none — the phone layout hides the whole
   *  session pane to give the list the screen. It folds into TerminalView's
   *  `active`, so the frame is told it is hidden and stops fitting: a fit
   *  measured against a 0x0 box would resize the REAL tmux window, and tmux
   *  sizes a window to its smallest attached client — every other client on
   *  that session would be dragged down with it. Defaults to visible. */
  visible?: boolean;
  /** Bar slots. On a phone the shell bar is folded into this one to buy back a
   *  40px row, so the shell's own controls are passed in rather than duplicated
   *  here. Both are empty on a desktop, where the shell bar carries them itself.
   *
   *  `leading` is a control (the back button); `menuExtra` is `.tl-menu-item`
   *  rows for the bar's overflow menu, because at 390px there is no room for
   *  another button — measured, the bar's own controls left 29px for the
   *  session name. Clicking anything in there closes the menu. */
  leading?: JSX.Element;
  menuExtra?: JSX.Element;
  /** real OS-user owner when this is a shared/foreign attach (else undefined). */
  owner?: string;
  /** The EFFECTIVE OS user (whoami.osUser — the act-as target in a lens). What
   *  decides whether an attachment path in a message is ours to fetch: the
   *  clipboard read-back routes resolve inside the CALLER's own store directory,
   *  so a path belonging to someone else stays plain text (design 2026-08-17
   *  decisions 7 and 12). */
  me?: () => string;
  /** TRUE while the app is CREATING this session (the poll has never seen it):
   *  the terminal attach is what brings its tmux into being, so it must not wait
   *  for the Terminal view the way an existing session's attach does. */
  creating?: boolean;
  /** the owning project's base directory, so a session born here starts in the
   *  project rather than in $HOME (the attach URL's arg3). */
  dir?: string;
  /** TRUE when someone is already DRIVING this session (a read-write client is
   *  attached). With no explicit Watch choice recorded, this view joins as a
   *  viewer — read ONCE when the view takes the session on, never after, since
   *  the count includes this client's own attach. */
  driven?: () => boolean;
  /** What this session still owes: background agents, workflows or commands it
   *  launched that have not reported back. From the session list, because the
   *  transcript closes the turn when the main thread stops talking and cannot
   *  see them. */
  background?: () => BackgroundWork | undefined;
  /** The user this tab is acting as ("" = an ordinary tab). A lens comes up
   *  WATCHING every session it opens, and the controls that type into the pty
   *  are inert with it — until you take control, which re-attaches read-write
   *  and is remembered under this user rather than against your own session of
   *  the same name. */
  lens?: () => string;
  /** current roamed newCommand key, for a newly-created session's terminal. */
  newCommand?: () => string;
  /** roamed prefs — the A−/A+ buttons step fontSize, which the store persists
   *  and pushes live into the terminal via window.__tlPrefsLive. Optional so a
   *  test can mount the view without one (the buttons then no-op). */
  prefs?: PrefsStore;
  /** surface control-channel errors to the app's toast stack. */
  notify?: (message: string, kind: NotifyKind) => void;
  /** a chord fired inside the terminal iframe (tl-command) -> lobby dispatcher. */
  onFrameCommand?: (command: string) => void;
  /** the terminal iframe's Alt-hold state (tl-kb-alt) -> lobby badge overlay. */
  onFrameAlt?: (down: boolean) => void;
  /** the terminal iframe's attention signal (tl-attention) -> lobby tab badge. */
  onFrameAttention?: (kind: "bell" | "output", session: string | null) => void;
  /** the terminal iframe's tl-build-stale signal -> lobby's TOP-owned reload. */
  onFrameBuildStale?: () => void;
  /** open the session image gallery (🖼) — owned by the lobby shell. */
  onOpenGallery?: () => void;
  /** TRUE while a lobby overlay (palette, shortcuts help, Settings, gallery)
   *  owns the keyboard. The Ctrl/Cmd+J view toggle below is an always-on window
   *  listener that answers to no when-clause, so the shell's shared context has
   *  to travel down to it — flipping the view BEHIND an overlay is invisible and
   *  leaves the overlay standing. */
  overlayOpen?: () => boolean;
  /** Every OTHER session, for the bar's tap-to-switch picker (phone only). */
  otherSessions?: () => { name: string; owner?: string; label?: string }[];
  /** Switch to another session from the bar's picker. */
  onSwitchSession?: (name: string, owner?: string) => void;
  /** the file-preview overlay's open + unsaved-draft state, published UP so the
   *  shell's keybinding context can refuse to switch session out from under an
   *  unsaved edit (the preview store is per-session and dies with this view). */
  onPreviewState?: (state: { open: boolean; dirty: boolean }) => void;
  /** The connection status this bar's badge shows, and the way to open the
   *  panel behind it. Absent in tests and in the dock, where the badge is not
   *  drawn at all (ADR-0016). */
  status?: {
    channels: () => readonly Channel[];
    onOpen: () => void;
    /** publish this view's transcript stream status UP to the shared model. */
    onTranscript: (s: SseStatus | null) => void;
    /** the frame's socket, and the two ways to talk to it. */
    onFrameConn: (r: TerminalReport | null) => void;
    askConn: (ask: () => void) => void;
    retryConn: (retry: () => void) => void;
  };
}> = (props) => {
  const session = props.session;
  const store = createSessionStore(session, {
    notify: props.notify,
    autoStart: false,
  });
  const [mode, setMode, toggleMode] = createViewMode(() => session);
  // Watch mode is per (session, device) and lives only in this browser — the
  // desktop keeps driving the same session while the phone watches it.
  const [watch, , toggleWatch] = createWatchMode(
    () => session,
    () => props.driven?.() ?? false,
    () => props.lens?.() ?? "",
  );
  /** The user this tab is acting as, "" in an ordinary tab. */
  const lens = () => props.lens?.() ?? "";
  /**
   * This view is the one on screen.
   *
   * The lobby keeps every session you have opened mounted and CSS-hides the
   * ones you are not looking at (store/keepalive.ts), so "mounted" stopped
   * meaning "in front of you". Everything global — the ⌘/Ctrl-J toggle, find,
   * paste, the terminal bridge — is claimed against this rather than against
   * mount, or a hidden session would answer for the visible one.
   */
  /** `?native=1` — the app-rendered terminal instead of the ttyd iframe. Read
   *  once, because swapping the terminal under a live session mid-render would
   *  tear down a pty connection someone is using. A URL that does not say
   *  leaves the iframe, which is still the shipped terminal; the flip to native
   *  by default is its own change (the de-iframe plan's "the flip"). */
  const nativeTerminal = (): boolean => {
    try {
      return nativeFromSearch(location.search) ?? false;
    } catch {
      return false;
    }
  };

  const onScreen = () => props.visible !== false;

  // The terminal frame's two levers, captured on mount and published UP only
  // while this view is the one on screen. Every visited session stays mounted,
  // so the shell must be talking to the frame a person is actually looking at
  // — registering at mount would leave it holding whichever mounted last.
  let frameAsk: () => void = () => {};
  let frameRetry: () => void = () => {};
  createEffect(() => {
    if (!props.status) return;
    if (!onScreen()) {
      // Leaving the screen withdraws this view's terminal from the model, the
      // same way the transcript below withdraws its stream. Without it, going
      // from one session to another read as a DROP — the outgoing frame's
      // `working` falling to the incoming frame's `connecting` — and the panel
      // reported "dropped once" about two sockets that were both fine.
      props.status.onFrameConn(null);
      return;
    }
    props.status.askConn(() => frameAsk());
    props.status.retryConn(() => frameRetry());
    // Coming BACK needs an ask. The frame sends one message per real change, so
    // a terminal that was already open when this view left the screen will not
    // volunteer anything on return — and the row would sit on "not reporting"
    // above a working terminal. Harmless before the frame has mounted: the ask
    // is a no-op then, and the socket reports as it connects anyway.
    frameAsk();
  });
  // The transcript stream this view owns, published to the shared status model
  // (and withdrawn when the view goes off screen, so the badge never reports a
  // stream belonging to a session nobody is reading).
  // A stream nobody has asked to open is NOT a stream in trouble. The store's
  // first connect is deferred until the Text view is shown, and `status` reads
  // `connecting` until then — its initial value — so publishing it unguarded
  // made a terminal-only session report "The transcript stream is reconnecting"
  // forever and painted the badge amber over a session that was working
  // perfectly (Viktor, 2026-09-02). Null reads as `unknown`, which colours
  // nothing and says "not open".
  createEffect(() =>
    props.status?.onTranscript(onScreen() && store.started() ? store.status() : null),
  );
  /** Why the pty controls are inert, or "" when they are not. Watching at all
   *  makes them inert — a read-only tmux client drops what it is sent — so this
   *  answers for an ordinary Watch too, not only for a lens. */
  const inertReason = () =>
    !watch()
      ? ""
      : lens()
        ? `Watching ${lens()} — take control to type in their session`
        : "Watching: this device does not type into the session";
  // The sidebar reads this view's resolved state for the open session; drop it
  // when the view goes so a stale decision cannot outlive the attach it
  // described.
  onCleanup(() => clearResolvedWatch(session));

  // The transcript stream is opened by the Text view, not by mounting this one.
  // v1 is terminal-first: a session opens on the Terminal view and Text is
  // opt-in, so a store that connected at construction spent a
  // `/events/<session>` stream — and, on a mobile network, its reconnect ladder
  // — on a view most sessions never show. A plain shell session has no Claude
  // transcript at all: session-events answers 404, so the eager connect also
  // cost a console error per session per load.
  //
  // Only the FIRST connect is deferred. Once open the stream stays open for the
  // life of this view, including while the terminal is showing, because the
  // [Text] segment's activity dot is precisely the promise that the timeline
  // keeps filling behind it. `start()` is idempotent, so this effect re-running
  // (and the remembered-Text case, where it is true on the very first run)
  // opens exactly one stream.
  createEffect(() => {
    if (mode() === "text") store.start();
  });

  const rows = createMemo(() => deriveRows(store.events));
  const working = createMemo(() => sessionWorking(rows()));
  const pending = createMemo(() => pendingPermissions(store.events));

  // ---- file preview surface (roadmap pillar #6) ---------------------------
  // Session-integrated overlay: opens from a Read/Edit/Write path in the
  // transcript, a transcript-derived recent-files list, or an explicit path.
  // Created here (per-session) so it disposes on session switch and its
  // recent-files list tracks THIS session's events.
  const preview = createPreviewStore({
    events: () => store.events,
    // Route editor save toasts through the session's notify → app toast stack.
    // Left undefined the store falls back to the app-wide toast singleton.
    notify: props.notify,
  });

  // Publish the overlay's state to the shell. The shell cannot read this store
  // (it is created here, per session), and it is the shell that owns the chords
  // which would unmount us mid-edit — so the state has to travel up. Reset on
  // unmount: this component's disposal IS the switch, and a stale "dirty" left
  // behind would jam every later chord.
  createEffect(() => {
    props.onPreviewState?.({ open: preview.isOpen(), dirty: preview.dirty() });
  });
  onCleanup(() => props.onPreviewState?.({ open: false, dirty: false }));

  const maxId = createMemo(() => {
    const last = store.events[store.events.length - 1];
    return last ? last.id : 0;
  });
  const [seenText, setSeenText] = createSignal(0);
  createEffect(() => {
    if (mode() === "text") setSeenText(maxId());
  });
  const textDot = createMemo(() => mode() !== "text" && maxId() > seenText());

  // The mirror dot: pty output (or a BEL) that arrived while the TERMINAL view
  // was hidden. There is no event stream to diff for it the way textDot diffs
  // event ids — the terminal is a live attach, so the signal is the iframe's own
  // `tl-attention` message. Latch it here and clear it when you look.
  const [terminalDot, setTerminalDot] = createSignal(false);
  const onAttention = (kind: "bell" | "output", from: string | null): void => {
    if (mode() !== "terminal") setTerminalDot(true);
    props.onFrameAttention?.(kind, from);
  };
  createEffect(() => {
    if (mode() === "terminal") setTerminalDot(false);
  });

  // Ctrl/Cmd+J belongs to the scratch-shell dock, as it does on the vanilla
  // page — the view toggle keeps the [Text|Terminal] control and the
  // `view.toggle` command, which is what a chord would have run anyway. Text
  // mode is deferred for v1, so the segmented control is enough for it.

  // The listener above only ever sees a keydown that landed in the LOBBY
  // document; the same chord pressed with focus in the terminal comes back as a
  // `view.toggle` tl-command through the lobby dispatcher. Publish the toggle so
  // that dispatcher can reach it without the shell owning the view mode (the
  // bridge pattern TerminalView already uses for __tlForwardToTerminal). Without
  // this the chord was strictly one-way: the SPA focuses the iframe the moment
  // the terminal becomes active, so every press after the first was invisible.
  const toggleView = (): boolean => {
    toggleMode();
    return true;
  };
  ownWhile(onScreen, "__tlToggleView", toggleView);

  // Find in session. The overlay searches the whole transcript on the server;
  // opening a hit is the part that happens here, because reaching an event from
  // before the open window means loading the turns in between first.
  const [finding, setFinding] = createSignal(false);
  const openFind = (): boolean => {
    // Only the text view has a transcript to search. In terminal mode the
    // reader has the pty's own search, and pretending otherwise would open an
    // overlay over a session whose rows are not mounted.
    if (mode() !== "text") return false;
    setFinding(true);
    return true;
  };
  ownWhile(onScreen, "__tlOpenFind", openFind);

  /**
   * Scroll to an event, loading earlier turns until it is reachable.
   *
   * Two things can put a row out of reach, and they need different answers: the
   * event is older than the window held (load earlier), or its row exists in
   * the data but has not been mounted yet by the progressive fill (wait a
   * frame). The loop does both, bounded by MAX_JUMP_STEPS — a hit can sit
   * thousands of events back, and a jump that never ends is worse than one that
   * says it could not get there.
   */
  const jumpToEvent = async (id: number): Promise<void> => {
    for (let step = 0; step < MAX_JUMP_STEPS; step++) {
      if (window.__tlScrollToEvent?.(id)) return;
      if (!isLoaded(store.events, id)) {
        if (!store.hasEarlier()) break;
        // A jump names its own step: it already knows it is reaching far, and
        // it must not leave the reader's next glance upward expensive by
        // climbing the ladder a scroll would have climbed.
        if ((await store.loadEarlier(JUMP_STEP_BYTES)) === 0) break;
        continue;
      }
      // Loaded but not mounted yet — the fill adds rows a chunk per frame.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    // One last try after the loop, so a row that mounted on the final frame is
    // not reported as missing.
    if (!window.__tlScrollToEvent?.(id)) {
      props.notify?.("Couldn't reach that match — try loading earlier turns", "error");
    }
  };

  // The bar's session picker. Same dismissable-menu machinery as the bar's
  // overflow menu, so a press anywhere else closes it.
  const picker = createDismissableMenu(() => () => {});

  const send = (t: string) => store.send(t);
  const stop = () => void store.interrupt();

  /**
   * `@` completion. The composer asks for a directory relative to the session's
   * own cwd (or absolute when the token starts with /), and gets back bare
   * names — directories keep their trailing slash so picking one continues into
   * it rather than ending the token.
   */
  const listDir = async (dir: string): Promise<string[]> => {
    const base = props.dir || "";
    const target = dir.startsWith("/") ? dir : `${base}/${dir}`.replace(/\/+/g, "/");
    try {
      const entries = await fileList(target || "/");
      return entries.map((e) => (e.isDir ? `${e.name}/` : e.name));
    } catch {
      // A path that does not exist yet is an ordinary state while typing.
      return [];
    }
  };

  /**
   * Attach files to the text view's composer: upload each one, and return the
   * ones the chat can actually read back (design 2026-08-17).
   *
   * The SERVER decides what became attachable. An image always reaches the
   * per-(user, session) store; a document does only up to the store cap, and
   * above it stays an ephemeral /tmp transfer whose path is still useful to
   * Claude but which a chip would outlive. `stored:false` is that answer, and it
   * earns a toast rather than a chip — sending a message whose attachment quietly
   * expires in seven days would be worse than saying so now.
   *
   * The routine itself is shared with the new-session composer, which does the
   * same work at a different moment: it holds its files until the session it is
   * creating exists (clipboard/attach.ts).
   */
  const attachFiles = (files: File[]): Promise<DraftAttachment[]> =>
    uploadAttachments(files, session, { notify: props.notify });

  const resolve = (reqId: string, d: PermissionDecision) =>
    void store.resolvePermission(reqId, d);

  // ---- mobile input subsystem (design pillar #2 — Mobile/Touch) -----------
  // Coarse-pointer only. The soft-key toolbar + mobile compose route bytes into
  // the LIVE session pty via the terminal iframe (both views stay mounted, so
  // the pty is alive even while text mode shows). `body.has-soft-keys` reserves
  // a REAL height so the view surface shrinks above the toolbar.
  const coarse = createCoarsePointer();
  // The phone bar carries a back control and a view switch and still has to
  // name the session, so the per-session actions move behind a ⋯. No poll to
  // hold here — that contract belongs to the sidebar's menus, whose list a poll
  // can rebuild underneath them.
  const flip = createMobileFlip();
  const barMenu = createDismissableMenu(() => () => {});
  // The soft-key row and the Text view's send-to-terminal both write bytes at
  // the pty. A read-only tmux client discards them, so while watching this
  // refuses and says why once, rather than leaving a row of keys that look live.
  // The row itself stays put: the real keyboard is equally inert while watching,
  // and Dismiss keyboard lives in there, so removing it would strip the way off
  // a raised keyboard on a phone.
  const sendBytesToPty = (bytes: string): void => {
    if (watch()) {
      props.notify?.(inertReason(), "info");
      return;
    }
    window.__tlSendToTerminal?.(bytes);
  };
  const dismissKeyboard = (): void => {
    const el = document.activeElement as HTMLElement | null;
    el?.blur?.();
  };
  // Keyboard-offset plumbing (--kb-offset / --sk-h / --app-vh) lives in App,
  // not here. It used to be installed by this component, which meant it ran
  // once PER KEPT SESSION — every session opened in the tab stays mounted, so
  // five sessions meant five syncs writing the same three custom properties and
  // five copies of every viewport diagnostic — and, more to the point, it did
  // not run at all on the list screen, where nothing but the seeded --app-vh
  // was ever published. The sidebar's own keyboard reservation needs the live
  // value with no session open, so the sync moved up to the shell.

  /** The composer's sinks, handed over when the Text view mounts. Every gesture
   *  that lands OUTSIDE the composer arrives through these: a window drop, the
   *  Paste button, the ⌘V chord, the command palette, a gallery tile. */
  let composer: ComposerSinks | undefined;

  // ---- image clipboard subsystem (design pillar #2 — Gallery/Images) -------
  // Paste path + full-screen drop-target: an image paste/drop uploads to the
  // per-session clipboard store and the returned path is typed into the pty via
  // the tl-input bridge (window.__tlSendToTerminal); non-image drops ride /tmp.
  // Scoped to the mounted session (there IS a pty to send to). Pastes/drops that
  // land inside the terminal iframe are handled by the ttyd page's own listeners
  // (a separate document); this covers the SPA chrome (text mode, gallery).
  const image = installImageClipboard({
    session: () => session,
    sendToPty: (t) => window.__tlSendToTerminal?.(t) ?? false,
    enabled: () => !watch(),
    // The one subsystem in this file that had no `onScreen` in it, and the one
    // that needed it most: its listeners are on the shared DOCUMENT, and every
    // session this tab has opened is still mounted behind a CSS class. Without
    // this each of them handled the same paste, uploading a copy into its own
    // bucket and typing its own path into the one visible terminal.
    active: onScreen,
    // Route on the ACTIVE VIEW (design 2026-08-17 decision 5). In the text view a
    // paste or a drop belongs to the composer — which is the bug this fixes: the
    // capture-phase paste listener swallowed every image and typed its path at a
    // terminal the reader was not looking at. Watching keeps the old path, so the
    // one "nothing is typed into it" refusal still comes from one place.
    composerOwns: () => mode() === "text" && !watch(),
    onComposerFiles: async (files) => {
      const added = await attachFiles(files);
      if (added.length) attachToComposer(added);
    },
  });
  onCleanup(image.dispose);

  // Paste is performed HERE, in the lobby document, and only the result is
  // sent down — the frame cannot read the clipboard, because the async
  // clipboard is gated on document focus and clicking a lobby control focuses
  // the lobby (clipboard/paste.ts). Published on the window so the command
  // palette and the Paste chord reach the same routine as the button.
  const doPaste = (): boolean => {
    // The button is disabled while watching, but this routine is also the
    // command palette's Paste, the Paste chord and the soft-keys' Paste — all of
    // which reach it without a button. Answered here so every one of them says
    // the same thing instead of appearing to work.
    if (watch()) {
      props.notify?.(inertReason(), "info");
      return true;
    }
    // Routed on the ACTIVE VIEW, like every other intake (design 2026-08-17
    // decision 5). This routine is what the Paste BUTTON, the ⌘V chord, the
    // soft-keys and the command palette all take, and it still pointed at the
    // pty after the first deploy — so in text mode a pasted screenshot uploaded
    // and put its path on a terminal input line the reader could not see. On a
    // phone that button is the only way to paste, which is where the report came
    // from. `watch()` is already answered above, so the composer is drivable
    // whenever text mode is showing and it has registered.
    const toComposer = mode() === "text" ? composer : undefined;
    void pasteIntoTerminal({
      sendPasteText: (t) => {
        if (toComposer) {
          toComposer.insertText(t);
          return true;
        }
        return window.__tlPasteToTerminal?.(t) ?? false;
      },
      uploadFiles: async (files) => {
        if (!toComposer) {
          await image.uploadFiles(files, "picker");
          return;
        }
        const added = await attachFiles(files);
        if (added.length) toComposer.add(added);
      },
      // The advice when a read is refused has to match the device AND the view:
      // a phone has no ⌘/Ctrl-V but does have a long-press Paste, and in text
      // mode the terminal is not on screen to long-press.
      coarsePointer: coarse(),
      surface: toComposer ? "composer" : "terminal",
    });
    return true;
  };
  ownWhile(onScreen, "__tlDoPaste", doPaste);

  // The 🖼 gallery is a lobby overlay and the tray belongs to the composer, so
  // neither has a handle on the other. Same bridge the paste routine uses.
  const attachToComposer = (items: DraftAttachment[]): boolean => {
    if (!composer || watch()) return false;
    if (mode() !== "text") setMode("text");
    composer.add(items);
    return true;
  };
  ownWhile(onScreen, "__tlAttachToComposer", attachToComposer);

  // ---- terminal controls in the session bar -------------------------------
  // A−/A+ step the ROAMED font size, so the change follows the user to their
  // other devices and reaches the live terminal through the prefs bridge
  // without dropping its WebSocket. clampFontSize keeps the step inside the
  // 6..22 the terminal page validates against, so holding A− cannot walk the
  // pref out of range.
  const stepFont = (delta: number): void => {
    const p = props.prefs;
    if (!p) return;
    p.setFontSize(clampFontSize(p.prefs().fontSize + delta));
  };

  // The Upload button is a file picker in front of the SAME intake the drop
  // path uses — one upload flow, so the toasts, the gallery routing and the
  // path typed at the prompt cannot drift apart.
  let fileInput: HTMLInputElement | undefined;
  const onFilesPicked = (e: Event): void => {
    const el = e.currentTarget as HTMLInputElement;
    const files = [...(el.files ?? [])];
    el.value = ""; // let the same file be picked again
    if (files.length) void image.uploadFiles(files, "picker");
  };

  return (
    <div class="tl-session-view" data-mode={mode()}>
      <div class="tl-session-bar">
        {props.leading}
        {/* The session name doubles as the switcher on a phone: tapping it
            lists the others, so changing session does not mean going back to
            the list, finding it and tapping again. On a desktop it stays a
            label — the sidebar is right there. Either way it shows the
            session's TITLE when it has one, like every other surface. */}
        <Show
          when={props.onSwitchSession && coarse()}
          fallback={
            <span class="tl-session" title={session}>
              {props.label ?? session}
            </span>
          }
        >
          <span class="tl-session-picker" ref={picker.anchor}>
            <button
              type="button"
              class="tl-session tl-session-switch"
              aria-haspopup="menu"
              aria-expanded={picker.open()}
              title={session}
              onClick={() => picker.toggle()}
            >
              {props.label ?? session}
              <span class="tl-session-caret">▾</span>
            </button>
            <Show when={picker.open()}>
              <div class="tl-menu tl-session-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                <For each={props.otherSessions?.() ?? []}>
                  {(other) => (
                    <button
                      type="button"
                      class="tl-menu-item"
                      role="menuitem"
                      title={other.name}
                      onClick={() => {
                        picker.close();
                        props.onSwitchSession?.(other.name, other.owner);
                      }}
                    >
                      {other.label ?? other.name}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </span>
        </Show>
        {/* THE badge, on both views (ADR-0016). It used to be the text view's
            SSE status and only that, hidden on the Terminal view because a
            status for a surface you are not looking at reads as the terminal's
            — which left the terminal, the one thing in front of you, reporting
            nothing at all. It now shows the worst of every channel this surface
            can honestly report, and opens the panel that says which. */}
        <Show when={props.status}>
          {(s) => (
            <StatusDot
              class="tl-conn-badge"
              channels={s().channels}
              only={SESSION_CHANNELS}
              onOpen={s().onOpen}
            />
          )}
        </Show>
        <span class="tl-session-bar-spacer" />
        {/* Terminal controls, in the order the vanilla page's floating cluster
            uses them: size, then the three things you put INTO the session.
            Hidden on a coarse pointer, where a two-finger pinch sets the font and
            the composer's own 📎 attaches — the same split vanilla makes.
            Also hidden in the TEXT view (design 2026-08-17 decision 6): A−/A+
            size a terminal you are not looking at, and Upload/Paste would type a
            path into it, which is the behaviour this change exists to stop. The
            gallery is not in here — it is view-agnostic and stays. */}
        {/* The gallery is view-agnostic: every image the session touched, whether
            you are reading the transcript or driving the pty. So it sits OUTSIDE
            the terminal tools, which the text view hides. */}
        <Show when={!coarse()}>
          <button
            class="tl-icon-btn tl-gallery-btn"
            aria-label="Session images"
            title="Session images"
            onClick={() => props.onOpenGallery?.()}
          >
            <ImageIcon />
            <span class="tl-btn-label">Images</span>
          </button>
        </Show>
        <Show when={!coarse() && mode() === "terminal"}>
          <span class="tl-term-tools">
            <button
              class="tl-icon-btn tl-font-btn"
              aria-label="Smaller terminal font"
              title="Smaller terminal font"
              onClick={() => stepFont(-1)}
            >
              A&#8722;
            </button>
            <button
              class="tl-icon-btn tl-font-btn"
              aria-label="Larger terminal font"
              title="Larger terminal font"
              onClick={() => stepFont(1)}
            >
              A+
            </button>
            {/* Upload and Paste both end by TYPING a path or the clipboard into
                the pty, so a read-only client cannot complete either — and an
                upload is the worse half: it files the image in the session's
                gallery first, so leaving it enabled while watching means a
                half-done action (the image lands, the path never arrives).
                Disabled rather than hidden, so the bar keeps its shape and the
                tooltip says why. */}
            <button
              class="tl-icon-btn tl-upload-btn"
              aria-label="Upload image"
              disabled={watch()}
              title={inertReason() || "Upload image"}
              onClick={() => fileInput?.click()}
            >
              <CameraIcon />
              <span class="tl-btn-label">Upload</span>
            </button>
            <button
              class="tl-icon-btn tl-paste-btn"
              aria-label="Paste from clipboard"
              disabled={watch()}
              title={inertReason() || "Paste from clipboard"}
              onClick={() => doPaste()}
            >
              <ClipboardIcon />
              <span class="tl-btn-label">Paste</span>
            </button>
          </span>
        </Show>
        {/* Files and Watch are buttons wherever the bar has room. On a phone
            they move into the ⋯ below: the bar also has to carry a back control
            and the view switch, and measured at 390px the six of them together
            left 29px for the session name. */}
        <Show when={!flip()}>
          <button
            class="tl-icon-btn tl-preview-btn"
            aria-label="File preview"
            title="Preview files"
            onClick={() => preview.show()}
          >
            <FileTextIcon />
            <span class="tl-btn-label">Files</span>
          </button>
          {/* Watch mode. Deliberately OUTSIDE the coarse-pointer guard and next
              to the view switch, because the phone is where it matters most and
              it has to be reachable from the TEXT view — the Terminal view's
              first show is what triggers the attach, and an attach that has
              already happened read-write has already claimed the grid. The ⋯
              below keeps that property: the bar is shared by both views. */}
          <button
            class="tl-icon-btn tl-watch-btn"
            classList={{
              "tl-watch-on": watch(),
              // Driving in a LENS: the one control that says "what you type
              // lands in someone else's session". The tinted frame says whose.
              "tl-watch-lens-drive": !!lens() && !watch(),
            }}
            aria-label={
              watch()
                ? lens()
                  ? `Watching ${lens()} — tap to type in their session`
                  : "Watching — tap to take control"
                : lens()
                  ? `Typing in ${lens()}'s session — tap to watch only`
                  : "Watch only"
            }
            aria-pressed={watch()}
            title={
              watch()
                ? lens()
                  ? inertReason()
                  : "Watching: this device can't type and never resizes the session"
                : lens()
                  ? `Typing in ${lens()}'s session, as them. Their grid follows this window while you drive it.`
                  : "Watch only: observe without typing or resizing the session"
            }
            onClick={() => toggleWatch()}
          >
            <EyeIcon />
            <span class="tl-btn-label">{watch() ? "Watching" : "Watch"}</span>
          </button>
        </Show>
        <Show when={flip()}>
          <span class="tl-bar-menu" ref={barMenu.anchor}>
            <button
              class="tl-icon-btn tl-bar-menu-btn"
              aria-label="Session actions"
              aria-haspopup="menu"
              aria-expanded={barMenu.open()}
              onClick={barMenu.toggle}
            >
              ⋯
            </button>
            <Show when={barMenu.open()}>
              <div class="tl-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                <button
                  class="tl-menu-item"
                  role="menuitem"
                  onClick={() => {
                    barMenu.close();
                    preview.show();
                  }}
                >
                  Files
                </button>
                {/* On a phone there is no chord to press, and the header has no
                    room for another control — it measured 25px past its own
                    edge at 390px. The menu is where this reaches a thumb. */}
                <Show when={mode() === "text"}>
                  <button
                    class="tl-menu-item"
                    role="menuitem"
                    onClick={() => {
                      barMenu.close();
                      openFind();
                    }}
                  >
                    Find in session
                  </button>
                </Show>
                <button
                  class="tl-menu-item"
                  role="menuitemcheckbox"
                  aria-checked={watch()}
                  onClick={() => {
                    barMenu.close();
                    toggleWatch();
                  }}
                >
                  {watch() ? "✓ Watching" : "Watch only"}
                </button>
                {/* The shell's own items (Settings). display:contents keeps the
                    menu's layout while giving their clicks somewhere to bubble
                    to — the shell has no handle on this menu to close it. */}
                <span
                  style={{ display: "contents" }}
                  onClick={() => barMenu.close()}
                >
                  {props.menuExtra}
                </span>
              </div>
            </Show>
          </span>
        </Show>
        <ViewSwitch
          mode={mode()}
          onSet={setMode}
          textDot={textDot()}
          terminalDot={terminalDot()}
        />
      </div>

      {/* tl-kb-inline: while the TERMINAL view shows, this container does NOT
          reserve room for the soft keyboard — the frame does it internally, so
          the frame never moves out from under the tap that opened the keyboard.
          The Text view keeps the reservation: its composer is out here. */}
      <main class="tl-views" classList={{ "tl-kb-inline": mode() === "terminal" }}>
        <section class="tl-view" classList={{ "tl-hidden": mode() !== "text" }} aria-hidden={mode() !== "text"}>
          <TextView
            onScreen={onScreen()}
            events={store.events}
            rows={rows}
            working={working()}
            background={props.background}
            pending={pending()}
            onSend={send}
            onStop={stop}
            onResolve={resolve}
            sendToTerminal={coarse() ? sendBytesToPty : undefined}
            onOpenPreview={(path) => void preview.open(path)}
            onKeys={store.answer}
            onPane={store.pane}
            onAnswerText={store.answerText}
            notify={props.notify}
            onCommands={store.commands}
            pendingPrompts={store.pendingPrompts}
            opening={store.opening()}
            onLoadFull={store.fullResult}
            onLoadEarlier={async () => {
              await store.loadEarlier();
            }}
            hasEarlier={store.hasEarlier()}
            onOpenTerminal={() => setMode("terminal")}
            sessionState={store.state()}
            onListDir={listDir}
            session={session}
            me={props.me?.() ?? ""}
            onAttach={attachFiles}
            inertReason={inertReason()}
            register={(api) => (composer = api)}
          />
        </section>
        <section class="tl-view" classList={{ "tl-hidden": mode() !== "terminal" }} aria-hidden={mode() !== "terminal"}>
          {/* `?native=1` swaps the ttyd iframe for the terminal this app renders
              itself. Off by default and read once per tab: the native path
              attaches, reconnects, resizes and types, and does not yet carry
              paste, the soft keys, selection/copy, pinch-zoom or sixel — so it
              is a thing to measure against the iframe, not a thing to default
              anyone onto. The iframe stays the shipped terminal until parity is
              proven, on a real iPad among other places. */}
          <Show when={nativeTerminal()} fallback={<TerminalView
            session={session}
            owner={props.owner}
            active={mode() === "terminal" && onScreen()}
            // The bridges (send/paste/focus/refit) follow the session on screen
            // even while it is showing its text view, because that is the pty
            // the composer's "send to terminal" means.
            ownsBridges={onScreen()}
            creating={props.creating}
            dir={props.dir}
            watch={watch()}
            newCommand={props.newCommand}
            onFrameCommand={props.onFrameCommand}
            onFrameAlt={props.onFrameAlt}
            onFrameAttention={onAttention}
            onFrameBuildStale={props.onFrameBuildStale}
            // Only the session ON SCREEN speaks for the terminal channel. Every
            // visited session stays mounted, so without this guard a hidden
            // tab's frame would keep overwriting the badge for the one being
            // looked at.
            onFrameConn={(r) => onScreen() && props.status?.onFrameConn(r)}
            askConn={(ask) => (frameAsk = ask)}
            retryConn={(retry) => (frameRetry = retry)}
          />}>
            <TerminalNative
              args={terminalFrameArgs(session, {
                cmd: props.creating ? props.newCommand?.() : undefined,
                dir: props.dir || undefined,
                owner: props.owner || undefined,
                watch: watch(),
              })}
              watch={watch}
              // The bridges follow the session on screen, exactly as they do
              // for the iframe: they are named globals, and a hidden session
              // owning them would take the soft keys and paste with it.
              ownsBridges={onScreen()}
              onConn={(r) => onScreen() && props.status?.onFrameConn(r)}
              // BOTH levers, as the iframe branch above publishes both. Without
              // the ask, the badge and Run check could only ever read what a
              // native terminal had volunteered on its last change, so a
              // session returning to the screen above an already-open terminal
              // sat on "not reporting" (ADR-0016).
              onReady={(control) => {
                frameRetry = control.reconnect;
                frameAsk = control.ask;
              }}
            />
          </Show>
        </section>
      </main>

      {/* TERMINAL view only. The keys are terminal affordances — Esc, ⇧Tab, the
          arrows, Ctrl/Alt — and text mode has a text field, not a pty: they
          took two rows above the keyboard for nothing (Viktor, 2026-08-17).
          Unmounting rather than hiding, so the toolbar's own cleanup hands
          --sk-h back to the view and the composer sits on the keyboard.

          On screen only, and that clause is load-bearing since the lobby began
          keeping sessions mounted: every mounted toolbar carries `id="soft-keys"`
          and publishes `--sk-h` from its own height, so a hidden one — measuring
          0 inside display:none — would take the reservation away from the
          toolbar you are actually looking at. */}
      <Show when={coarse() && mode() === "terminal" && onScreen()}>
        <SoftKeys
          send={sendBytesToPty}
          onCopy={() => window.__tlForwardToTerminal?.("terminal.copy")}
          onPaste={() => doPaste()}
          onDismissKeyboard={dismissKeyboard}
        />
      </Show>

      <Show when={image.dropActive()}>
        <div class="tl-drop-overlay" aria-hidden="true">
          {watch()
            ? inertReason()
            : mode() === "text"
              ? "Drop files — they attach to the message you are writing"
              : "Drop files — paths are typed into the session (images join its gallery)"}
        </div>
      </Show>

      <Show when={preview.isOpen()}>
        <FilePreview store={preview} />
      </Show>

      <Show when={finding()}>
        <FindInSession
          onSearch={store.search}
          onJump={jumpToEvent}
          onClose={() => setFinding(false)}
        />
      </Show>

      {/* The Upload button's picker. `capture` is deliberately absent: on a
          phone that would force the camera and skip the photo library, and the
          soft-key row owns upload on touch anyway. */}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        class="tl-hidden-input"
        aria-hidden="true"
        tabindex={-1}
        onChange={onFilesPicked}
      />
    </div>
  );
};
