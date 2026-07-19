import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { createSessionStore, type NotifyKind } from "../store/session";
import { createViewMode } from "../store/viewmode";
import { pendingPermissions, sessionWorking, deriveRows } from "./timeline.logic";
import type { PermissionDecision } from "../types/events";
import { ViewSwitch } from "./ViewSwitch";
import { TextView } from "./TextView";
import { TerminalView } from "./TerminalView";

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
}> = (props) => {
  const session = props.session;
  const store = createSessionStore(session, { notify: props.notify });
  const [mode, setMode, toggleMode] = createViewMode(() => session);

  const rows = createMemo(() => deriveRows(store.events));
  const working = createMemo(() => sessionWorking(rows()));
  const pending = createMemo(() => pendingPermissions(store.events));

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
          />
        </section>
        <section class="tl-view" classList={{ "tl-hidden": mode() !== "terminal" }} aria-hidden={mode() !== "terminal"}>
          <TerminalView
            session={session}
            owner={props.owner}
            active={mode() === "terminal"}
            newCommand={props.newCommand}
          />
        </section>
      </main>
    </div>
  );
};
