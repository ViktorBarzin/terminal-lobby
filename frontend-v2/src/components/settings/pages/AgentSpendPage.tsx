import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";
import {
  SPEND_PERIODS,
  capitalizeFirst,
  claudeWindowLabel,
  fetchAgentSpend,
  formatResetsIn,
  formatTokens,
  formatUsd,
  liveWindows,
  type AgentSpend,
  type ClaudeSpend,
  type CodexSpend,
  type SpendPeriod,
} from "../../../lib/agent-spend";
import { Group, Readout } from "../controls";

/**
 * What the agents have consumed: one section per tool, each in that tool's own
 * vocabulary.
 *
 * Claude Code computes dollars and reports rate-limit windows only on a Pro or
 * Max seat, so its section leads with spend and shows windows when there are
 * any. A ChatGPT plan reports no cost at all, so the Codex section leads with
 * the two windows OpenAI names — the "5-hour limit" and the "weekly limit" —
 * and counts tokens underneath. Neither section is drawn at all unless the
 * server sent it, which is what keeps a Claude-only box from being shown an
 * empty Codex heading.
 *
 * The bars borrow the Network page's meter grammar rather than inventing a
 * second one; the CSS rules list both class names.
 *
 * Design: docs/plans/2026-09-06-agent-spend-panel-design.md.
 */

/** What a session row shows for a name: its title when the lobby knows one. */
type TitleLookup = Accessor<ReadonlyArray<{ name: string; title?: string }>>;

