import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Component,
  type JSX,
} from "solid-js";
import { createSessionStore, type NotifyKind } from "../store/session";
import type { SseStatus } from "../sse/client";
import { createViewMode } from "../store/viewmode";
import { createWatchMode, clearResolvedWatch } from "../store/watchmode";
import { pendingPermissions, sessionWorking, deriveRows } from "./timeline.logic";
import type { PermissionDecision } from "../types/events";
import { ViewSwitch } from "./ViewSwitch";
import { TextView } from "./TextView";
import { TerminalView } from "./TerminalView";
import { FilePreview } from "./FilePreview";
import { createPreviewStore } from "../store/preview";
import { SoftKeys } from "./SoftKeys";
import { createCoarsePointer } from "../mobile/pointer";
import { installViewportSync } from "../mobile/viewport";
import { installImageClipboard } from "../clipboard/attach";
import { pasteIntoTerminal } from "../clipboard/paste-into-terminal";
import {
  CameraIcon,
  ClipboardIcon,
  EyeIcon,
  FileTextIcon,
  ImageIcon,
} from "./Icons";
import { clampFontSize, type PrefsStore } from "../store/prefs";

/**
 * The stream badge's wording. Every status but one reads fine as-is; a session
 * with no Claude transcript is not a broken connection, so it must not borrow
 * the vocabulary of one (it keeps the base muted-grey `.tl-conn` styling — the
 * colour overrides in app.css only cover the connection states).
 */
const connLabel = (s: SseStatus): string =>
  s === "no-transcript" ? "no transcript" : s;

