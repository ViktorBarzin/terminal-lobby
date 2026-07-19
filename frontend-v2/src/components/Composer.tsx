import { Show, type Component } from "solid-js";
import type { PermissionDecision } from "../types/events";
import type { PendingPermission } from "./timeline.logic";
import { PermissionPanel } from "./PermissionPanel";

/**
 * Prompt composer with the permission panel docked above it. Send↔Stop morphs
 * on `working` (design: Stop = inject ESC/Ctrl-C into the pty). Enter sends,
 * Shift+Enter inserts a newline. When a permission is pending and the input is
 * empty, 1 approves / 2 denies (T3 number-key affordance).
 */
export const Composer: Component<{
  working: boolean;
  pending: PendingPermission[];
  onSend: (text: string) => void;
  onStop: () => void;
  onResolve: (reqId: string, decision: PermissionDecision) => void;
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
    props.onSend(t);
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
