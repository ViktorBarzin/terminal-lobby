/**
 * The models a pi session can start on, per OS user, from GET /pi-models
 * (ADR-0031). Pi prints its own list before any session exists, and people on
 * the box sign into different providers, so no list is written down in the
 * frontend: tmux-api runs `pi --list-models` as the user, filters it by their
 * `enabledModels`, and this client keeps the answer for the life of the page.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  ensurePiModels,
  parsePiModels,
  piModels,
  refreshPiModels,
  resetPiModels,
} from "../src/lib/pi-models";

const OPUS = {
  ref: "anthropic/claude-opus-5",
  provider: "anthropic",
  id: "claude-opus-5",
  thinking: true,
};
const MINI = {
  ref: "openai/gpt-5.4-mini",
  provider: "openai",
  id: "gpt-5.4-mini",
  thinking: false,
};

/** A fetch that answers from a script, recording each URL it was asked for. */
function serve(...answers: Array<{ status?: number; body?: unknown } | Error>) {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = async (input: string) => {
    urls.push(input);
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
  };
  return { fetchImpl, urls, calls: () => i };
}

beforeEach(() => resetPiModels());

describe("parsePiModels", () => {
  it("keeps the rows, the sign-in and the error as the server sent them", () => {
    expect(parsePiModels({ signedIn: true, models: [OPUS, MINI] })).toEqual({
      signedIn: true,
      models: [OPUS, MINI],
    });
    expect(parsePiModels({ signedIn: false, models: [], error: "pi timed out" })).toEqual({
      signedIn: false,
      models: [],
      error: "pi timed out",
    });
  });

  // A reference goes onto a launch command line. One the attach's pattern
  // would refuse is dropped here rather than offered.
  it("drops a row whose reference the attach would refuse", () => {
    const got = parsePiModels({
      signedIn: true,
      models: [OPUS, { ...MINI, ref: "has space" }, { ...MINI, ref: 7 }, null, "x", MINI],
    });
    expect(got?.models.map((m) => m.ref)).toEqual([OPUS.ref, MINI.ref]);
  });

  it("reads anything missing as the cautious answer", () => {
    expect(parsePiModels({})).toEqual({ signedIn: false, models: [] });
    expect(parsePiModels({ models: [{ ref: OPUS.ref }] })).toEqual({
      signedIn: false,
      models: [{ ref: OPUS.ref, provider: "", id: "", thinking: false }],
    });
  });

  it("refuses a body that is not an answer at all", () => {
    expect(parsePiModels(null)).toBeNull();
    expect(parsePiModels([OPUS])).toBeNull();
    expect(parsePiModels("models")).toBeNull();
  });
});

describe("the page's copy of the list", () => {
  it("asks tmux-api, under the same prefix GET /new-commands uses", async () => {
    const s = serve({ body: { signedIn: true, models: [OPUS] } });
    await refreshPiModels(s.fetchImpl);
    expect(s.urls).toEqual(["/api/sessions/pi-models"]);
  });

  it("holds the answer for the rest of the page", async () => {
    expect(piModels()).toBeUndefined();
    const s = serve({ body: { signedIn: true, models: [OPUS] } });
    await refreshPiModels(s.fetchImpl);
    expect(piModels()?.models.map((m) => m.ref)).toEqual([OPUS.ref]);
  });

  // Opening the composer is what refreshes. Two things asking at once (the
  // composer and a pi session's chip) share one read: each costs the server a
  // login shell running pi.
  it("shares one read between callers that arrive together", async () => {
    const s = serve({ body: { signedIn: true, models: [OPUS] } });
    const [a, b] = await Promise.all([refreshPiModels(s.fetchImpl), refreshPiModels(s.fetchImpl)]);
    expect(s.calls()).toBe(1);
    expect(a).toEqual(b);
  });

  it("asks again on the next refresh, and takes the newer answer", async () => {
    const s = serve(
      { body: { signedIn: true, models: [OPUS] } },
      { body: { signedIn: true, models: [OPUS, MINI] } },
    );
    await refreshPiModels(s.fetchImpl);
    await refreshPiModels(s.fetchImpl);
    expect(s.calls()).toBe(2);
    expect(piModels()?.models.map((m) => m.ref)).toEqual([OPUS.ref, MINI.ref]);
  });

  // A blip must not empty a picker that was working a moment ago.
  it("keeps the last answer when a later read fails", async () => {
    const s = serve(
      { body: { signedIn: true, models: [OPUS] } },
      { status: 502 },
      new Error("network down"),
      { body: "not json at all" },
    );
    await refreshPiModels(s.fetchImpl);
    await refreshPiModels(s.fetchImpl);
    await refreshPiModels(s.fetchImpl);
    await refreshPiModels(s.fetchImpl);
    expect(piModels()?.models.map((m) => m.ref)).toEqual([OPUS.ref]);
  });

  it("stays empty-handed, rather than inventing an answer, when the first read fails", async () => {
    const s = serve({ status: 500 });
    expect(await refreshPiModels(s.fetchImpl)).toBeUndefined();
    expect(piModels()).toBeUndefined();
  });

  it("recovers from a fetch that throws before it returns", async () => {
    const broken = () => {
      throw new Error("synchronous");
    };
    expect(await refreshPiModels(broken as never)).toBeUndefined();
    const s = serve({ body: { signedIn: true, models: [MINI] } });
    await refreshPiModels(s.fetchImpl);
    expect(s.calls()).toBe(1);
    expect(piModels()?.models.map((m) => m.ref)).toEqual([MINI.ref]);
  });

  // A pi session's chip only needs a list, not a fresh one.
  it("reads once for callers that only need some answer", async () => {
    const s = serve({ body: { signedIn: true, models: [OPUS] } });
    await ensurePiModels(s.fetchImpl);
    await ensurePiModels(s.fetchImpl);
    expect(s.calls()).toBe(1);
  });
});
