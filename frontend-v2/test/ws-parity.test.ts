import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The terminal transport lives in TWO files: frontend/index.html (the vanilla
 * page, PROD) and frontend/term.html (the page the v2 SPA frames). term.html
 * began as a copy of index.html's terminal path, and the network-resilience
 * work landed on the canary first and was mirrored into prod afterwards — with
 * a hand-run diff as the only thing proving the mirror was faithful.
 *
 * That diff is this test now. Each region below is delimited by sentinel
 * comments precisely so a machine can compare the two copies; a fix applied to
 * one file and forgotten in the other fails here rather than in someone's
 * terminal on a train.
 *
 * The two files are NOT identical overall, and are not meant to be — the pages
 * differ in framing, base-URL derivation, the attention kernel, and (since the
 * double-toolbar fix) whether they render their own soft-key bar. Only the
 * resilience kernel below is required to match.
 *
 * When a region legitimately has to diverge, do not delete its sentinels to
 * silence this test: move the diverging code OUT of the sentinel block and
 * leave the shared part inside.
 */

const root = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(root, p), "utf8");

const INDEX = "frontend/index.html";
const TERM = "frontend/term.html";

/** The code between `// >>> name` and `// <<< name`. */
function sentinelBlock(src: string, name: string): string | null {
  const re = new RegExp(`//\\s*>>>\\s*${name}\\b([\\s\\S]*?)//\\s*<<<\\s*${name}\\b`);
  const m = src.match(re);
  return m ? m[1]! : null;
}

/**
 * A `// ---- <title> ----` section, up to the next section marker. The liveness
 * watchdog carries no sentinels of its own: the two files continue into
 * differently-named sections after it, so the NEXT marker is the only end that
 * is stable in both.
 */
function section(src: string, title: string): string | null {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.includes(`---- ${title}`));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\/\/\s*----\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * The value a `const NAME = ...;` is declared with, comments excluded (they
 * stop at the semicolon).
 */
function constValue(src: string, name: string): string | null {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`));
  return m ? m[1]!.trim() : null;
}

/**
 * The tuning of the transport, which lives OUTSIDE the sentinel blocks — the
 * blocks wrap the logic, and the numbers it reads sit above them. Drift here is
 * exactly as damaging and was invisible to an earlier version of this test: a
 * deliberately-injected change to RETRY_DELAYS_MS in one file passed clean.
 */
const CONSTANTS = [
  "RETRY_DELAYS_MS", // the reconnect ladder (G1)
  "OFFLINE_RETRY_MS", // the backstop while navigator.onLine is false (G7)
  "TOKEN_TIMEOUT_MS", // the /token deadline (G3)
  "WS_OPEN_TIMEOUT_MS", // the handshake deadline (G4)
  "SESSION_CHECK_TIMEOUT_MS", // the kill-guard's own deadline
  "HIDDEN_SUSPEND_MS", // battery saver
  "LIVENESS_PROBE_MS", // the watchdog cadence (G2)
  "LIVENESS_FETCH_TIMEOUT_MS",
  "LIVENESS_DRAIN_MS",
  "LIVENESS_STRIKES",
  "WS_PROBE_FRAME", // the zero-length INPUT frame the probe sends
];

/** Sentinel-delimited regions that must be byte-identical in both pages. */
const SENTINELS = [
  // the reconnect ladder's delay + jitter (G1)
  "tl-retry-delay",
  // the bounded buffer that holds keys typed while the socket is down (G5)
  "tl-pending-input",
  // the stale-tab self-update kernel
  "tl-update-kernel",
];

describe("terminal transport parity — index.html (prod) vs term.html (SPA frame)", () => {
  const idx = read(INDEX);
  const trm = read(TERM);

  describe.each(SENTINELS)("sentinel block %s", (name) => {
    it("is present in both pages", () => {
      expect(sentinelBlock(idx, name), `${name} missing from ${INDEX}`).toBeTruthy();
      expect(sentinelBlock(trm, name), `${name} missing from ${TERM}`).toBeTruthy();
    });

    it("is identical in both pages", () => {
      // toEqual on the strings so a failure prints the drifting lines.
      expect(sentinelBlock(trm, name)).toEqual(sentinelBlock(idx, name));
    });
  });

  describe("the liveness watchdog (G2 — the half-open detector)", () => {
    it("is present in both pages", () => {
      expect(section(idx, "liveness watchdog"), `missing from ${INDEX}`).toBeTruthy();
      expect(section(trm, "liveness watchdog"), `missing from ${TERM}`).toBeTruthy();
    });

    it("is identical in both pages", () => {
      expect(section(trm, "liveness watchdog")).toEqual(section(idx, "liveness watchdog"));
    });

    it("still carries the pieces that make it work", () => {
      // A watchdog that lost its probe frame or its strike rule would still
      // "match" if both copies lost it together, so pin the moving parts.
      for (const [file, src] of [
        [INDEX, idx],
        [TERM, trm],
      ] as const) {
        const s = section(src, "liveness watchdog")!;
        expect(s, `${file}: probe cadence`).toContain("LIVENESS_PROBE_MS");
        expect(s, `${file}: strike threshold`).toContain("LIVENESS_STRIKES");
        expect(s, `${file}: zero-length INPUT probe frame`).toContain("WS_PROBE_FRAME");
        expect(s, `${file}: backpressure signal`).toContain("bufferedAmount");
        // it must hand the drop to the SAME kill-guarded ladder a real close uses
        expect(s, `${file}: reconnect path`).toContain("reconnectAfterDrop");
      }
    });
  });

  describe.each(CONSTANTS)("transport constant %s", (name) => {
    it("is declared in both pages, with the same value", () => {
      const a = constValue(idx, name);
      const b = constValue(trm, name);
      expect(a, `${name} missing from ${INDEX}`).toBeTruthy();
      expect(b, `${name} missing from ${TERM}`).toBeTruthy();
      expect(b).toEqual(a);
    });
  });

  it("both pages bound the /token hop and the handshake (G3, G4)", () => {
    for (const [file, src] of [
      [INDEX, idx],
      [TERM, trm],
    ] as const) {
      expect(src, `${file}: token deadline`).toContain("TOKEN_TIMEOUT_MS");
      expect(src, `${file}: handshake deadline`).toContain("handshakeTimer");
    }
  });
});
