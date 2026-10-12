import { describe, expect, it } from "vitest";

import {
  ProxyAuthGate,
  type RelayCredentials,
  type WhoamiFetch,
  type WhoamiResult,
} from "../src/auth.ts";

const ADMIN: WhoamiResult = {
  status: 200,
  body: { authentik: "viktor", osUser: "wizard", admin: true, multiUser: true },
};

function fakeWhoami(answer: (relay: RelayCredentials) => WhoamiResult | Promise<WhoamiResult>) {
  const calls: RelayCredentials[] = [];
  const whoami: WhoamiFetch = async (relay) => {
    calls.push(relay);
    return answer(relay);
  };
  return { whoami, calls };
}

function makeGate(whoami: WhoamiFetch, clock = { now: 1_000 }) {
  return new ProxyAuthGate({
    authHeader: "X-Authentik-Username",
    whoami,
    now: () => clock.now,
    ttlMs: 30_000,
  });
}

const headers = (identity: string | undefined, secret: string | undefined) => ({
  ...(identity === undefined ? {} : { "x-authentik-username": identity }),
  ...(secret === undefined ? {} : { "x-tl-proxy-secret": secret }),
});

describe("ProxyAuthGate", () => {
  it("refuses a request with no identity header without asking tmux-api", async () => {
    const { whoami, calls } = fakeWhoami(() => ADMIN);
    const decision = await makeGate(whoami).check(headers(undefined, "s"));
    expect(decision).toMatchObject({ ok: false, status: 401 });
    expect(calls).toHaveLength(0);
  });

  it("refuses a request with no proxy secret without asking tmux-api", async () => {
    const { whoami, calls } = fakeWhoami(() => ADMIN);
    const decision = await makeGate(whoami).check(headers("viktor", undefined));
    expect(decision).toMatchObject({ ok: false, status: 401 });
    expect(calls).toHaveLength(0);
  });

  it("relays the configured header name and the secret to tmux-api", async () => {
    const { whoami, calls } = fakeWhoami(() => ADMIN);
    await makeGate(whoami).check(headers("viktor", "s3cret"));
    expect(calls).toEqual([
      { header: "X-Authentik-Username", identity: "viktor", secret: "s3cret" },
    ]);
  });

  it("reads the identity header case-insensitively", async () => {
    const { whoami } = fakeWhoami(() => ADMIN);
    const gate = new ProxyAuthGate({ authHeader: "x-AUTHENTIK-username", whoami });
    const decision = await gate.check(headers("viktor", "s3cret"));
    expect(decision.ok).toBe(true);
  });

  it("admits an admin and names the OS user", async () => {
    const { whoami } = fakeWhoami(() => ADMIN);
    const decision = await makeGate(whoami).check(headers("viktor", "s3cret"));
    expect(decision).toEqual({
      ok: true,
      identity: {
        osUser: "wizard",
        authentik: "viktor",
        relay: { header: "X-Authentik-Username", identity: "viktor", secret: "s3cret" },
      },
    });
  });

  it("refuses a user tmux-api does not call an admin with 403", async () => {
    const { whoami } = fakeWhoami(() => ({
      status: 200,
      body: { authentik: "anca", osUser: "anca", admin: false },
    }));
    expect(await makeGate(whoami).check(headers("anca", "s3cret"))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("refuses an answer that is acting as someone else", async () => {
    const { whoami } = fakeWhoami(() => ({
      status: 200,
      body: { authentik: "viktor", osUser: "anca", admin: true, realUser: "wizard" },
    }));
    expect(await makeGate(whoami).check(headers("viktor", "s3cret"))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("passes tmux-api's 401 for a wrong secret through", async () => {
    const { whoami } = fakeWhoami(() => ({ status: 401, body: undefined }));
    expect(await makeGate(whoami).check(headers("viktor", "wrong"))).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("passes tmux-api's 403 for an unmapped identity through", async () => {
    const { whoami } = fakeWhoami(() => ({ status: 403, body: undefined }));
    expect(await makeGate(whoami).check(headers("stranger", "s3cret"))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("answers 502 when tmux-api cannot be reached", async () => {
    const gate = makeGate(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await gate.check(headers("viktor", "s3cret"))).toMatchObject({ ok: false, status: 502 });
  });

  it("answers 502 for a malformed whoami body", async () => {
    const { whoami } = fakeWhoami(() => ({ status: 200, body: { osUser: 3 } }));
    expect(await makeGate(whoami).check(headers("viktor", "s3cret"))).toMatchObject({
      ok: false,
      status: 502,
    });
  });

  it("remembers an admitted pair for the TTL, then asks again", async () => {
    const clock = { now: 1_000 };
    const { whoami, calls } = fakeWhoami(() => ADMIN);
    const gate = makeGate(whoami, clock);
    await gate.check(headers("viktor", "s3cret"));
    clock.now += 29_999;
    expect((await gate.check(headers("viktor", "s3cret"))).ok).toBe(true);
    expect(calls).toHaveLength(1);
    clock.now += 2;
    expect((await gate.check(headers("viktor", "s3cret"))).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("does not let a remembered identity vouch for a different secret", async () => {
    const { whoami, calls } = fakeWhoami((relay) =>
      relay.secret === "s3cret" ? ADMIN : { status: 401, body: undefined },
    );
    const gate = makeGate(whoami);
    expect((await gate.check(headers("viktor", "s3cret"))).ok).toBe(true);
    expect(await gate.check(headers("viktor", "guess"))).toMatchObject({ ok: false, status: 401 });
    expect(calls).toHaveLength(2);
    // The failed guess does not evict the admitted pair.
    expect((await gate.check(headers("viktor", "s3cret"))).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("never remembers a refusal", async () => {
    let admin = false;
    const { whoami, calls } = fakeWhoami(() => ({
      status: 200,
      body: { authentik: "viktor", osUser: "wizard", admin },
    }));
    const gate = makeGate(whoami);
    expect((await gate.check(headers("viktor", "s3cret"))).ok).toBe(false);
    admin = true;
    expect((await gate.check(headers("viktor", "s3cret"))).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("asks tmux-api once for a burst of concurrent requests", async () => {
    let release: (() => void) | undefined;
    const gateOpen = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { whoami, calls } = fakeWhoami(async () => {
      await gateOpen;
      return ADMIN;
    });
    const gate = makeGate(whoami);
    const burst = Array.from({ length: 20 }, () => gate.check(headers("viktor", "s3cret")));
    release?.();
    const decisions = await Promise.all(burst);
    expect(decisions.every((d) => d.ok)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("keeps the secret out of its cache", async () => {
    const { whoami } = fakeWhoami(() => ADMIN);
    const gate = makeGate(whoami);
    await gate.check(headers("viktor", "s3cret-value"));
    expect(JSON.stringify(gate.cacheSnapshot())).not.toContain("s3cret-value");
  });
});
