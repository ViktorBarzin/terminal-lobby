import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import { createSessionStore, type NotifyKind } from "../store/session";
import { createViewMode } from "../store/viewmode";
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

/**
 * The per-session two-view surface (text + terminal), extracted from the old
 * top-level App so the lobby shell can mount ONE of these for the selected
 * session and remount it when the selection changes. Both views stay mounted
 * (CSS-hidden) so terminal state survives the Cmd/Ctrl-J toggle; the store's SSE
 * connection is closed on unmount (createSessionStore onCleanup).
 */
export const SessionView: Component<{
  session: string;
  /** real OS-user owner when this is a shared/foreign attach (else undefined). */
  owner?: string;
  /** current roamed newCommand key, for a newly-created session's terminal. */
  newCommand?: () => string;
  /** surface control-channel errors to the app's toast stack. */
  notify?: (message: string, kind: NotifyKind) => void;
  /** a chord fired inside the terminal iframe (tl-command) -> lobby dispatcher. */
  onFrameCommand?: (command: string) => void;
  /** the terminal iframe's Alt-hold state (tl-kb-alt) -> lobby badge overlay. */
  onFrameAlt?: (down: boolean) => void;
  /** the terminal iframe's attention signal (tl-attention) -> lobby tab badge. */
  onFrameAttention?: (kind: "bell" | "output", session: string | null) => void;
  /** open the session image gallery (🖼) — owned by the lobby shell. */
  onOpenGallery?: () => void;
}> = (props) => {
  const session = props.session;
  const store = createSessionStore(session, { notify: props.notify });
  const [mode, setMode, toggleMode] = createViewMode(() => session);

  const rows = createMemo(() => deriveRows(store.events));
  const working = createMemo(() => sessionWorking(rows()));
  const pending = createMemo(() => pendingPermissions(store.events));

  // ---- file preview surface (roadmap pillar #6) ---------------------------
  // Session-integrated overlay: opens from a Read/Edit/Write path in the
  // transcript, a transcript-derived recent-files list, or an explicit path.
  // Created here (per-session) so it disposes on session switch and its
  // recent-files list tracks THIS session's events.
  const preview = createPreviewStore({ events: () => store.events });

  const maxId = createMemo(() => {
    const last = store.events[store.events.length - 1];
    return last ? last.id : 0;
  });
  const [seenText, setSeenText] = createSignal(0);
  createEffect(() => {
    if (mode() === "text") setSeenText(maxId());
  });
  const textDot = createMemo(() => mode() !== "text" && maxId() > seenText());

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

  return (
    <div class="tl-session-view" data-mode={mode()}>
      <div class="tl-session-bar">
        <span class="tl-session" title="session">
          {session}
        </span>
        <span class="tl-conn" data-status={store.status()} title={`stream: ${store.status()}`}>
          {store.status()}
        </span>
        <span class="tl-session-bar-spacer" />
        <button
          class="tl-icon-btn tl-preview-btn"
          aria-label="File preview"
          title="Preview files"
          onClick={() => preview.show()}
        >
          📄
        </button>
        <button
          class="tl-icon-btn tl-gallery-btn"
          aria-label="Session images"
          title="Session images"
          onClick={() => props.onOpenGallery?.()}
        >
          🖼
        </button>
        <ViewSwitch mode={mode()} onSet={setMode} textDot={textDot()} />
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
            active={mode() === "terminal"}
            newCommand={props.newCommand}
            onFrameCommand={props.onFrameCommand}
            onFrameAlt={props.onFrameAlt}
            onFrameAttention={props.onFrameAttention}
          />
        </section>
      </main>

      <Show when={coarse()}>
        <SoftKeys
          send={sendBytesToPty}
          onCopy={() => window.__tlForwardToTerminal?.("terminal.copy")}
          onPaste={() => window.__tlForwardToTerminal?.("terminal.paste")}
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
    </div>
  );
};