const connTitle = (s: SseStatus): string =>
  s === "no-transcript"
    ? "no Claude transcript for this session — it streams as soon as one starts"
    : `stream: ${s}`;

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
  /** FALSE while an ancestor is display:none — the phone layout hides the whole
   *  session pane to give the list the screen. It folds into TerminalView's
   *  `active`, so the frame is told it is hidden and stops fitting: a fit
   *  measured against a 0x0 box would resize the REAL tmux window, and tmux
   *  sizes a window to its smallest attached client — every other client on
   *  that session would be dragged down with it. Defaults to visible. */
  visible?: boolean;
  /** Bar slots. On a phone the shell bar is folded into this one to buy back a
   *  40px row, so the back control and Settings are passed in from the shell
   *  rather than duplicated here. Empty on a desktop, where the shell bar
   *  carries them itself. */
  leading?: JSX.Element;
  trailing?: JSX.Element;
  /** real OS-user owner when this is a shared/foreign attach (else undefined). */
  owner?: string;
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
  /** the file-preview overlay's open + unsaved-draft state, published UP so the
   *  shell's keybinding context can refuse to switch session out from under an
   *  unsaved edit (the preview store is per-session and dies with this view). */
  onPreviewState?: (state: { open: boolean; dirty: boolean }) => void;
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
  );
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
  let prevToggleView: (() => boolean) | undefined;
  onMount(() => {
    prevToggleView = window.__tlToggleView;
    window.__tlToggleView = toggleView;
  });
  onCleanup(() => {
    if (window.__tlToggleView === toggleView) window.__tlToggleView = prevToggleView;
  });

  const send = (t: string) => store.send(t);
  const stop = () => void store.interrupt();
  const resolve = (reqId: string, d: PermissionDecision) =>
    void store.resolvePermission(reqId, d);

  // ---- mobile input subsystem (design pillar #2 — Mobile/Touch) -----------
  // Coarse-pointer only. The soft-key toolbar + mobile compose route bytes into
  // the LIVE session pty via the terminal iframe (both views stay mounted, so
  // the pty is alive even while text mode shows). `body.has-soft-keys` reserves
  // a REAL height so the view surface shrinks above the toolbar.
  const coarse = createCoarsePointer();
  const sendBytesToPty = (bytes: string): void => {
    window.__tlSendToTerminal?.(bytes);
  };
  const dismissKeyboard = (): void => {
    const el = document.activeElement as HTMLElement | null;
    el?.blur?.();
  };
  // Reserve the toolbar height on <body> while the toolbar is mounted.
  createEffect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("has-soft-keys", coarse());
  });
  onCleanup(() => {
    if (typeof document !== "undefined") {
      document.body.classList.remove("has-soft-keys");
    }
  });
  // Keyboard-offset plumbing: publish --kb-offset / --sk-h and ask the terminal
  // iframe to re-fit after the keyboard settles.
  onMount(() => {
    const dispose = installViewportSync({
      onRefit: () => window.__tlRefitTerminal?.(),
    });
    onCleanup(dispose);
  });

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
  });
  onCleanup(image.dispose);

  // Paste is performed HERE, in the lobby document, and only the result is
  // sent down — the frame cannot read the clipboard, because the async
  // clipboard is gated on document focus and clicking a lobby control focuses
  // the lobby (clipboard/paste.ts). Published on the window so the command
  // palette and the Paste chord reach the same routine as the button.
  const doPaste = (): boolean => {
    void pasteIntoTerminal({
      sendPasteText: (t) => window.__tlPasteToTerminal?.(t) ?? false,
      uploadFiles: image.uploadFiles,
    });
    return true;
  };
  let prevDoPaste: (() => boolean) | undefined;
  onMount(() => {
    prevDoPaste = window.__tlDoPaste;
    window.__tlDoPaste = doPaste;
  });
  onCleanup(() => {
    if (window.__tlDoPaste === doPaste) window.__tlDoPaste = prevDoPaste;
  });

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
        <span class="tl-session" title="session">
          {session}
        </span>
        {/* The TEXT view's status, and only its. It reports the SSE transcript
            stream that feeds that view — on the Terminal view (v1's default,
            with the text view deferred) it was the bar's ONLY badge, so a plain
            shell session read as a permanent "no transcript" about a view it
            cannot use, while saying nothing about the live terminal in front of
            it. A status for a surface you are not looking at is worse than no
            status: it reads as the terminal's. */}
        <Show when={mode() === "text"}>
          <span
            class="tl-conn"
            data-status={store.status()}
            title={connTitle(store.status())}
          >
            {connLabel(store.status())}
          </span>
        </Show>
        <span class="tl-session-bar-spacer" />
        {/* Terminal controls, in the order the vanilla page's floating cluster
            uses them: size, then the three things you put INTO the session.
            Hidden on a coarse pointer, where the soft-key row already carries
            paste/upload/images and a two-finger pinch sets the font — the same
            split vanilla makes. */}
        <Show when={!coarse()}>
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
            <button
              class="tl-icon-btn tl-gallery-btn"
              aria-label="Session images"
              title="Session images"
              onClick={() => props.onOpenGallery?.()}
            >
              <ImageIcon />
              <span class="tl-btn-label">Images</span>
            </button>
            <button
              class="tl-icon-btn tl-upload-btn"
              aria-label="Upload image"
              title="Upload image"
              onClick={() => fileInput?.click()}
            >
              <CameraIcon />
              <span class="tl-btn-label">Upload</span>
            </button>
            <button
              class="tl-icon-btn tl-paste-btn"
              aria-label="Paste from clipboard"
              title="Paste from clipboard"
              onClick={() => doPaste()}
            >
              <ClipboardIcon />
              <span class="tl-btn-label">Paste</span>
            </button>
          </span>
        </Show>
        <button
          class="tl-icon-btn tl-preview-btn"
          aria-label="File preview"
          title="Preview files"
          onClick={() => preview.show()}
        >
          <FileTextIcon />
          <span class="tl-btn-label">Files</span>
        </button>
        {/* Watch mode. Deliberately OUTSIDE the coarse-pointer guard and next to
            the view switch, because the phone is where it matters most and it
            has to be reachable from the TEXT view — the Terminal view's first
            show is what triggers the attach, and an attach that has already
            happened read-write has already claimed the grid. */}
        <button
          class="tl-icon-btn tl-watch-btn"
          classList={{ "tl-watch-on": watch() }}
          aria-label={watch() ? "Watching — tap to take control" : "Watch only"}
          aria-pressed={watch()}
          title={
            watch()
              ? "Watching: this device can't type and never resizes the session"
              : "Watch only: observe without typing or resizing the session"
          }
          onClick={() => toggleWatch()}
        >
          <EyeIcon />
          <span class="tl-btn-label">{watch() ? "Watching" : "Watch"}</span>
        </button>
        <ViewSwitch
          mode={mode()}
          onSet={setMode}
          textDot={textDot()}
          terminalDot={terminalDot()}
        />
        {props.trailing}
      </div>

      <main class="tl-views">
        <section class="tl-view" classList={{ "tl-hidden": mode() !== "text" }} aria-hidden={mode() !== "text"}>
          <TextView
            events={store.events}
            working={working()}
            pending={pending()}
            onSend={send}
            onStop={stop}
            onResolve={resolve}
            sendToTerminal={coarse() ? sendBytesToPty : undefined}
            onOpenPreview={(path) => void preview.open(path)}
          />
        </section>
        <section class="tl-view" classList={{ "tl-hidden": mode() !== "terminal" }} aria-hidden={mode() !== "terminal"}>
          <TerminalView
            session={session}
            owner={props.owner}
            active={mode() === "terminal" && props.visible !== false}
            creating={props.creating}
            dir={props.dir}
            watch={watch()}
            newCommand={props.newCommand}
            onFrameCommand={props.onFrameCommand}
            onFrameAlt={props.onFrameAlt}
            onFrameAttention={onAttention}
            onFrameBuildStale={props.onFrameBuildStale}
          />
        </section>
      </main>

      <Show when={coarse()}>
        <SoftKeys
          send={sendBytesToPty}
          onCopy={() => window.__tlForwardToTerminal?.("terminal.copy")}
          onPaste={() => doPaste()}
          onDismissKeyboard={dismissKeyboard}
        />
      </Show>

      <Show when={image.dropActive()}>
        <div class="tl-drop-overlay" aria-hidden="true">
          Drop files — paths are typed into the session (images join its gallery)
        </div>
      </Show>

      <Show when={preview.isOpen()}>
        <FilePreview store={preview} />
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
