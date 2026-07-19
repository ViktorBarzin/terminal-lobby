import { For, Show, type Component } from "solid-js";
import type { ToastController } from "../store/toast";

/**
 * Top-right toast stack (feature-inventory §7). Renders the controller's typed
 * toasts; each carries a kind-colored accent, an optional detail block (the
 * slow-request coordinator's per-request rows), and a dismiss button. Purely
 * presentational — all lifecycle (auto-dismiss, slow coordination) lives in the
 * store.
 */
export const Toaster: Component<{ controller: ToastController }> = (props) => {
  return (
    <div class="tl-toaster" role="region" aria-label="Notifications">
      <For each={props.controller.toasts()}>
        {(t) => (
          <div
            class="tl-toast-card"
            data-kind={t.kind}
            role={t.kind === "error" ? "alert" : "status"}
          >
            <div class="tl-toast-body">
              <div class="tl-toast-message">{t.message}</div>
              <Show when={t.detail}>
                <pre class="tl-toast-detail">{t.detail}</pre>
              </Show>
            </div>
            <button
              type="button"
              class="tl-toast-close"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => props.controller.dismiss(t.id)}
            >
              ✕
            </button>
          </div>
        )}
      </For>
    </div>
  );
};