export const AgentSpendPage: Component<{
  /** The caller's live sessions, so a row can show a title rather than an id.
   *  Absent in a tab that has no session list yet; rows then show the id. */
  sessionTitles?: TitleLookup;
}> = (props) => {
  const [period, setPeriod] = createSignal<SpendPeriod>("today");
  const [doc, setDoc] = createSignal<AgentSpend | null>(null);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  // Read once per period rather than polled: both sources move when a turn
  // completes, and a panel that reflowed while being read would be worse than
  // one that is a minute old.
  const [nowMs, setNowMs] = createSignal(Date.now());

  const abort = new AbortController();
  onCleanup(() => abort.abort());

  const load = async (p: SpendPeriod): Promise<void> => {
    setLoading(true);
    try {
      const next = await fetchAgentSpend(p, abort.signal);
      setDoc(next);
      setNowMs(Date.now());
      setError("");
    } catch (e) {
      if (abort.signal.aborted) return;
      setDoc(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  onMount(() => void load(period()));

  const pick = (p: SpendPeriod): void => {
    if (p === period()) return;
    setPeriod(p);
    void load(p);
  };

  /** The title the lobby holds for a session name, or nothing. */
  const titleOf = (name: string): string => {
    const hit = props.sessionTitles?.().find((s) => s.name === name);
    return hit?.title ?? "";
  };
  const sessionLabel = (name: string): string => titleOf(name) || name || "Unnamed session";

  const claude = (): ClaudeSpend | undefined => doc()?.claude;
  const codex = (): CodexSpend | undefined => doc()?.codex;
  const nothingYet = (): boolean => !!doc() && !claude() && !codex();

  return (
    <div class="tl-spend">
      {/* Periods first, one selectable row each, the same shape the Network
          page uses: the selection scopes everything below it. */}
      <div class="tl-spend-periods" role="radiogroup" aria-label="Period">
        <For each={SPEND_PERIODS}>
          {(p) => (
            <button
              type="button"
              role="radio"
              aria-checked={period() === p.key}
              class="tl-spend-period"
              classList={{ "is-on": period() === p.key }}
              onClick={() => pick(p.key)}
            >
              {p.label}
            </button>
          )}
        </For>
      </div>

      <Show when={error()}>
        <div class="tl-set-hint tl-set-hint-static">
          Could not read what the agents have consumed ({error()}).
        </div>
      </Show>

      <Show when={loading() && !doc()}>
        <div class="tl-set-hint tl-set-hint-static">Reading…</div>
      </Show>

      <Show when={nothingYet()}>
        <div class="tl-set-hint tl-set-hint-static">
          Nothing has reported yet. Figures appear once a Claude Code or Codex session has run a
          turn.
        </div>
      </Show>

      <Show when={claude()}>
        {(c) => (
          <Group title="Claude Code">
            {/* The spend for the period, as the heading figure: the one number
                someone opens this page for. */}
            <div class="tl-spend-figure">
              <b>{formatUsd(c().costUsd)}</b>
              <span class="tl-spend-figure-note">
                {periodNote(period())} · {formatTokens(c().tokens.input + c().tokens.output)} tokens
              </span>
            </div>

            <Show when={liveWindows(c().windows, nowMs()).length > 0}>
              <div class="tl-spend-meters">
                <For each={liveWindows(c().windows, nowMs())}>
                  {(w) => (
                    <Meter
                      label={claudeWindowLabel(w.name)}
                      percent={w.usedPercent}
                      note={formatResetsIn(w.resetsAtSec, nowMs())}
                    />
                  )}
                </For>
              </div>
            </Show>

            <Show when={c().models.length > 0}>
              <div class="tl-set-subhead">By model</div>
              <div class="tl-spend-rows">
                <For each={c().models}>
                  {(m) => (
                    <SpendRow
                      name={m.model}
                      meta={`${formatTokens(m.tokens.input + m.tokens.output)} tokens`}
                      value={formatUsd(m.costUsd)}
                    />
                  )}
                </For>
              </div>
            </Show>

            <div class="tl-set-subhead">Sessions</div>
            <Show
              when={c().sessions.length > 0}
              fallback={
                <div class="tl-set-hint tl-set-hint-static">
                  No Claude session ran in this period.
                </div>
              }
            >
              <div class="tl-spend-rows">
                <For each={c().sessions}>
                  {(s) => (
                    <SpendRow
                      session
                      name={sessionLabel(s.session)}
                      meta={[s.model, `${formatTokens(s.tokens.input + s.tokens.output)} tokens`]
                        .filter(Boolean)
                        .join(" · ")}
                      value={formatUsd(s.costUsd)}
                    />
                  )}
                </For>
              </div>
            </Show>
            {/* A session's figure is its running total since it started, which
                is a different question from the period's own arithmetic above.
                Saying so is cheaper than explaining the mismatch later. */}
            <div class="tl-set-hint tl-set-hint-static">
              A session's figure is what it has cost since it started, so it can be larger than the
              period above it. Claude Code computes these.
            </div>
          </Group>
        )}
      </Show>

      <Show when={codex()}>
        {(cx) => (
          <Group title="Codex">
            {/* Account-wide facts, so they sit above the sessions rather than
                inside them. */}
            <Show when={liveWindows(cx().windows, nowMs()).length > 0}>
              <div class="tl-spend-meters">
                <For each={liveWindows(cx().windows, nowMs())}>
                  {(w) => (
                    <Meter
                      label={capitalizeFirst(w.label)}
                      percent={w.usedPercent}
                      note={formatResetsIn(w.resetsAtSec, nowMs())}
                    />
                  )}
                </For>
              </div>
            </Show>

            <Show when={cx().plan || cx().credits}>
              <div class="tl-set-readouts">
                <Show when={cx().plan}>
                  {(plan) => <Readout label="Plan" value={capitalizeFirst(plan())} />}
                </Show>
                <Show when={cx().credits}>
                  {(cr) => (
                    <Readout label="Credits" value={cr().unlimited ? "Unlimited" : cr().balance} />
                  )}
                </Show>
              </div>
            </Show>

            <div class="tl-set-subhead">Sessions</div>
            <Show
              when={cx().sessions.length > 0}
              fallback={
                <div class="tl-set-hint tl-set-hint-static">No Codex conversation is running.</div>
              }
            >
              <div class="tl-spend-rows">
                <For each={cx().sessions}>
                  {(s) => (
                    <SpendRow
                      session
                      name={sessionLabel(s.session ?? "")}
                      meta={s.model ?? ""}
                      value={`${formatTokens(s.tokens.total)} tokens`}
                    />
                  )}
                </For>
              </div>
            </Show>
            <div class="tl-set-hint tl-set-hint-static">
              A ChatGPT plan reports no cost, so these are tokens and limits. Rows are the
              conversations running now.
            </div>
          </Group>
        )}
      </Show>
    </div>
  );
};

/** One percentage bar. Same grammar as the Network page's byte bars. */
const Meter: Component<{ label: string; percent: number; note?: string }> = (props) => (
  <div class="tl-spend-meter">
    <span class="tl-spend-meter-label">
      {props.label}
      <Show when={props.note}>
        <span class="tl-spend-meter-note"> {props.note}</span>
      </Show>
    </span>
    <span class="tl-spend-meter-value">{Math.round(props.percent)}%</span>
    <span class="tl-spend-meter-bar" aria-hidden="true">
      <span style={{ width: `${Math.min(Math.max(props.percent, 0), 100)}%` }} />
    </span>
  </div>
);

/** One line item: what it is, what it was doing, what it came to. `session`
 *  marks the rows that are conversations rather than models, which is how the
 *  two lists are told apart from outside. */
const SpendRow: Component<{
  name: string;
  meta?: string;
  value: JSX.Element;
  session?: boolean;
}> = (props) => (
  <div class="tl-spend-row" classList={{ "tl-spend-session": props.session }}>
    <span class="tl-spend-row-name">{props.name}</span>
    <Show when={props.meta}>
      <span class="tl-spend-row-meta">{props.meta}</span>
    </Show>
    <span class="tl-spend-row-value">{props.value}</span>
  </div>
);

/** How the heading figure names its period, in words rather than a key. */
function periodNote(p: SpendPeriod): string {
  switch (p) {
    case "today":
      return "today";
    case "7d":
      return "last 7 days";
    case "month":
      return "this month";
    case "all":
      return "all time";
  }
}
