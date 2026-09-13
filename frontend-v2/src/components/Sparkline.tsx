import { Show, type Component } from "solid-js";

/**
 * The drawing box, in units of its own.
 *
 * 200 by 40 because 200 is the width a phone gives the "This machine" row
 * (docs/plans/2026-09-12-machine-health-indicator-design.md, "The panel row"),
 * so at the size that matters one unit is one pixel and nothing is scaled at
 * all. Wider than that the box stretches sideways, which is the right thing for
 * a time axis: an hour is an hour whatever width it is drawn in.
 */
const W = 200;
const H = 40;
/**
 * Clear space kept on every side. A reading at either extreme draws inside the
 * box rather than half under its edge, and the "now" tick reaches exactly this
 * far above and below its point — which is why one number covers both.
 */
const PAD = 3;

const LEFT = PAD;
const RIGHT = W - PAD;
const TOP = PAD;
const BOTTOM = H - PAD;

/** Two decimals is finer than a device pixel at this size, and it keeps the
 *  points attribute short enough to read in the inspector. */
const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * One line over a series of numbers, oldest on the left.
 *
 * Built rather than installed: this project draws nothing today beyond three
 * CSS-width bars (`.tl-netusage-bar`, `.tl-ctx-bar`, `.tl-spend-meter-bar`),
 * and a charting library would be the largest dependency in the frontend for
 * the sake of forty lines of arithmetic.
 *
 * The y axis is anchored at zero and stretches to the larger of the readings
 * and the threshold. It is deliberately not the min-max autoscale a sparkline
 * usually gets: an hour of quiet would be redrawn as a mountain range, and the
 * threshold — the reason the reader opened the panel — would sit off the top of
 * the box. Zero-anchored, height means what it says, and how far the machine is
 * from the line is the thing you can see.
 *
 * Nothing here decides a colour. The row's dot already carries the verdict, and
 * the series this is handed is the deciding pressure, so the two cannot
 * disagree. The line draws in `currentColor` (app.css) so a parent that wants
 * to tint it can, without this component growing a second opinion about status.
 *
 * It is a graphic and it is labelled as one, and it is never the only copy of
 * what it shows: the numbers it draws sit beside it in the same row.
 */
