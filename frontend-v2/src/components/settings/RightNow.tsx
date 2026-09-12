import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import {
  CHANNEL_LABEL,
  SESSION_CHANNELS,
  machineSentence,
  scope,
  summarise,
  verdict,
  type ChannelId,
  type MachinePoint,
  type MachineReport,
} from "../../diagnostics/status";
import type { ConnectionControl } from "../../diagnostics/status-store";
import { agoLabel } from "../lobby.logic";
import { Sparkline } from "../Sparkline";
import { Group } from "./controls";

function forHowLong(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)}h`;
}

/**
 * A stall rate, in the digits that carry meaning at that size.
 *
 * The three rates span three orders of magnitude on this box — memory sits at
 * zero nearly always, IO has reached 87% — so one precision serves neither end:
 * "62.0%" is noise and "0.0%" is a lie. Under a tenth of a percent the only
 * question left is whether anything stalled at all, which is a different
 * statement from nothing having stalled, and `<0.1%` is the one that makes it.
 */
function stallPct(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0%";
  if (v < 0.1) return "<0.1%";
  if (v >= 10) return `${Math.round(v)}%`;
  return `${v.toFixed(1)}%`;
}

/** Load as /proc/loadavg gives it, with trailing zeroes cut: "0.90" claims a
 *  measurement to two places that the reader has no use for. */
function loadFigure(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * Memory as a person reads it on a spec sheet.
 *
 * tmux-api divides the kernel's KiB by 1024, so these are mebibytes and 1024 is
 * the honest divisor. The unit says GB because that is what `free -h`, the BIOS
 * and the invoice all call it, and a row explaining the difference would be
 * answering a question nobody opened this panel with.
 */
function gb(mb: number): string {
  return (mb / 1024).toFixed(1);
}

/** The window in prose, because it is read inside a sentence rather than as a
 *  figure of its own. */
function windowLabel(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} seconds`;
  const m = Math.round(seconds / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

interface Figure {
  label: string;
  value: string;
}

/**
 * The numbers under the machine row, as a person can read them.
 *
 * NOT THE FIELD NAMES. "io_full 62%" is exact, and it is the one thing a reader
 * holding a slow terminal cannot act on. The resources are called what the rest
 * of this row calls them — the processor, the disk, memory — so the figures and
 * the phrase beside the dot say the same words about the same reading.
 *
 * Memory appears twice on the pressure path, on purpose: time stalled waiting
 * for it, and how much of it is left. Those are different questions, and the
 * second is the one that survives when the first cannot be read.
 *
 * On the fallback path there are no stall figures at all. A kernel without
 * /proc/pressure measured none, and three zeroes would read as "nothing is
 * stalling", which is a claim that path cannot make. What is left is exactly
 * what the fallback verdict reads: load against the cores it is spread over,
 * and memory headroom.
 */
function figuresFor(r: MachineReport): Figure[] {
  const stall: Figure[] =
    r.source === "load"
      ? []
      : [
          { label: "Processor", value: stallPct(r.cpuPct) },
          { label: "Disk", value: stallPct(r.ioPct) },
          { label: "Memory", value: stallPct(r.memPct) },
        ];
  return [
    ...stall,
    // Load without the core count is a number nobody can place: 0.9 is nearly
    // idle here and desperate on a laptop.
    { label: "Load", value: `${loadFigure(r.load1)} of ${r.nproc}` },
    { label: "Free memory", value: `${gb(r.memAvailableMb)} of ${gb(r.memTotalMb)} GB` },
  ];
}

/**
 * What the box itself is doing, drawn under the "This machine" row.
 *
 * THE SIXTH ROW IS THE ONLY RICH ONE, and everything here is shaped by not
 * letting that make the other five look broken. Its top line is the same top
 * line they have — dot, label, phrase — and this block hangs below it, indented
 * to the label, rather than widening the table or adding a column only one row
 * could ever fill.
 *
 * Answer first, evidence under it. Someone opening this panel is already
 * holding the slowness: the sentence names it, the figures let them check it,
 * and the hour says whether it is fading or settling in.
 */
const MachineReadout: Component<{
  report: MachineReport;
  series: readonly MachinePoint[];
  /** The tier's sentence, or null when the top of the panel is already saying
   *  it. Decided by the panel, because it is the only thing that can see both
   *  places at once — see `rowSentence`. */
  sentence: string | null;
}> = (props) => {
  /**
   * Anything true about the reading that the figures cannot say for themselves.
   * Both exist on ADR-0016's reasoning, carried into ADR-0027: a row that
   * explains itself can be asked about, while one that quietly presents a
   * different number as the same one cannot.
   *
   * One element rather than a list, because the two can be true together and
   * two muted paragraphs under five figures start to look like an error state.
   */
  const note = (): string | null => {
    const out: string[] = [];
    if (props.report.source === "load") {
      out.push(
        "This kernel reports no stall times, so the row is reading the load average and memory headroom instead.",
      );
    }
    if (props.report.partialWindow) {
      out.push(
        `These cover the last ${windowLabel(props.report.windowSeconds)}, which is all the history there is so far. The thresholds behind the colour were measured over ten.`,
      );
    }
    return out.length > 0 ? out.join(" ") : null;
  };

  // `ofLimit`, never `pct`: each reading over its OWN resource's threshold, so
  // 1.0 is the amber line for all three and one line can carry the worst of
  // them. On a `pct` axis the same height would mean "quiet" for IO and "over
  // the line" for CPU.
  const series = () => props.series.map((p) => p.ofLimit);

  // One label, because there is only one path that ever draws. `series()` skips
  // samples with no PSI behind them, so on the fallback path the series is
  // always empty and the chart renders its "no readings yet" state instead of
  // an svg — which means a second label for that path would describe something
  // nobody can see. If the fallback ever grows a series of its own, drawing
  // load per core against its line, this is where its label goes.
  const chartLabel = () =>
    "The busiest of processor, disk and memory over the last hour, against the line where this row turns amber.";

  return (
    <div class="tl-rightnow-machine">
      <Show when={props.sentence}>{(s) => <p class="tl-rightnow-machine-said">{s()}</p>}</Show>

      {/* What the percentages are a percentage OF, which nothing else on the
          row says and without which "Processor 0.4%" could be read as how busy
          the processor is. Left out on the short-window path, where the note
          below states the window in a fuller sentence, and on the fallback
          path, where there are no stall figures to caption. */}
      <Show when={props.report.source !== "load" && !props.report.partialWindow}>
        <p class="tl-rightnow-machine-window">
          Stalled in the last {windowLabel(props.report.windowSeconds)}
        </p>
      </Show>

      <dl class="tl-rightnow-figures">
        <For each={figuresFor(props.report)}>
          {(f) => (
            <div class="tl-rightnow-figure">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          )}
        </For>
      </dl>

      <Show when={note()}>{(n) => <p class="tl-rightnow-machine-note">{n()}</p>}</Show>

      <Sparkline series={series()} threshold={1} label={chartLabel()} />
    </div>
  );
};

/**
 * Right now — what this client's six channels are doing, and a button that
 * goes and finds out.
 *
 * It opens with a sentence rather than a table, because the question people
 * arrive with is "is it me?" and a row of dots does not answer it. The detail
 * underneath is for the second question, which is usually being asked by
 * someone helping.
 *
 * Five of the rows are about this client. The sixth is about the box, and it is
 * the only one carrying figures and a graph, because "the machine is busy" is a
 * claim a reader is entitled to check and the other five make no claim of that
 * kind.
 *
 * The panel never repairs on its own. A check that reconnected what it found
 * broken would destroy the state its reader came to look at, so every repair is
 * a separate, explicit tap on the row that needs it.
 */
export const RightNow: Component<{ conn: ConnectionControl }> = (props) => {
  const rows = () => scope(props.conn.channels(), SESSION_CHANNELS);
  // Ticks so "Checked 2m ago" does not sit frozen while the panel is open.
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    onCleanup(() => clearInterval(t));
  });

  // The one moment anyone is watching the machine's numbers move is while this
  // panel is open, which is the whole reason a second poll exists. It stops with
  // the panel: a page nobody is reading it from must not keep spending a request
  // every few seconds on it.
  onMount(() => onCleanup(props.conn.watchMachine()));

  const checkedLabel = () => {
    // Rows land one at a time, so a check is finished only when the slowest
    // probe is — up to 5s after the first timings appear. Saying "not checked
    // yet" beside a table of timings is the kind of small contradiction that
    // makes a reader distrust the rest of the panel.
    if (props.conn.checking()) return "Checking now";
    const at = props.conn.checkedAt();
    return at === null ? "Not checked yet" : `Checked ${agoLabel(now() - at)}`;
  };

  const history = (id: ChannelId) => {
    const h = summarise(props.conn.log(), id);
    if (h.faults === 0) return null;
    const times = h.faults === 1 ? "once" : `${h.faults} times`;
    return `dropped ${times}`;
  };

  const measured = (id: ChannelId) => props.conn.lastCheck()[id]?.ms ?? null;

  /**
   * The machine's reading, or null wherever there is not one worth drawing.
   *
   * Three zero percentages read as "nothing is stalling", which is the one
   * thing a reading that has measured nothing must not say. Two readings say
   * it, and both arrive in the first seconds of a tmux-api process:
   *
   *  - `source` "unknown", before the sampler has taken a sample at all;
   *  - `source` "psi" with `windowSeconds` 0, which is the ten seconds after
   *    it. One sample is not a rate — a rate is a subtraction and there is
   *    nothing yet to subtract from — so tmux-api sends the figures it has and
   *    a window of zero (health.go, `healthVerdictFrom`).
   *
   * The row itself stays, reading "not reporting", which is what its state
   * says at both those moments anyway. The block appears with the first real
   * rate, ten seconds in.
   *
   * `windowSeconds` alone would be the wrong test: the load fallback has no
   * window by construction, and its figures are the whole of what it knows.
   */
  const machine = (): MachineReport | null => {
    const r = props.conn.machine();
    if (!r || r.source === "unknown") return null;
    return r.source === "load" || r.windowSeconds > 0 ? r : null;
  };

  /**
   * The tier's sentence, said on the row exactly when the top of the panel is
   * not already saying it.
   *
   * `verdict()` prints it whenever the machine is the ONE channel complaining,
   * which is the common case — a busy box breaks nobody's socket — and printing
   * it again seven rows down puts the same words on screen twice.
   *
   * But the moment anything else is also complaining, the verdict becomes "2
   * things need attention" and the sentence disappears from the panel entirely.
   * That is the case it exists for: the dot is amber for a brush past a
   * threshold and for a sustained grind alike, and the sentence is the only
   * thing that separates them (ADR-0027). So the row picks it up exactly where
   * the headline drops it.
   */
  const rowSentence = (): string | null => {
    const r = machine();
    if (!r) return null;
    const others = rows().some(
      (c) => c.id !== "machine" && (c.state === "degraded" || c.state === "down"),
    );
    return others ? machineSentence(r.tier) : null;
  };

  /**
   * A busy machine is the one row with nothing to press (ADR-0027). There is no
   * action a person can take about it, so it grows no button — held here rather
   * than left to whichever caller wires the control up, because a button that
   * cannot work is worse on this row than on any other: it would imply the
   * slowness is the reader's to fix.
   */
  const repairLabel = (id: ChannelId): string | null =>
    id === "machine" ? null : props.conn.repairLabel(id);

  return (
    <Group title="Right now">
      <p class="tl-rightnow-verdict" data-status={props.conn.worstNow()}>
        {verdict(rows())}
      </p>

      <div class="tl-rightnow-rows">
        <For each={rows()}>
          {(c) => (
            <div class="tl-rightnow-row" data-channel={c.id} data-status={c.state}>
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
              <Show when={repairLabel(c.id)}>
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
              {/* The sixth row's own block, which wraps onto a second line of
                  the same row rather than becoming a section between rows — a
                  table where one entry is a section reads as two tables. */}
              <Show when={c.id === "machine" ? machine() : null}>
                {(m) => (
                  <MachineReadout
                    report={m()}
                    series={props.conn.machineSeries()}
                    sentence={rowSentence()}
                  />
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
