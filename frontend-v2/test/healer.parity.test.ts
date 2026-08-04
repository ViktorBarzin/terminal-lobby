/**
 * v1 ⟷ v2 update-kernel PARITY.
 *
 * The update policy exists three times: `healer.logic.ts` (v2) and inline in
 * `frontend/index.html` + `frontend/term.html` (v1, which has no build step and
 * therefore no test harness of its own). That duplication is what let the two
 * drift apart — v2 cleared its pill state before reloading, v1 never did, and
 * only v1 is the daily driver. So this file slices v1's kernel out of the HTML
 * between its `>>> tl-update-kernel` / `<<< tl-update-kernel` sentinels, runs it
 * in a `node:vm` context, and puts it through the SAME case table the v2 unit
 * tests use.
 *
 * If someone edits one implementation and not the other, this goes red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { MAX_UPDATE_ATTEMPTS, STORM_WINDOW_MS, planUpdate } from "../src/deploy/healer.logic";

const V1_PAGES = ["frontend/index.html", "frontend/term.html"];
const repoFile = (p: string): string => resolve(__dirname, "../..", p);

/** The kernel source between the sentinels. */
function sliceKernel(html: string): string {
  const start = html.indexOf("// >>> tl-update-kernel");
  const end = html.indexOf("// <<< tl-update-kernel");
  expect(start, "opening kernel sentinel").toBeGreaterThan(-1);
  expect(end, "closing kernel sentinel").toBeGreaterThan(start);
  return html.slice(start, end);
}

type PlanFn = (s: Record<string, unknown>) => string;

/**
 * v1's `planUpdate`, extracted and callable. The kernel's only top-level side
 * effects are its resume-listener registrations; the stubs below absorb them, so
 * what runs here is exactly the shipped source with nothing rewritten.
 */
function loadV1PlanUpdate(file: string): PlanFn {
  const src = sliceKernel(readFileSync(file, "utf8"));
  const noop = (): void => {};
  const sandbox = {
    TL_ASSET: "aaaaaaaaaaaa",
    document: { hidden: false, hasFocus: () => true, addEventListener: noop },
    window: { addEventListener: noop, parent: null as unknown },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { pathname: "/", search: "", reload: noop, origin: "http://x" },
    fetch: async () => ({ ok: false, text: async () => "" }),
    console: { log: noop },
    tlTrack: noop,
  };
  return runInNewContext(`${src}\n;planUpdate;`, sandbox) as PlanFn;
}

describe.each(V1_PAGES)("v1 kernel parity — %s", (page) => {
  const v1Plan = loadV1PlanUpdate(repoFile(page));

  const base = {
    runningAsset: "aaaaaaaaaaaa",
    servedAsset: "aaaaaaaaaaaa",
    attached: false,
    visible: true,
    justResumed: false,
    attempts: 0,
    now: 1_000_000,
    lastReloadAt: null as number | null,
  };

  // The same table healer.logic.test.ts asserts against the v2 planUpdate.
  const CASES: Array<[string, Record<string, unknown>, string]> = [
    ["same asset (a backend-only deploy) → nothing", { servedAsset: "aaaaaaaaaaaa" }, "none"],
    ["changed asset, no terminal attached → reload", { servedAsset: "bbbbbbbbbbbb" }, "reload"],
    [
      "attached + visible, no resume edge → defer",
      { servedAsset: "bbbbbbbbbbbb", attached: true },
      "defer",
    ],
    [
      "attached + the next open → reload",
      { servedAsset: "bbbbbbbbbbbb", attached: true, justResumed: true },
      "reload",
    ],
    [
      "hidden → never navigate",
      { servedAsset: "bbbbbbbbbbbb", visible: false, justResumed: true },
      "defer",
    ],
    ["unreadable served page → nothing", { servedAsset: null }, "none"],
    ["unknown own identity → nothing", { runningAsset: null, servedAsset: "bbbbbbbbbbbb" }, "none"],
    [
      "storm-gated → nothing",
      { servedAsset: "bbbbbbbbbbbb", now: 1_001_000, lastReloadAt: 1_000_000 },
      "none",
    ],
    [
      "past the storm window → reload",
      { servedAsset: "bbbbbbbbbbbb", now: 1_000_000 + STORM_WINDOW_MS, lastReloadAt: 1_000_000 },
      "reload",
    ],
    [
      "at the attempt cap → give up",
      { servedAsset: "bbbbbbbbbbbb", attempts: MAX_UPDATE_ATTEMPTS },
      "give-up",
    ],
    [
      "give-up outranks hidden",
      { servedAsset: "bbbbbbbbbbbb", visible: false, attempts: MAX_UPDATE_ATTEMPTS },
      "give-up",
    ],
  ];

  it.each(CASES)("%s", (_name, over, expected) => {
    const state = { ...base, ...over };
    expect(v1Plan(state)).toBe(expected);
    // …and the v2 kernel agrees, case for case.
    expect(planUpdate(state as Parameters<typeof planUpdate>[0])).toBe(expected);
  });
});

describe.each(V1_PAGES)("v1 — the removed machinery stays removed (%s)", (page) => {
  const html = readFileSync(repoFile(page), "utf8");

  it("has no whole-body hash comparison left", () => {
    expect(html).not.toContain("bootPageHash");
    expect(html).not.toContain("function hashPage");
    expect(html).not.toContain("armBaseline(");
  });

  it("has no 'Update ready' pill — the user never taps anything", () => {
    expect(html).not.toContain("Update ready —");
    expect(html).not.toContain("updatePending");
  });

  it("never reloads out of a hidden branch", () => {
    // The stacking-card mechanism: a reload issued while the document was
    // hidden, with the dedupe cleared BEFORE the navigation it never confirmed.
    expect(html).not.toMatch(/document\.hidden[^\n]*location\.reload\(\)/);
  });

  it("carries the update identity in the head and beside the build stamp", () => {
    expect(html).toContain('<meta name="tl-asset" content="__TL_ASSET__">');
    expect(html).toContain("const TL_ASSET = '__TL_ASSET__';");
  });
});
