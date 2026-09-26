// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExecResult, PiApi } from "../../devvm/pi-extension";

/**
 * devvm/pi-extension.js runs inside pi, not in the browser. It lives beside the
 * other devvm hooks and is tested here because this is the repository's
 * JavaScript test runner; vitest.config.ts already lets tests reach siblings.
 *
 * The extension reads its three endpoints from the environment when the module
 * loads, so they are set before the import: a test must never stamp through the
 * installed claude-tmux-state, read the machine's org policy, or post into the
 * production spend store.
 */

type Handler = (event: unknown, ctx: unknown) => unknown;
type Mod = typeof import("../../devvm/pi-extension");

interface Call {
  command: string;
  args: string[];
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-test-"));
const policyPath = path.join(dir, "org-policy.md");
const posts: Record<string, unknown>[] = [];
let server: http.Server;
let mod: Mod;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      posts.push(JSON.parse(body));
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  process.env.TL_PI_STATE_SCRIPT = "/test/claude-tmux-state";
  process.env.TL_PI_ORG_POLICY = policyPath;
  process.env.TL_PI_USAGE_ENDPOINT = `http://127.0.0.1:${port}/hooks/pi-usage`;
  mod = await import("../../devvm/pi-extension.js");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

// fakePi records every handler and every command, and answers tmux's
// display-message with a session name.
function fakePi() {
  const handlers = new Map<string, Handler>();
  const calls: Call[] = [];
  const models: unknown[] = [];
  let level = "medium";
  const pi: PiApi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    async exec(command, args): Promise<ExecResult> {
      calls.push({ command, args });
      const stdout = args[0] === "display-message" ? "tl-1234\n" : "";
      return { stdout, stderr: "", code: 0 };
    },
    async setModel(model) {
      models.push(model);
      return true;
    },
    getThinkingLevel: () => level,
    setThinkingLevel(l) {
      level = l;
    },
  };
  const fire = (event: string, payload: unknown, ctx: unknown) =>
    handlers.get(event)?.(payload, ctx);
  return { pi, handlers, calls, models, fire, level: () => level };
}

const sonnet = {
  provider: "anthropic",
  id: "claude-sonnet-5",
  reasoning: true,
  thinkingLevelMap: {},
};

function tuiCtx(entries: unknown[] = []) {
  return {
    mode: "tui",
    hasUI: true,
    model: sonnet,
    ui: { notify: () => {} },
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "anthropic" && id === "claude-sonnet-5" ? sonnet : undefined,
    },
    sessionManager: { getSessionId: () => "sess-1", getEntries: () => entries },
  };
}

// settle waits for the extension's promise chain, which the handlers do not
// return, to drain.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const stamps = (calls: Call[]) =>
  calls.filter((c) => c.command === "/test/claude-tmux-state").map((c) => c.args[0]);
const paneOption = (calls: Call[], name: string) =>
  calls
    .filter((c) => c.command === "tmux" && c.args.includes(name))
    .map((c) => c.args[c.args.length - 1]);

describe("sessionTotals", () => {
  it("adds assistant, tool result, usage and summary entries, and skips the rest", () => {
    const u = (input: number, cost: number) => ({
      input,
      output: 1,
      cacheRead: 2,
      cacheWrite: 3,
      cost: { total: cost },
    });
    const totals = mod.sessionTotals([
      { type: "message", message: { role: "assistant", usage: u(10, 0.1) } },
      { type: "message", message: { role: "toolResult", usage: u(5, 0.05) } },
      { type: "message", message: { role: "user", usage: u(1000, 9) } },
      { type: "usage", usage: u(1, 0.01) },
      { type: "compaction", usage: u(2, 0.02) },
      { type: "branch_summary", usage: u(3, 0.03) },
      { type: "custom", usage: u(1000, 9) },
      null,
      "junk",
    ]);
    expect(totals.input).toBe(21);
    expect(totals.output).toBe(5);
    expect(totals.cacheRead).toBe(10);
    expect(totals.cacheWrite).toBe(15);
    expect(totals.cost).toBeCloseTo(0.21, 10);
  });

  it.each([[undefined], [null], [{}], ["x"]])("reads %j as no usage", (entries) => {
    expect(mod.sessionTotals(entries)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
  });

  it("ignores negative and non-numeric counts", () => {
    const totals = mod.sessionTotals([
      {
        type: "usage",
        usage: {
          input: -5,
          output: "7",
          cacheRead: Number.NaN,
          cacheWrite: 2.6,
          cost: { total: -1 },
        },
      },
    ]);
    expect(totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 3, cost: 0 });
  });
});

