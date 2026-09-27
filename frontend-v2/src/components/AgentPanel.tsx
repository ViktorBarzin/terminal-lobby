import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type Component,
} from "solid-js";
import {
  activityFade,
  elapsedOf,
  formatElapsed,
  formatTokens,
  isQuiet,
  panelRows,
  panelTally,
  stripLabel,
  type AgentRow,
  type AgentSnapshot,
  type DoneRow,
  type FoldRow,
  type MemberRow,
  type PanelRow,
  type PhaseRow,
  type Tick,
  type WorkflowRow,
} from "./agents.logic";
import type { AgentInfo } from "../types/events";

/**
 * The agent panel: what a session's agents and workflow runs are doing now
 * (docs/plans/2026-09-12-agent-workflow-visualisation-design.md, "Chosen:
 * Marginalia", prototype docs/plans/assets/agent-panel/p1-ambient.html).
 *
 * Two forms. The RAIL is the right margin of the reading column, 260px, no
 * card, no background, no badges: each entry is text on the page with a 2px
 * spine in the agent's own colour, and indenting that spine is how nesting is
 * drawn. The STRIP is the same thing for a column too narrow for a margin: one
 * line of tally and label above the transcript, which opens into the list.
 *
 * The only things that move while it sits there are the elapsed digits and
 * the fade of a quiet agent's activity line, so peripheral vision is not
 * pulled at by anything that is not information. Both are written straight
 * into their own nodes once a second. Nothing re-renders for a tick, and a
 * row keeps its node across every frame, so hover and focus survive both.
 *
 * Every entry is a button: tapping it asks the caller (`onOpen`) to show that
 * agent's own transcript (AgentTranscript, the drill-in), and the entry whose
 * transcript is open carries the hover tint for as long as it is.
 *
 * Whether it is shown at all is the caller's (agents.logic `panelPresent`).
 */

/** How the rows reach the one clock. */
interface Ticking {
  /** Server-clock ms now: this device's clock corrected by the frame's skew. */
  clock: () => number;
  /** Run `write` on every tick until the calling component is disposed. */
  every: (write: (now: number) => void) => void;
}

const TICK_MS = 1000;
/** Ticks the tally draws before it says "+N". The strip has less room. */
const RAIL_TICKS = 44;
const STRIP_TICKS = 20;

/** Inside a run you watch a population, so a member's hue drops most of its
 *  chroma against the page while staying the same hue. */
const muted = (hue: string): string => `color-mix(in srgb, ${hue} 52%, var(--bg-page))`;

/** Elapsed since `from`, frozen at `to` once that is set. A fixed-width cell. */
const Elapsed: Component<{ from: number; to: number; tick: Ticking }> = (props) => {
  let el!: HTMLSpanElement;
  const write = (now: number) => {
    const t = formatElapsed(elapsedOf({ startedAt: props.from, endedAt: props.to }, now));
    if (el.textContent !== t) el.textContent = t;
  };
  // Once when the inputs change (a finished agent's clock stops at its end
  // without waiting for the next tick), and on every tick after that.
  createEffect(() => write(props.tick.clock()));
  onMount(() => props.tick.every(write));
  return <span class="tl-agents-elapsed" ref={el} />;
};

/**
 * An activity line that fades as its agent's silence grows. Silence is shown
 * and never named: the panel cannot know whether an agent is alive, so it puts
 * the time on screen and leaves the judgement to the reader.
 */
function fadeWriter(
  el: () => HTMLElement,
  live: () => boolean,
  lastActivityAt: () => number,
): (now: number) => void {
  return (now) => {
    const o = live() ? activityFade(now - lastActivityAt()) : 1;
    const v = o >= 1 ? "" : o.toFixed(2);
    if (el().style.opacity !== v) el().style.opacity = v;
  };
}

/**
 * Tapping an agent opens its own transcript (design step 6). Every entry is
 * one button, so the tap target is the whole row the reader is looking at.
 * An agent still queued has written nothing, so there is nothing to open yet.
 */
interface Opening {
  onOpen?: (id: string) => void;
  openId?: string | null;
}

const openable = (a: AgentInfo, o: Opening): boolean => !!o.onOpen && a.state !== "queued";

