import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import {
  CHANNEL_LABEL,
  SESSION_CHANNELS,
  scope,
  summarise,
  verdict,
  type ChannelId,
} from "../../diagnostics/status";
import type { ConnectionControl } from "../../diagnostics/status-store";
import { Group } from "./controls";

/** How long ago, in the words a person would use. */
function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)}h ago`;
}

function forHowLong(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)}h`;
}

/**
 * Right now — what this client's five channels are doing, and a button that
 * goes and finds out.
 *
 * It opens with a sentence rather than a table, because the question people
 * arrive with is "is it me?" and a row of dots does not answer it. The detail
 * underneath is for the second question, which is usually being asked by
 * someone helping.
 *
 * The panel never repairs on its own. A check that reconnected what it found
 * broken would destroy the state its reader came to look at, so every repair is
 * a separate, explicit tap on the row that needs it.
 */
export const RightNow: Component<{ conn: ConnectionControl }> = (props) => {
  const rows = () => scope(props.conn.channels(), SESSION_CHANNELS);
  // Ticks so "checked 2 min ago" does not sit frozen while the panel is open.
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    onCleanup(() => clearInterval(t));
  });

  const checkedLabel = () => {
    // Rows land one at a time, so a check is finished only when the slowest
    // probe is — up to 5s after the first timings appear. Saying "not checked
    // yet" beside a table of timings is the kind of small contradiction that
    // makes a reader distrust the rest of the panel.
    if (props.conn.checking()) return "Checking now";
    const at = props.conn.checkedAt();
    return at === null ? "Not checked yet" : `Checked ${ago(now() - at)}`;
  };

  const history = (id: ChannelId) => {
    const h = summarise(props.conn.log(), id);
    if (h.faults === 0) return null;
    const times = h.faults === 1 ? "once" : `${h.faults} times`;
    return `dropped ${times}`;
  };

  const measured = (id: ChannelId) => props.conn.lastCheck()[id]?.ms ?? null;

  return (
    <Group title="Right now">
      <p class="tl-rightnow-verdict" data-status={props.conn.worstNow()}>
        {verdict(rows())}
      </p>

      <div class="tl-rightnow-rows">
        <For each={rows()}>
          {(c) => (
            <div class="tl-rightnow-row" data-status={c.state}>
              <span class="tl-rightnow-mark" aria-hidden="true" />
              <span class="tl-rightnow-name">{CHANNEL_LABEL[c.id]}</span>
              <span class="tl-rightnow-detail">
                {c.detail}
                <Show when={history(c.id)}>
                  {(h) => <span class="tl-rightnow-history"> · {h()}</span>}
                </Show>
              </span>
              <Show when={measured(c.id) !== null}>
                <span class="tl-rightnow-ms">{measured(c.id)} ms</span>
              </Show>
              <Show when={props.conn.repairLabel(c.id)}>
                {(label) => (
                  <button
                    type="button"
                    class="tl-set-btn tl-rightnow-fix"
                    onClick={() => void props.conn.repair(c.id)}
                  >
                    {label()}
                  </button>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>

      <div class="tl-set-actions">
        <button
          type="button"
          class="tl-set-btn"
          disabled={props.conn.checking()}
          onClick={() => void props.conn.runCheck()}
        >
          {props.conn.checking() ? "Checking…" : "Run check"}
        </button>
      </div>

      <div class="tl-set-hint tl-set-hint-static">
        {checkedLabel()}. Watching this page for {forHowLong(now() - props.conn.bootedAt)}; the
        counts above reset when it reloads. Nothing here reconnects anything on its own.
      </div>
    </Group>
  );
};
