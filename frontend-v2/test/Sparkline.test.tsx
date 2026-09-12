import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { Sparkline } from "../src/components/Sparkline";

/**
 * The hour of pressure behind the "This machine" row
 * (docs/plans/2026-09-12-machine-health-indicator-design.md, "The panel row").
 *
 * Everything here asserts coordinates rather than a snapshot, because the only
 * thing a sparkline promises is that height means value and left means older.
 * A snapshot would go green on a chart that had quietly inverted its y axis.
 *
 * The geometry it is asserted against, which is the component's contract:
 *
 *   viewBox   0 0 200 40      — 200 is the width a phone gives this row
 *   padding   3 on all sides  — so the plot area is x 3..197, y 3..37
 *   y domain  0 .. max(readings, threshold)   — zero-anchored, never min-max
 *
 * Zero-anchored is the load-bearing half. A min-max axis would redraw a quiet
 * hour as a mountain range and push the threshold line off the top of the box,
 * and the row exists to say how close to that line the machine is.
 */

const LEFT = 3;
const RIGHT = 197;
const TOP = 3;
const BOTTOM = 37;

/** The points attribute as [x, y] pairs. SVG allows either separator. */
function points(el: Element | null): [number, number][] {
  const raw = el?.getAttribute("points") ?? "";
  const nums = raw
    .trim()
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i]!, nums[i + 1]!]);
  return out;
}

const line = (c: Element, cls: string) => c.querySelector(`.${cls}`);
const attr = (el: Element | null, name: string) => Number(el?.getAttribute(name));

describe("Sparkline — a full series", () => {
  it("spreads the readings across the plot, oldest on the left", () => {
    const { container } = render(() => (
      <Sparkline series={[0, 5, 10, 20]} label="Pressure, last hour" />
    ));
    const p = points(container.querySelector(".tl-spark-line"));
    expect(p.length).toBe(4);
    expect(p.map(([x]) => x)).toEqual([LEFT, 67.67, 132.33, RIGHT]);
  });

  it("puts the biggest reading at the top of the plot and zero on the floor", () => {
    const { container } = render(() => (
      <Sparkline series={[0, 5, 10, 20]} label="Pressure, last hour" />
    ));
    const ys = points(container.querySelector(".tl-spark-line")).map(([, y]) => y);
    // 20 is the peak, so it defines the top; 0 sits on the baseline; 10 and 5
    // land at the half and the quarter of the 34 units between them.
    expect(ys).toEqual([BOTTOM, 28.5, 20, TOP]);
  });

  it("marks the newest reading where the line ends", () => {
    const { container } = render(() => <Sparkline series={[0, 5, 10, 20]} label="Pressure" />);
    const tick = line(container, "tl-spark-now");
    expect(attr(tick, "x1")).toBe(RIGHT);
    expect(attr(tick, "x2")).toBe(RIGHT);
    // The tick is centred on the last value and reaches exactly as far as the
    // padding, so a reading at either extreme still draws inside the box.
    expect(attr(tick, "y1")).toBe(TOP - 3);
    expect(attr(tick, "y2")).toBe(TOP + 3);
  });

  it("is a labelled graphic, since a line has no text of its own", () => {
    const { container } = render(() => <Sparkline series={[1, 2]} label="Pressure, last hour" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Pressure, last hour");
  });
});

describe("Sparkline — a series too short to be a line", () => {
  // The ring buffer empties whenever tmux-api restarts, so the minute after a
  // deploy is a four-point series and the minute after that is a five-point
  // one. Neither is an edge case.
  it("still draws four readings as a line", () => {
    const { container } = render(() => <Sparkline series={[1, 9, 3, 4]} label="Pressure" />);
    expect(points(container.querySelector(".tl-spark-line")).length).toBe(4);
  });

  it("draws a single reading as a tick, because one point is not a line", () => {
    const { container } = render(() => <Sparkline series={[6]} label="Pressure" />);
    expect(container.querySelector(".tl-spark-line")).toBeNull();
    const tick = line(container, "tl-spark-now");
    expect(tick).not.toBeNull();
    // One reading has no time span to spread over, so it sits in the middle
    // rather than claiming to be either the oldest or the newest of anything.
    expect(attr(tick, "x1")).toBe(100);
    expect(attr(tick, "y1")).toBe(TOP - 3);
  });

  it("says it has nothing rather than drawing a flat line", () => {
    const { container, getByText } = render(() => <Sparkline series={[]} label="Pressure" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector(".tl-spark-line")).toBeNull();
    expect(getByText("No readings yet")).toBeTruthy();
  });

  it("drops a reading that is not a finite number instead of losing the chart", () => {
    // One NaN in the points attribute makes the browser discard the whole
    // polyline, so a single bad sample would blank an hour of good ones.
    const { container } = render(() => <Sparkline series={[1, Number.NaN, 3]} label="Pressure" />);
    const p = points(container.querySelector(".tl-spark-line"));
    expect(p.length).toBe(2);
    expect(p.flat().every(Number.isFinite)).toBe(true);
  });
});

describe("Sparkline — a series that never moves", () => {
  it("rests on the floor when every reading is zero", () => {
    // The zero-range case. An hour of genuine quiet is the common reading on
    // this box, and dividing by that range is the way to fill it with NaN.
    const { container } = render(() => <Sparkline series={[0, 0, 0, 0]} label="Pressure" />);
    const ys = points(container.querySelector(".tl-spark-line")).map(([, y]) => y);
    expect(ys).toEqual([BOTTOM, BOTTOM, BOTTOM, BOTTOM]);
  });

  it("holds a flat series under the threshold it never crossed", () => {
    const { container } = render(() => (
      <Sparkline series={[4, 4, 4]} threshold={10} label="Pressure" />
    ));
    const ys = points(container.querySelector(".tl-spark-line")).map(([, y]) => y);
    // 4 of a 0..10 domain: 40% up the 34 units between floor and ceiling.
    expect(ys).toEqual([23.4, 23.4, 23.4]);
    // Larger y is further down the screen, so the readings sit below the line.
    expect(ys[0]!).toBeGreaterThan(attr(line(container, "tl-spark-threshold"), "y1"));
  });
});

describe("Sparkline — the threshold", () => {
  it("rules across the chart at the height the scale gives it", () => {
    const { container } = render(() => (
      <Sparkline series={[0, 20]} threshold={10} label="Pressure" />
    ));
    const t = line(container, "tl-spark-threshold");
    // Half of the 0..20 domain, so halfway between floor and ceiling.
    expect(attr(t, "y1")).toBe(20);
    expect(attr(t, "y2")).toBe(20);
    // Full width rather than the plot width: it is a rule to read against, and
    // one that stopped short of the edges would read as data.
    expect(attr(t, "x1")).toBe(0);
    expect(attr(t, "x2")).toBe(200);
  });

  it("opens the scale up to itself when no reading reaches it", () => {
    const { container } = render(() => (
      <Sparkline series={[1, 2]} threshold={50} label="Pressure" />
    ));
    // A threshold above the peak still has to be on screen, or the chart
    // cannot show how far below it the machine is.
    expect(attr(line(container, "tl-spark-threshold"), "y1")).toBe(TOP);
    const ys = points(container.querySelector(".tl-spark-line")).map(([, y]) => y);
    expect(ys.every((y) => y > 30)).toBe(true);
  });

  it("draws no rule when it is not given one", () => {
    const { container } = render(() => <Sparkline series={[1, 2, 3]} label="Pressure" />);
    expect(line(container, "tl-spark-threshold")).toBeNull();
  });
});