const AgentEntry: Component<{ row: AgentRow; tick: Ticking; open: Opening }> = (props) => {
  let act!: HTMLSpanElement;
  const write = fadeWriter(
    () => act,
    () => !props.row.ended,
    () => props.row.agent.lastActivityAt,
  );
  createEffect(() => write(props.tick.clock()));
  onMount(() => props.tick.every(write));
  const isOpen = () => props.open.openId === props.row.agent.id;
  return (
    <div
      class="tl-agent"
      role="listitem"
      data-agent={props.row.agent.id}
      data-ended={props.row.ended ? "true" : "false"}
      data-failed={props.row.failed ? "true" : "false"}
      data-open={isOpen() ? "true" : "false"}
      style={{ "--spine": props.row.hue, "--indent": String(props.row.indent) }}
    >
      <button
        type="button"
        class="tl-agent-open"
        disabled={!openable(props.row.agent, props.open)}
        aria-current={isOpen() ? "true" : undefined}
        onClick={() => props.open.onOpen?.(props.row.agent.id)}
      >
        {/* Both lines clip at 260px, so each carries its whole text for hover.
            The elapsed cell sits by the title rather than with the counts: all
            three figures on one line left the activity 96px, about thirteen
            characters, and the activity is what the row is for. */}
        <span class="tl-agent-head">
          <span class="tl-agent-title" title={props.row.title}>
            {props.row.title}
          </span>
          <span class="tl-agent-time">
            <Elapsed
              from={props.row.agent.startedAt}
              to={props.row.agent.endedAt}
              tick={props.tick}
            />
          </span>
          <span class="tl-agent-go" aria-hidden="true">
            ›
          </span>
        </span>
        <span class="tl-agent-line">
          <span class="tl-agent-act" ref={act} title={props.row.hint}>
            {props.row.act}
          </span>
          <span class="tl-agent-num">{props.row.counts}</span>
        </span>
      </button>
    </div>
  );
};

/** A run's header: the kind and the figures, then what the run is, on a line
 *  of its own so that it is never squeezed by them. */
const RunHeader: Component<{ row: WorkflowRow; tick: Ticking }> = (props) => (
  <div class="tl-agents-run" role="listitem">
    <div class="tl-agents-run-k">
      <span class="tl-agents-run-kind">Workflow</span>
      <span class="tl-agents-run-num">
        <Elapsed from={props.row.startedAt} to={0} tick={props.tick} />
        {` · ${formatTokens(props.row.tokens)}`}
      </span>
    </div>
    <div
      class="tl-agents-run-title"
      title={props.row.hint}
      data-id={props.row.idOnly ? "true" : "false"}
    >
      {props.row.title}
    </div>
  </div>
);

/**
 * A phase says how many are running and for how long while it runs, and what
 * it came to once it is done. Its tokens wait for the finish: beside a ticking
 * elapsed at 260px they pushed the phase's own name off the line, and the run
 * header above already carries the run's.
 */
const PhaseHeader: Component<{ row: PhaseRow; tick: Ticking }> = (props) => (
  <div class="tl-agents-phase" role="listitem" data-state={props.row.state}>
    <span class="tl-agents-phase-name" title={props.row.title}>
      {props.row.title}
    </span>
    <span class="tl-agents-phase-status">
      <Switch>
        <Match when={props.row.state === "running"}>
          {`${props.row.status} · `}
          <Elapsed from={props.row.startedAt} to={0} tick={props.tick} />
        </Match>
        <Match when={props.row.state === "done"}>
          {`${props.row.status} · ${formatTokens(props.row.tokens)}`}
        </Match>
      </Switch>
    </span>
  </div>
);

