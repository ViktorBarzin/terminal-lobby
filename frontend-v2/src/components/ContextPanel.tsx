import { For, Show, type Component } from "solid-js";
import {
  breakdown,
  contextTone,
  formatTokens,
  percentFull,
  readingAge,
  type ContextState,
} from "./context.logic";

/**
 * What fills the session's context window, behind the context dial.
 *
 * The numbers are the CLI's own: `/context` publishes them into the transcript
 * and the normalizer carries them through, so the dial and the pane never
 * disagree, and the ceiling is right even on a 1m-context session where the
 * familiar 200k would have been wrong fivefold.
 *
 * The reading is whatever the last `/context` in the session said. Nothing
 * asks for a fresh one: the dial appears when a reading exists and stays away
 * when none does, rather than the view typing a command into somebody's pane
 * to have something to show (memory #11368). So the age is part of the
 * reading, and the way to a newer one is named, since it is the reader's to
 * run.
 *
 * The breakdown is the part that answers "what is eating it": on the session
 * this was first built against, MCP tool definitions were 95.3k against 25.8k
 * of conversation. It was a panel under a chip beside the mode chip until
 * 2026-09-24, and is the body of the context dial's popover now.
 */
export const ContextPanel: Component<{ state: ContextState }> = (props) => {
  const r = () => props.state.reading;
  const pct = () => percentFull(r());
  const rows = () => breakdown(r()) ?? [];
  return (
    <div class="tl-ctx-panel" data-tone={contextTone(r())}>
      <div class="tl-ctx-top">
        <span class="tl-ctx-big">{pct()}%</span>
        <span class="tl-ctx-of">
          {formatTokens(r().usedTokens)} of {formatTokens(r().maxTokens)} tokens
        </span>
      </div>
      <div class="tl-ctx-bar" aria-hidden="true">
        <span class="tl-ctx-fill" style={{ width: `${Math.min(100, pct())}%` }} />
      </div>
      <Show when={r().model}>
        <div class="tl-ctx-model">{r().model}</div>
      </Show>
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
      <div class="tl-ctx-age">
        Read {readingAge(props.state.turnsAgo)}. <code>/context</code> takes a newer one.
      </div>
    </div>
  );
};
