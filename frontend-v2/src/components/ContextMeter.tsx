import { For, Show, createSignal, type Component } from "solid-js";
import {
  breakdown,
  contextTone,
  formatTokens,
  percentFull,
  readingAge,
  type ContextState,
} from "./context.logic";

/**
 * How full the session's context is, beside the mode chip.
 *
 * The numbers are the CLI's own — `/context` publishes them into the transcript
 * and the normalizer carries them through — so the chip and the pane never
 * disagree, and the ceiling is right even on a 1m-context session where the
 * familiar 200k would have been wrong fivefold.
 *
 * Tapping opens the breakdown, which is the part that answers "what is eating
 * it": on the session this was built against, MCP tool definitions were 95.3k
 * against 25.8k of actual conversation.
 */
export const ContextMeter: Component<{ state: ContextState }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const r = () => props.state.reading;
  const pct = () => percentFull(r());
  const rows = () => breakdown(r()) ?? [];

  return (
    <div class="tl-ctx">
      <button
        type="button"
        class="tl-ctx-chip"
        // The fill drives the colour from CSS rather than a second mapping here,
        // the same way the mode chip does.
        data-tone={contextTone(r())}
        aria-expanded={open()}
        title={
          `Context ${pct()}% — ${formatTokens(r().usedTokens)} of ` +
          `${formatTokens(r().maxTokens)}${r().model ? ` on ${r().model}` : ""}` +
          `, read ${readingAge(props.state.turnsAgo)}`
        }
        onClick={() => setOpen(!open())}
      >
        {/* The bar is the reading; the number is for when a glance is not
            enough. Both come from the same value. */}
        <span class="tl-ctx-bar" aria-hidden="true">
          <span class="tl-ctx-fill" style={{ width: `${Math.min(100, pct())}%` }} />
        </span>
        <span class="tl-ctx-pct">{pct()}%</span>
      </button>

      <Show when={open()}>
        <div class="tl-ctx-panel" role="dialog" aria-label="Context usage">
          <div class="tl-ctx-head">
            <span class="tl-ctx-total">
              {formatTokens(r().usedTokens)} / {formatTokens(r().maxTokens)}
            </span>
            <Show when={r().model}>
              <span class="tl-ctx-model">{r().model}</span>
            </Show>
          </div>
          <Show
            when={rows().length > 0}
            fallback={<div class="tl-ctx-empty">No breakdown in this reading.</div>}
          >
            <ul class="tl-ctx-rows">
              <For each={rows()}>
                {(c) => (
                  <li class="tl-ctx-row">
                    <span class="tl-ctx-name">{c.name}</span>
                    <span class="tl-ctx-tokens">{formatTokens(c.tokens)}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          {/* A reading is a point in time. The server refreshes on open and
              after each settled turn, so anything but "just now" means a
              refresh was declined — the session was busy, blocked, or holding
              an unsent draft. Saying so beats showing a stale number as live. */}
          <div class="tl-ctx-age">read {readingAge(props.state.turnsAgo)}</div>
        </div>
      </Show>
    </div>
  );
};