/** One line per member: description plus current tool only. */
const MemberLine: Component<{ row: MemberRow; tick: Ticking; open: Opening }> = (props) => {
  let act!: HTMLSpanElement;
  const write = fadeWriter(
    () => act,
    () => !props.row.failed,
    () => props.row.agent.lastActivityAt,
  );
  createEffect(() => write(props.tick.clock()));
  onMount(() => props.tick.every(write));
  const isOpen = () => props.open.openId === props.row.agent.id;
  return (
    <div
      class="tl-agents-member"
      role="listitem"
      data-agent={props.row.agent.id}
      data-failed={props.row.failed ? "true" : "false"}
      data-open={isOpen() ? "true" : "false"}
      style={{ "--spine": props.row.failed ? "var(--danger)" : muted(props.row.hue) }}
    >
      <button
        type="button"
        class="tl-agent-open"
        disabled={!openable(props.row.agent, props.open)}
        aria-current={isOpen() ? "true" : undefined}
        onClick={() => props.open.onOpen?.(props.row.agent.id)}
      >
        <span class="tl-agents-member-title" title={props.row.title}>
          {props.row.title}
        </span>
        <span class="tl-agents-member-act" ref={act} title={props.row.act}>
          {props.row.act}
        </span>
      </button>
    </div>
  );
};

const DoneBar: Component<{ row: DoneRow; onToggle: () => void }> = (props) => (
  <button
    type="button"
    class="tl-agents-donebar"
    aria-expanded={props.row.open ? "true" : "false"}
    onClick={() => props.onToggle()}
  >
    <span class="tl-agents-donebar-count">{props.row.count} done</span>
    <span class="tl-agents-caret" aria-hidden="true">
      {props.row.open ? "⌃" : "⌄"}
    </span>
  </button>
);

const asAgent = (r: PanelRow | undefined) => (r?.kind === "agent" ? r : undefined);
const asRun = (r: PanelRow | undefined) => (r?.kind === "workflow" ? r : undefined);
const asPhase = (r: PanelRow | undefined) => (r?.kind === "phase" ? r : undefined);
const asMember = (r: PanelRow | undefined) => (r?.kind === "member" ? r : undefined);
const asFold = (r: PanelRow | undefined): FoldRow | undefined =>
  r?.kind === "fold" ? r : undefined;
const asDone = (r: PanelRow | undefined) => (r?.kind === "done" ? r : undefined);

const Row: Component<{
  row: () => PanelRow | undefined;
  tick: Ticking;
  open: Opening;
  onToggleDone: () => void;
}> = (props) => (
  <Switch>
    <Match when={asAgent(props.row())}>
      {(r) => <AgentEntry row={r()} tick={props.tick} open={props.open} />}
    </Match>
    <Match when={asRun(props.row())}>{(r) => <RunHeader row={r()} tick={props.tick} />}</Match>
    <Match when={asPhase(props.row())}>{(r) => <PhaseHeader row={r()} tick={props.tick} />}</Match>
    <Match when={asMember(props.row())}>
      {(r) => <MemberLine row={r()} tick={props.tick} open={props.open} />}
    </Match>
    <Match when={asFold(props.row())}>
      {(r) => (
        <div class="tl-agents-fold" role="listitem">
          {r().text}
        </div>
      )}
    </Match>
    <Match when={asDone(props.row())}>
      {(r) => <DoneBar row={r()} onToggle={props.onToggleDone} />}
    </Match>
  </Switch>
);

/** One tick per agent; a live one dims itself once its agent goes quiet. */
const TickMark: Component<{ tick: () => Tick | undefined; clock: Ticking }> = (props) => {
  let el!: HTMLElement;
  const write = (now: number) => {
    const t = props.tick();
    const quiet = t?.kind === "live" && isQuiet(now - t.lastActivityAt) ? "true" : "false";
    if (el.dataset.quiet !== quiet) el.dataset.quiet = quiet;
  };
  createEffect(() => write(props.clock.clock()));
  onMount(() => props.clock.every(write));
  return (
    <i
      class="tl-agents-tick"
      ref={el}
      data-kind={props.tick()?.kind ?? "done"}
      style={{
        "--tick": props.tick()?.muted ? muted(props.tick()?.hue ?? "") : (props.tick()?.hue ?? ""),
      }}
    />
  );
};

const sameKeys = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

