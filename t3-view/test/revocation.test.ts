import { afterEach, describe, expect, it, vi } from "vitest";

import { type GateDecision, relayKey } from "../src/auth.ts";
import { BearerWatch } from "../src/revocation.ts";

const OK: GateDecision = {
  ok: true,
  identity: { osUser: "wizard", authentik: "viktor", relay: { bearer: "tld1_a" } },
};
const REFUSED: GateDecision = { ok: false, status: 401, reason: "revoked" };
const DOWN: GateDecision = { ok: false, status: 502, reason: "unreachable" };

afterEach(() => {
  vi.useRealTimers();
});

function makeWatch(answer: (bearer: string) => GateDecision, intervalMs = 60_000) {
  const revoked: string[] = [];
  const asked: string[] = [];
  const watch = new BearerWatch({
    gate: {
      recheck: async (bearer) => {
        asked.push(bearer);
        return answer(bearer);
      },
    },
    onRevoked: (key) => revoked.push(key),
    intervalMs,
  });
  return { watch, revoked, asked };
}

describe("BearerWatch", () => {
  it("closes every socket of a bearer tmux-api now refuses, and reports its key", async () => {
    const { watch, revoked } = makeWatch((b): GateDecision => (b === "tld1_a" ? REFUSED : OK));
    const closed: string[] = [];
    watch.watch("tld1_a", () => closed.push("a1"));
    watch.watch("tld1_a", () => closed.push("a2"));
    watch.watch("tld1_b", () => closed.push("b"));
    await watch.checkAll();
    expect(closed.sort()).toEqual(["a1", "a2"]);
    expect(revoked).toEqual([relayKey({ bearer: "tld1_a" })]);
    expect(watch.watchedSockets).toBe(1);
    watch.dispose();
  });

  it("keeps the sockets when tmux-api cannot answer", async () => {
    const { watch, revoked } = makeWatch(() => DOWN);
    let closed = false;
    watch.watch("tld1_a", () => {
      closed = true;
    });
    await watch.checkAll();
    expect(closed).toBe(false);
    expect(revoked).toEqual([]);
    watch.dispose();
  });

  it("re-checks on its interval, only while a socket is watched", async () => {
    vi.useFakeTimers();
    let answer: GateDecision = OK;
    const { watch, asked } = makeWatch(() => answer, 60_000);
    let closed = false;
    const unwatch = watch.watch("tld1_a", () => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toEqual(["tld1_a"]);
    answer = REFUSED;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closed).toBe(true);
    unwatch();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(asked).toHaveLength(2);
  });

  it("checks at once on suspicion, sharing one check between concurrent calls", async () => {
    const { watch, asked, revoked } = makeWatch(() => REFUSED);
    await Promise.all([watch.suspect("tld1_a"), watch.suspect("tld1_a")]);
    expect(asked).toEqual(["tld1_a"]);
    // A bearer with no socket is still forgotten by the hub.
    expect(revoked).toEqual([relayKey({ bearer: "tld1_a" })]);
  });
});