describe("supportedLevels", () => {
  // pi-ai does not resolve from this repository, so these exercise the
  // written-out rule the extension falls back to.
  it.each([
    ["no model", undefined, ["off"]],
    ["a model without reasoning", { reasoning: false }, ["off"]],
    [
      "a reasoning model with no map",
      { reasoning: true },
      ["off", "minimal", "low", "medium", "high"],
    ],
    [
      "a map that names xhigh and max",
      { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    ],
    [
      "a map that turns levels off with null",
      { reasoning: true, thinkingLevelMap: { minimal: null, max: null } },
      ["off", "low", "medium", "high"],
    ],
  ])("offers the right levels for %s", async (_name, model, want) => {
    expect(await mod.supportedLevels(model)).toEqual(want);
  });
});

describe("the extension inside pi", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.TMUX_PANE = "%7";
    posts.length = 0;
    fs.rmSync(policyPath, { force: true });
  });

  afterEach(() => {
    for (const k of ["TMUX_PANE", "TL_PI_MODEL", "TL_PI_THINKING"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("runs nothing when pi loads it", () => {
    const f = fakePi();
    mod.default(f.pi);
    expect(f.calls).toEqual([]);
    expect(f.handlers.size).toBeGreaterThan(0);
  });

  it("stamps done and the model details at session start", async () => {
    const f = fakePi();
    mod.default(f.pi);
    await f.fire("session_start", {}, tuiCtx());
    await settle();
    expect(stamps(f.calls)).toEqual(["done"]);
    expect(paneOption(f.calls, "@tl_pi_model")).toEqual(["anthropic/claude-sonnet-5"]);
    expect(paneOption(f.calls, "@tl_pi_thinking")).toEqual(["medium"]);
    expect(paneOption(f.calls, "@tl_pi_levels")).toEqual(["off,minimal,low,medium,high"]);
    // claude-tmux-state finds the pane from TMUX_PANE itself; tmux is told.
    for (const c of f.calls.filter((c) => c.command === "tmux")) expect(c.args).toContain("%7");
  });

  it("applies the composer's model and thinking level once, and takes them out of the environment", async () => {
    process.env.TL_PI_MODEL = "anthropic/claude-sonnet-5";
    process.env.TL_PI_THINKING = "high";
    const f = fakePi();
    mod.default(f.pi);
    await f.fire("session_start", {}, tuiCtx());
    expect(f.models).toEqual([sonnet]);
    expect(f.level()).toBe("high");
    expect(process.env.TL_PI_MODEL).toBeUndefined();
    expect(process.env.TL_PI_THINKING).toBeUndefined();
  });

  it("keeps the default model and says so when the launch model is unknown", async () => {
    process.env.TL_PI_MODEL = "openai/gone";
    const notices: string[] = [];
    const f = fakePi();
    mod.default(f.pi);
    await f.fire(
      "session_start",
      {},
      { ...tuiCtx(), ui: { notify: (m: string) => notices.push(m) } },
    );
    expect(f.models).toEqual([]);
    expect(notices.join(" ")).toContain("openai/gone");
  });

  it.each([
    ["print mode", { ...tuiCtx(), mode: "print" }, "%7"],
    ["no tmux pane", tuiCtx(), ""],
  ])("touches nothing in %s", async (_name, ctx, paneId) => {
    process.env.TMUX_PANE = paneId;
    const f = fakePi();
    mod.default(f.pi);
    await f.fire("session_start", {}, ctx);
    await f.fire("agent_start", {}, ctx);
    await f.fire("agent_settled", {}, ctx);
    await settle();
    expect(f.calls).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("walks the dot through a turn in order", async () => {
    const f = fakePi();
    mod.default(f.pi);
    const ctx = tuiCtx();
    await f.fire("agent_start", {}, ctx);
    await f.fire("ui_prompt_start", {}, ctx);
    await f.fire("ui_prompt_end", {}, ctx);
    await f.fire("agent_settled", {}, ctx);
    await f.fire("ui_prompt_start", {}, ctx);
    await f.fire("ui_prompt_end", {}, ctx);
    await settle();
    expect(stamps(f.calls)).toEqual(["running", "awaiting", "running", "done", "awaiting", "done"]);
  });

  it("marks the trust question as awaiting and leaves the decision to pi", async () => {
    const f = fakePi();
    mod.default(f.pi);
    const answer = await f.fire("project_trust", {}, tuiCtx());
    await settle();
    expect(answer).toEqual({ trusted: "undecided" });
    expect(stamps(f.calls)).toEqual(["awaiting"]);
  });

  it("posts the running totals once a turn settles, and not again when nothing moved", async () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
        },
      },
    ];
    const f = fakePi();
    mod.default(f.pi);
    const ctx = tuiCtx(entries);
    await f.fire("agent_settled", {}, ctx);
    await settle();
    await f.fire("agent_settled", {}, ctx);
    await settle();
    expect(posts).toEqual([
      {
        user: os.userInfo().username,
        tmux_session: "tl-1234",
        sessionId: "sess-1",
        model: "anthropic/claude-sonnet-5",
        costUsd: 0.25,
        tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    expect(paneOption(f.calls, "@tl_usage_cost")).toEqual(["0.25"]);
  });

  it("adds the org policy to every turn's system prompt, in every mode", async () => {
    fs.writeFileSync(policyPath, "  Follow the org rules.\n");
    const f = fakePi();
    mod.default(f.pi);
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    await f.fire("before_agent_start", event, { mode: "print" });
    expect(event.systemPromptOptions.sections).toEqual({ org_policy: "Follow the org rules." });
  });

  it("adds no section when the policy file is missing", async () => {
    const f = fakePi();
    mod.default(f.pi);
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    await f.fire("before_agent_start", event, tuiCtx());
    expect(event.systemPromptOptions.sections).toEqual({});
  });

  it.each([
    ["quit", ["clear"]],
    ["reload", []],
  ])("on a %s shutdown stamps %j", async (reason, want) => {
    const f = fakePi();
    mod.default(f.pi);
    await f.fire("session_shutdown", { reason }, tuiCtx());
    expect(stamps(f.calls)).toEqual(want);
  });
});
