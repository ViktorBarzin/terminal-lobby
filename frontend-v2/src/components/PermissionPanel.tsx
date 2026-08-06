import { Show, type Component } from "solid-js";
import type { PermissionDecision } from "../types/events";
import type { PendingPermission } from "./timeline.logic";

/**
 * Composer-docked permission panel (design pillar #2, "highest-value adapt"
 * from T3): approvals surface here, not inline, keyed by reqId. Approve → allow,
 * Deny → deny (POSTed by the caller via `permissionUrl`). Number keys 1/2 are
 * wired in the Composer when the input is empty.
 *
 * INERT SINCE 575d4f5 (2026-07-21). The server half is gone: session-events no
 * longer runs the permission broker, no PreToolUse hook emits a request, and
 * the resolve route is neither served nor routed by the ingress. Nothing can
 * populate `pending`, so this renders nothing and the composer's 1/2 keys never
 * intercept — a live census of the deployed build finds zero `.tl-permpanel`.
 *
 * Kept rather than deleted because re-enabling is a scoping decision, not a
 * rewrite: the broker answered "ask" for any session nobody was watching in
 * Text mode, and a PreToolUse "ask" OVERRIDES the allowlist, so it forced a
 * prompt on every tool call for every user on the shared devvm. Any revival
 * needs a per-session gate first; this component and `permissionUrl` are the
 * client half waiting on it. Do not wire it to a hook without that gate.
 */
export const PermissionPanel: Component<{
  pending: PendingPermission[];
  onResolve: (reqId: string, decision: PermissionDecision) => void;
}> = (props) => {
  const first = () => props.pending[0];
  return (
    <Show when={first()}>
      {(p) => (
        <div class="tl-permpanel" role="dialog" aria-label="Permission request">
          <div class="tl-permpanel-body">
            <div class="tl-permpanel-title">
              Allow <b>{p().tool || "tool"}</b>?
            </div>
            <Show when={p().input}>
              <pre class="tl-code tl-permpanel-input">{p().input}</pre>
            </Show>
          </div>
          <div class="tl-permpanel-actions">
            <button
              type="button"
              class="tl-btn tl-btn-approve"
              onClick={() => props.onResolve(p().reqId, "allow")}
            >
              Approve <kbd>1</kbd>
            </button>
            <button
              type="button"
              class="tl-btn tl-btn-deny"
              onClick={() => props.onResolve(p().reqId, "deny")}
            >
              Deny <kbd>2</kbd>
            </button>
          </div>
          <Show when={props.pending.length > 1}>
            <div class="tl-permpanel-more">
              +{props.pending.length - 1} more pending
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
};