export const Sparkline: Component<{
  /** The readings, oldest first. An EMPTY series is a normal input rather than
   *  an edge case: the ring behind this empties whenever the service restarts,
   *  and each point is a rate over the ten minutes before it (health.go,
   *  `series`), so the first ten minutes after a deploy have no points at all
   *  and the eleventh minute has one. */
  series: number[];
  /** Drawn as a reference rule, and folded into the scale so that it is on
   *  screen even when no reading came near it. */
  threshold?: number;
  /** What the graphic is, in words, for a reader who cannot see it. */
  label: string;
  /**
   * What the dotted rule means, printed beside the chart.
   *
   * The threshold is the only line on here whose meaning a reader cannot work
   * out by looking: a rule at an unexplained height could be an average, a
   * target or a maximum. Absent, the rule still draws and still goes
   * unexplained, which is the state this prop exists to end.
   */
  thresholdLabel?: string;
  /** The two ends of the time axis, oldest then newest. A line has no arrow on
   *  it, so which end is "now" is a guess without them. */
  startLabel?: string;
  endLabel?: string;
}> = (props) => {
  // A single non-finite sample makes the browser discard the whole polyline, so
  // one bad reading would blank an hour of good ones. Dropping it costs the
  // line one sample's worth of width and keeps the other 359.
  const readings = () => props.series.filter((v) => Number.isFinite(v));

  const threshold = (): number | null => {
    const t = props.threshold;
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  };

  const ceiling = () => {
    const top = Math.max(0, ...readings(), threshold() ?? 0);
    // An hour of genuine quiet is the ordinary reading on this box — the three
    // thresholds together are crossed 2.44% of the month — and it is also the
    // division that would fill the chart with NaN. A 0..1 domain puts every
    // zero on the floor, which is what an hour of quiet should look like.
    return top > 0 ? top : 1;
  };

  const x = (i: number, n: number) =>
    // One reading has no span to spread over, so it sits in the middle rather
    // than claiming to be the oldest or the newest of anything.
    n === 1 ? W / 2 : round(LEFT + (i * (RIGHT - LEFT)) / (n - 1));

  const y = (v: number) => {
    const c = ceiling();
    return round(BOTTOM - (Math.min(Math.max(v, 0), c) / c) * (BOTTOM - TOP));
  };

  const pts = () => {
    const r = readings();
    return r.map((v, i) => `${x(i, r.length)},${y(v)}`).join(" ");
  };

  const lastX = () => x(readings().length - 1, readings().length);
  const lastY = () => y(readings()[readings().length - 1] ?? 0);
  const thresholdY = () => {
    const t = threshold();
    return t === null ? null : y(t);
  };

  return (
    <div class="tl-spark">
      {/* EVERY LABEL IS HTML, NEVER SVG <text>. The chart is drawn with
          preserveAspectRatio="none" so that a wider panel gets a longer hour
          rather than a fatter line, and that same stretch would smear any text
          inside the viewBox horizontally. Outside it, the type is the page's. */}
      <Show
        when={readings().length > 0}
        // A chart of nothing draws a flat line along the floor, which is a
        // claim about the machine rather than the absence of one. The words are
        // the honest version, and they are what the first minutes after a
        // restart look like.
        fallback={<span class="tl-spark-empty">No readings yet</span>}
      >
        <svg
          class="tl-spark-svg"
          role="img"
          aria-label={props.label}
          viewBox={`0 0 ${W} ${H}`}
          // Stretched to whatever width it is given rather than letterboxed
          // inside it. Stroke widths are pinned back with vector-effect in
          // app.css, so a wide panel gets a longer line and not a thicker one.
          preserveAspectRatio="none"
        >
          {/* A floor, so an hour of zeroes reads as a chart with a line on it
              rather than as an empty box. */}
          <line class="tl-spark-base" x1="0" y1={BOTTOM} x2={W} y2={BOTTOM} />

          <Show when={thresholdY()}>
            {(ty) => (
              // Full width rather than the plot width: it is a rule to read
              // against, and one that stopped short of the edges would read as
              // data itself.
              <line class="tl-spark-threshold" x1="0" y1={ty()} x2={W} y2={ty()} />
            )}
          </Show>

          <Show when={readings().length > 1}>
            {/* fill is geometry, not colour: without it SVG closes the path and
                floods the area under the line. Everything carrying a colour is
                in app.css. */}
            <polyline class="tl-spark-line" fill="none" points={pts()} />
          </Show>

          {/* Where the newest reading is, which a line alone does not say — and
              the whole of the chart when there is only one reading to draw. */}
          <line
            class="tl-spark-now"
            x1={lastX()}
            y1={lastY() - PAD}
            x2={lastX()}
            y2={lastY() + PAD}
          />
        </svg>
      </Show>

      {/* The axis ends, and what the rule means. Drawn under the chart rather
          than over it, because the line reaches the top of the box whenever the
          machine is at its worst — which is exactly when a reader most needs
          the caption and least wants it sitting on the data.
          ONLY WHEN THERE IS A CHART. The first cut printed these over the
          empty state too, reasoning that a reader still wants to know what
          would have been drawn. On screen it read as "No readings yet" beside
          a dashed swatch labelled "busy line", pointing at a rule that is not
          drawn, on an axis with no time on it. A label for something absent is
          worse than no label. */}
      <Show when={readings().length > 0 && (props.startLabel || props.endLabel || props.thresholdLabel)}>
        <div class="tl-spark-axis">
          <span class="tl-spark-axis-start">{props.startLabel}</span>
          <Show when={props.thresholdLabel && thresholdY() !== null}>
            <span class="tl-spark-axis-rule">{props.thresholdLabel}</span>
          </Show>
          <span class="tl-spark-axis-end">{props.endLabel}</span>
        </div>
      </Show>
    </div>
  );
};