export const AgentPanel: Component<{
  snapshot: AgentSnapshot;
  form: "rail" | "strip";
  /** Open this agent's own transcript. Absent, nothing in the panel opens. */
  onOpen?: (id: string) => void;
  /** The agent whose transcript is open now, if any. */
  openId?: string | null;
  /** Close the open transcript. The rail offers it while one is open. */
  onBack?: () => void;
}> = (props) => {
  const [doneOpen, setDoneOpen] = createSignal(false);
  const [stripOpen, setStripOpen] = createSignal(false);
  // The strip's list covers the top of the column on a phone, so a tap that
  // opens an agent also puts the list away: what the tap opened is what shows.
  const open: Opening = {
    get openId() {
      return props.openId;
    },
    get onOpen() {
      const go = props.onOpen;
      if (!go) return undefined;
      return (id: string) => {
        setStripOpen(false);
        go(id);
      };
    },
  };

  const rows = createMemo(() => panelRows(props.snapshot.set, { doneOpen: doneOpen() }));
  const byKey = createMemo(() => new Map(rows().map((r) => [r.key, r])));
  const keys = createMemo(() => rows().map((r) => r.key), [], { equals: sameKeys });

  const tally = createMemo(() => panelTally(props.snapshot.set));
  const cap = () => (props.form === "strip" ? STRIP_TICKS : RAIL_TICKS);
  const tickMap = createMemo(() => new Map(tally().ticks.map((t) => [t.key, t])));
  const tickKeys = createMemo(
    () =>
      tally()
        .ticks.slice(0, cap())
        .map((t) => t.key),
    [],
    { equals: sameKeys },
  );
  const more = () => Math.max(0, tally().ticks.length - cap());

  // The one clock. Server time, because every figure is a difference against
  // a server timestamp, and a phone's own clock can be seconds out.
  const writers = new Set<(now: number) => void>();
  const tick: Ticking = {
    clock: () => Date.now() + props.snapshot.skew,
    every: (write) => {
      writers.add(write);
      onCleanup(() => writers.delete(write));
    },
  };
  onMount(() => {
    const id = setInterval(() => {
      const now = tick.clock();
      for (const w of writers) w(now);
    }, TICK_MS);
    onCleanup(() => clearInterval(id));
  });

  const ticks = () => (
    <span class="tl-agents-ticks" aria-hidden="true">
      <For each={tickKeys()}>{(k) => <TickMark tick={() => tickMap().get(k)} clock={tick} />}</For>
      <Show when={more() > 0}>
        <span class="tl-agents-more">+{more()}</span>
      </Show>
    </span>
  );

  const list = () => (
    <div class="tl-agents-list" role="list">
      <For each={keys()}>
        {(k) => (
          <Row
            row={() => byKey().get(k)}
            tick={tick}
            open={open}
            onToggleDone={() => setDoneOpen((o) => !o)}
          />
        )}
      </For>
    </div>
  );

  return (
    <aside class="tl-agents" data-form={props.form} aria-label="Agents in this session">
      <Show
        when={props.form === "strip"}
        fallback={
          <>
            <div class="tl-agents-tally">
              {/* The drill-in's own Back sits at the far left of the reading
                  column, a trip across the screen from the rail the reader
                  just tapped, so the rail carries one too. The strip needs
                  none: the drill-in's header is right under it. */}
              <Show when={props.openId ? props.onBack : undefined}>
                {(back) => (
                  <button type="button" class="tl-agents-back" onClick={() => back()()}>
                    <span aria-hidden="true">←</span> Back to session
                  </button>
                )}
              </Show>
              {ticks()}
              <div class="tl-agents-head">
                <span class="tl-agents-count">{tally().running} running</span>
                <span class="tl-agents-tokens">{formatTokens(tally().tokens)}</span>
              </div>
            </div>
            {list()}
          </>
        }
      >
        <button
          type="button"
          class="tl-agents-bar"
          aria-expanded={stripOpen() ? "true" : "false"}
          onClick={() => setStripOpen((o) => !o)}
        >
          {ticks()}
          <span class="tl-agents-label">{stripLabel(props.snapshot.set)}</span>
          <span class="tl-agents-caret" aria-hidden="true">
            {stripOpen() ? "⌃" : "⌄"}
          </span>
        </button>
        <Show when={stripOpen()}>
          <div class="tl-agents-open">{list()}</div>
        </Show>
      </Show>
    </aside>
  );
};
