import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createVisitStore, VISITS_KEY, STATES_KEY } from "../src/store/visits";
import { waitingCount } from "../src/notify/appbadge";

/**
 * The PAGE half of the badge parity fixture. `tmux-api/badgeparity_test.go` runs
 * the same cases through the server's arithmetic, and both must reach `want`.
 *
 * The two writers of the app icon disagreed in production and nothing caught it:
 * appbadge.test.ts always injects the unseen predicate, so it never touches the
 * visit store, and the Go suite only ever pinned a number it had produced
 * itself. This fixture is the one place they are compared.
 */
const FIXTURE = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../testdata/badge-parity.json"),
    "utf8",
  ),
) as {
  cases: {
    case: string;
    sessions: { name: string; state: string; owner?: string }[];
    visits: Record<string, number>;
    states: Record<string, { state: string; at: number }>;
    want: number;
  }[];
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("badge parity — the page's arithmetic", () => {
  for (const c of FIXTURE.cases) {
    it(c.case, () => {
      // Seed the REAL store from the fixture, rather than injecting a predicate.
      localStorage.setItem(VISITS_KEY, JSON.stringify(c.visits));
      localStorage.setItem(STATES_KEY, JSON.stringify(c.states));
      const store = createVisitStore({ now: () => 9_999 });
      const list = c.sessions.map((s) => ({
        name: s.name,
        state: s.state || undefined,
        owner: s.owner,
      }));
      expect(waitingCount(list, (s) => store.isUnseen(s), "wizard")).toBe(c.want);
    });
  }

  it("covers every arm of the count", () => {
    // A fixture that only ever asserted zero would pass a broken counter.
    const wants = FIXTURE.cases.map((c) => c.want);
    expect(Math.max(...wants)).toBeGreaterThan(1);
    expect(wants).toContain(0);
  });
});
