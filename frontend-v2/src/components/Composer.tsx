import { Show, type Component } from "solid-js";
import type { PermissionDecision } from "../types/events";
import type { PendingPermission } from "./timeline.logic";
import { PermissionPanel } from "./PermissionPanel";
import { splitComposeSubmit } from "../mobile/compose";

/**
 * Prompt composer with the permission panel docked above it. Send↔Stop morphs
 * on `working` (design: Stop = inject ESC/Ctrl-C into the pty). Enter sends,
 * Shift+Enter inserts a newline. When a permission is pending and the input is
 * empty, 1 approves / 2 denies (T3 number-key affordance).
 *
 * Send routing (design pillar #2 — Mobile):
 *   - `sendToTerminal` present (mobile / coarse pointer): submit shapes the
 *     message as a bracketed paste + a SEPARATE trailing submit (compose.ts)
 *     and forwards both frames into the live session pty — the same-session
 *     prompt-inject that works today (the ttyd iframe bridge). A newline typed
 *     into the field stays a SOFT newline inside the paste; only the trailing
 *     \r submits.
 *   - otherwise: `onSend(text)` — the session control channel (session-events
 *     /prompt; see store/session.ts).
 * The mobile input attributes (autocapitalize off, autocorrect/spellcheck on,
 * enterkeyhint send) restore QuickType / swipe typing and are harmless on
 * desktop.
 */
export const Composer: Component<{
  working: boolean;
  pending: PendingPermission[];
  onSend: (text: string) => void;
  onStop: () => void;
  onResolve: (reqId: string, decision: PermissionDecision) => void;
  /** Mobile bridge: forward raw pty bytes to the live terminal iframe. When
   *  provided, submit uses the bracketed-paste + separate-submit split. */
  sendToTerminal?: (bytes: string) => void;
}> = (props) => {
  let ta: HTMLTextAreaElement | undefined;

  const autosize = () => {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };

  const submit = () => {
    const t = (ta?.value ?? "").trim();
    if (!t) return;
    if (props.sendToTerminal) {
      // Bracketed paste (soft newlines) + a SEPARATE trailing submit frame.
      const { paste, submit: cr } = splitComposeSubmit(t);
      props.sendToTerminal(paste);
      props.sendToTerminal(cr);
    } else {
      props.onSend(t);
    }
    if (ta) {
      ta.value = "";
      autosize();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const empty = (ta?.value ?? "") === "";
    // Number-key permission affordance (only when not mid-typing).
    if (empty && props.pending.length > 0 && (e.key === "1" || e.key === "2")) {
      const p = props.pending[0];
      if (p) {
        e.preventDefault();
        props.onResolve(p.reqId, e.key === "1" ? "allow" : "deny");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div class="tl-composer">
      <Show when={props.pending.length > 0}>
        <PermissionPanel pending={props.pending} onResolve={props.onResolve} />
      </Show>
      <div class="tl-composer-row">
        <textarea
          ref={ta}
          class="tl-composer-input"
          rows={1}
          placeholder="Message…  (Enter to send · Shift+Enter for newline)"
          autocapitalize="off"
          autocorrect="on"
          spellcheck={true}
          enterkeyhint="send"
          aria-label="Message to send to the session"
          onInput={autosize}
          onKeyDown={onKeyDown}
        />
        <Show
          when={props.working}
          fallback={
            <button type="button" class="tl-send" onClick={submit}>
              Send
            </button>
          }
        >
          <button type="button" class="tl-stop" onClick={() => props.onStop()}>
            Stop
          </button>
        </Show>
      </div>
    </div>
  );
};
