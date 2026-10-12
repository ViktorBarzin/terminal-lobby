import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  PlanId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import type { Identity } from "../src/auth.ts";
import {
  CommandFailure,
  Commands,
  type LobbyCalls,
  type ThreadHandle,
} from "../src/commands/dispatch.ts";
import { LobbyApi, LobbyError } from "../src/lobby/api.ts";
import { SequenceClock } from "../src/sequence.ts";
import { CLAUDE_INSTANCE_ID } from "../src/serverConfig.ts";
import type { DirectoryEntry, DirectoryProject } from "../src/shell/directory.ts";
import { LiveThread } from "../src/threads/live.ts";
import { PendingDispatches } from "../src/threads/pending.ts";
import { fixture, testThread } from "./helpers/projection.ts";

const identity: Identity = {
  osUser: "wizard",
  authentik: "viktor",
  relay: { header: "X-Authentik-Username", identity: "viktor", secret: "s" },
};

interface Call {
  readonly op: string;
  readonly args: ReadonlyArray<unknown>;
}

function fakeApi(
  overrides: Partial<Record<keyof LobbyCalls, (...args: unknown[]) => unknown>> = {},
) {
  const calls: Call[] = [];
  const record =
    (op: keyof LobbyCalls, fallback: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ op, args: args.slice(1) });
      const override = overrides[op];
      return override === undefined ? fallback : override(...args);
    };
  const api: LobbyCalls = {
    prompt: record("prompt", undefined),
    cancel: record("cancel", { restored: false, queue: [] }),
    cancelQueued: record("cancelQueued", { restored: true, queue: ["x"] }),
    answer: record("answer", { applied: true, done: true }),
    mode: record("mode", { applied: true, mode: "manual" }),
    model: record("model", { model: "claude-sonnet-5", effort: "high" }),
    prewarm: record("prewarm", undefined),
    claim: record("claim", { claimed: true, found: "claimed", placed: true }),
  } as LobbyCalls;
  return { api, calls };
}

function setup(
  options: {
    access?: string;
    frames?: string[];
    api?: ReturnType<typeof fakeApi>;
    draftListed?: boolean;
    offered?: ReadonlyArray<string>;
  } = {},
) {
  const logs: string[] = [];
  const pending = new PendingDispatches({ now: () => 1_791_794_200_000 });
  const live = new LiveThread({
    osUser: "wizard",
    threadId: testThread().id,
    thread: testThread(),
    api: new LobbyApi({ tmuxApiUrl: "http://127.0.0.1:9", sessionEventsUrl: "http://127.0.0.1:9" }),
    clock: new SequenceClock(1_791_794_000_000),
    pending,
    locate: async () => undefined,
    now: () => 1_791_794_200_000,
  });
  for (const name of options.frames ?? ["01-open-first-turn.sse"]) {
    for (const frame of fixture(name)) live.model.onFrame(frame);
  }
  const entry: DirectoryEntry = {
    threadId: testThread().id,
    name: "running-echo-hi-with-bash-tool",
    projectId: ProjectId.make("project:lobby"),
    session: { name: "running-echo-hi-with-bash-tool", created: 1 },
    ...(options.access === undefined ? {} : { owner: "emo", access: options.access }),
  };
  const handle: ThreadHandle = { entry, live };
  const { api, calls } = options.api ?? fakeApi();
  const aliases: Array<[string, string]> = [];
  let draftLooks = 0;
  const project: DirectoryProject = {
    id: ProjectId.make("project:lobby"),
    title: "lobby",
    workspaceRoot: "/home/wizard/code/lobby",
    layoutName: "lobby",
    dir: "/home/wizard/code/lobby",
  };
  const commands = new Commands({
    api,
    pending,
    now: () => 1_791_794_200_000,
    thread: async (_identity, id) => {
      // The draft's session is listed only on the second look, as tmux-api's
      // session cache makes a fresh claim wait.
      if (id === "t3-draft")
        return options.draftListed === true || ++draftLooks >= 2 ? handle : undefined;
      return id === entry.threadId ? handle : undefined;
    },
    project: async (_identity, id) => (id === project.id ? project : undefined),
    alias: (_identity, minted, threadId) => aliases.push([minted, threadId]),
    sleep: async () => {},
    mintName: () => "bw8k5gt9v314",
    knownModels: (who) =>
      new Set([
        "claude-opus-5-5",
        "claude-haiku-4-5-20251001",
        ...(who.osUser === "wizard" ? (options.offered ?? []) : []),
      ]),
    log: (line) => logs.push(line),
  });
  return { commands, calls, live, pending, aliases, logs };
}

const base = {
  commandId: CommandId.make("c1eaff2f-bfd0-46ed-b84a-d7e4b7c2b220"),
  threadId: ThreadId.make("scratch"),
};

function message(
  extra: Partial<Extract<OrchestrationV2Command, { type: "message.dispatch" }>> = {},
): OrchestrationV2Command {
  return {
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    ...base,
    messageId: MessageId.make("client-m1"),
    text: "hello there",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    ...extra,
  };
}

/** The frames of 04-steer.sse up to the first tool call: a turn running. */
function runningFrames(live: LiveThread) {
  const frames = fixture("04-steer.sse");
  const at = frames.findIndex((f) => f.data.includes('"kind":"tool_use"'));
  for (const frame of frames.slice(0, at + 1)) live.model.onFrame(frame);
}

describe("message.dispatch", () => {
  it("starts a turn with T3's command id as the prompt id, under the client's message id", async () => {
    const { commands, calls, live } = setup();
    await commands.dispatch(identity, message({ deliveryIntent: "auto" }));
    expect(calls).toEqual([
      {
        op: "prompt",
        args: [
          "running-echo-hi-with-bash-tool",
          undefined,
          { text: "hello there", id: base.commandId },
        ],
      },
    ]);
    live.model.onFrame({
      event: "message",
      data: '{"id":90,"kind":"user","session":"s","turnId":"t9","body":"hello there","at":1}',
    });
    const user = live.projection.turnItems.findLast((i) => i.type === "user_message");
    expect(user?.type === "user_message" && user.messageId).toBe("client-m1");
  });

  it("leaves the model alone when the session runs one the composer cannot show", async () => {
    // The fixture session answers on claude-haiku-5-5, which the composer does
    // not list, so the Opus it shows is its fallback, not a choice.
    const { commands, calls } = setup();
    await commands.dispatch(
      identity,
      message({ modelSelection: { instanceId: CLAUDE_INSTANCE_ID, model: "claude-opus-5-5" } }),
    );
    expect(calls.map((c) => c.op)).toEqual(["prompt"]);
  });

  it("changes the model when the session's own unlisted model is offered as a row", async () => {
    // The fixture session is on claude-haiku-5-5; once the composer lists it,
    // the Opus in the send is the person's pick.
    const { commands, calls } = setup({ offered: ["claude-haiku-5-5"] });
    await commands.dispatch(
      identity,
      message({ modelSelection: { instanceId: CLAUDE_INSTANCE_ID, model: "claude-opus-5-5" } }),
    );
    expect(calls.map((c) => [c.op, c.args[2]])).toEqual([
      ["model", { model: "claude-opus-5-5" }],
      ["prompt", { text: "hello there", id: base.commandId }],
    ]);
  });

  it("changes the model before a send when the person picked another one", async () => {
    const { commands, calls, live } = setup();
    live.commit(live.model.mapper.confirmModel({ model: "claude-haiku-4-5-20251001" }));
    await commands.dispatch(
      identity,
      message({ modelSelection: { instanceId: CLAUDE_INSTANCE_ID, model: "claude-opus-5-5" } }),
    );
    expect(calls.map((c) => [c.op, c.args[2]])).toEqual([
      ["model", { model: "claude-opus-5-5" }],
      ["prompt", { text: "hello there", id: base.commandId }],
    ]);
  });

  it("steers a running turn, and queues behind it with wait", async () => {
    const { commands, calls, live } = setup();
    runningFrames(live);
    await commands.dispatch(identity, message({ deliveryIntent: "steer" }));
    await commands.dispatch(identity, message({ dispatchMode: { type: "queue_after_active" } }));
    expect(calls.map((c) => c.args[2])).toEqual([
      { text: "hello there" },
      { text: "hello there", wait: true },
    ]);
  });

  it("restarts: stops with the queue taken back, sends, then holds the queue again", async () => {
    const api = fakeApi({ cancel: () => ({ restored: true, queue: ["held one"] }) });
    const { commands, calls, live } = setup({ api });
    runningFrames(live);
    await commands.dispatch(identity, message({ deliveryIntent: "restart" }));
    expect(calls).toEqual([
      { op: "cancel", args: ["running-echo-hi-with-bash-tool", undefined, true] },
      {
        op: "prompt",
        args: [
          "running-echo-hi-with-bash-tool",
          undefined,
          { text: "hello there", id: base.commandId },
        ],
      },
      {
        op: "prompt",
        args: ["running-echo-hi-with-bash-tool", undefined, { text: "held one", wait: true }],
      },
    ]);
  });

  it("refuses a read-only session with the lobby's reason and sends nothing", async () => {
    const { commands, calls } = setup({ access: "ro" });
    await expect(commands.dispatch(identity, message())).rejects.toThrow("to watch, not to drive");
    expect(calls).toEqual([]);
  });

  it("returns the lobby's refusal in its own words and forgets the pending id", async () => {
    const api = fakeApi({
      prompt: () => {
        throw new LobbyError(409, "session x is suspended — resume it before sending\n");
      },
    });
    const { commands, pending, live } = setup({ api });
    await expect(commands.dispatch(identity, message())).rejects.toThrow(
      new CommandFailure("session x is suspended — resume it before sending"),
    );
    expect(pending.list(live.pendingKey)).toEqual([]);
  });

  it("approves a held plan when Implement sends the plan back", async () => {
    const { commands, calls, live } = setup();
    runningFrames(live);
    live.model.onFrame({
      event: "message",
      data: JSON.stringify({
        id: 900,
        kind: "meta",
        session: "s",
        meta: "asking",
        body: JSON.stringify({
          kind: "plan",
          plan: "# Plan",
          toolId: "toolu_plan",
          tool: "ExitPlanMode",
        }),
      }),
    });
    await commands.dispatch(
      identity,
      message({
        text: "PLEASE IMPLEMENT THIS PLAN",
        sourcePlanRef: { threadId: base.threadId, planId: PlanId.make("plan:toolu_plan") },
      }),
    );
    expect(calls).toEqual([
      {
        op: "answer",
        args: [
          "running-echo-hi-with-bash-tool",
          undefined,
          { toolId: "toolu_plan", plan: { option: 1, label: "Approve plan" } },
        ],
      },
    ]);
  });
});

describe("thread.visit", () => {
  it("records the visit on the thread, and never moves it back", async () => {
    const { commands, calls, live } = setup();
    const visit = (visitedAt: string) =>
      commands.dispatch(identity, { type: "thread.visit", ...base, visitedAt });
    await visit("2026-10-12T09:00:00.000Z");
    await visit("2026-10-12T08:00:00.000Z");
    expect(calls).toEqual([]);
    const at = live.projection.thread.lastVisitedAt;
    expect(at === null ? null : new Date(DateTime.toEpochMillis(at)).toISOString()).toBe(
      "2026-10-12T09:00:00.000Z",
    );
  });
});

describe("dialogs", () => {
  it("answers a permission prompt by its tool call", async () => {
    const { commands, calls, live } = setup();
    const frames = fixture("02-permission.sse");
    const at = frames.findIndex((f) => f.data.includes('"meta":"asking"'));
    for (const frame of frames.slice(0, at + 1)) live.model.onFrame(frame);
    await commands.dispatch(identity, {
      type: "runtime-request.respond",
      ...base,
      requestId: RuntimeRequestId.make("request:toolu_01LNxqGL65zRa7tULyGynHs5"),
      decision: "accept",
    });
    expect(calls[0]?.args[2]).toEqual({
      toolId: "toolu_01LNxqGL65zRa7tULyGynHs5",
      permission: { option: 1 },
    });
  });

  it("answers a question by its text", async () => {
    const { commands, calls, live } = setup({
      frames: ["01-open-first-turn.sse", "02-permission.sse"],
    });
    const frames = fixture("03-question.sse");
    const at = frames.findIndex((f) => f.data.includes('"meta":"held"'));
    for (const frame of frames.slice(0, at + 1)) live.model.onFrame(frame);
    await commands.dispatch(identity, {
      type: "runtime-request.respond",
      ...base,
      requestId: RuntimeRequestId.make("request:toolu_01VdjTrNDPQuz3TuCz7XUinB"),
      answers: { "Which colour do you prefer?": "Blue" },
    });
    expect(calls[0]?.args[2]).toEqual({
      toolId: "toolu_01VdjTrNDPQuz3TuCz7XUinB",
      answers: { "Which colour do you prefer?": ["Blue"] },
    });
  });

  it("refuses an answer to a request that is no longer open", async () => {
    const { commands } = setup();
    await expect(
      commands.dispatch(identity, {
        type: "runtime-request.respond",
        ...base,
        requestId: RuntimeRequestId.make("request:gone"),
        decision: "accept",
      }),
    ).rejects.toThrow("already been answered");
  });
});

describe("queue, stop, mode and model", () => {
  it("cancels and edits a queued message by its text", async () => {
    const { commands, calls, live } = setup();
    runningFrames(live);
    live.model.onFrame({
      event: "message",
      data: '{"id":901,"kind":"meta","session":"s","meta":"queued","body":"later please"}',
    });
    const [queued] = live.model.mapper.queuedRuns;
    expect(queued).toBeDefined();
    const runId = queued?.run.id ?? RunId.make("none");
    await commands.dispatch(identity, {
      type: "queued-run.edit",
      ...base,
      runId,
      text: "later, edited",
    });
    expect(calls.map((c) => [c.op, c.args[2]])).toEqual([
      ["cancelQueued", "later please"],
      ["prompt", { text: "later, edited", wait: true }],
    ]);
    // The lobby takes the old text off and queues the new: the same run stays
    // queued under the new text, as T3's edit expects.
    live.model.onFrame({
      event: "message",
      data: '{"id":902,"kind":"meta","session":"s","meta":"unqueued","body":"later please"}',
    });
    live.model.onFrame({
      event: "message",
      data: '{"id":903,"kind":"meta","session":"s","meta":"queued","body":"later, edited"}',
    });
    expect(live.model.mapper.queuedRuns.map((q) => [q.run.id, q.run.status, q.text])).toEqual([
      [runId, "queued", "later, edited"],
    ]);
    const message = live.projection.messages.find((m) => m.id === queued?.run.userMessageId);
    expect(message?.text).toBe("later, edited");
  });

  it("stops the turn and shows the request, leaving the queue to run when Stop does not hold it", async () => {
    const { commands, calls, live } = setup();
    runningFrames(live);
    const run = live.model.mapper.activeRun;
    await commands.dispatch(identity, {
      type: "run.interrupt",
      ...base,
      runId: run?.id ?? RunId.make("x"),
    });
    expect(calls).toEqual([
      { op: "cancel", args: ["running-echo-hi-with-bash-tool", undefined, false] },
    ]);
    expect(live.projection.turnItems.some((i) => i.type === "run_interrupt_request")).toBe(true);
  });

  describe("a Stop that holds the queue, as T3's Stop button does", () => {
    const meta = (id: number, kind: string, body: string) => ({
      event: "message",
      data: JSON.stringify({ id, kind: "meta", session: "s", meta: kind, body }),
    });
    const lobbyEvent = (o: Record<string, unknown>) => ({
      event: "message",
      data: JSON.stringify({ session: "s", ...o }),
    });

    async function stopHolding(returned: ReadonlyArray<string> = ["later please"]) {
      const api = fakeApi({ cancel: () => ({ restored: returned.length > 0, queue: returned }) });
      const t = setup({ api });
      runningFrames(t.live);
      t.live.model.onFrame(meta(901, "queued", "later please"));
      const queuedId = t.live.model.mapper.queuedRuns[0]?.run.id ?? RunId.make("none");
      await t.commands.dispatch(identity, {
        type: "run.interrupt",
        ...base,
        runId: t.live.model.mapper.activeRun?.id ?? RunId.make("x"),
        holdQueue: true,
      });
      // session-events takes the held prompts off its queue, then the turn ends.
      t.live.model.onFrame(meta(902, "unqueued", "later please"));
      t.live.model.onFrame(lobbyEvent({ id: 903, kind: "turn_end", turnId: "t-stop" }));
      return { ...t, queuedId };
    }

    const held = (live: LiveThread) =>
      live.model.mapper.queuedRuns.map((q) => [q.run.id, q.run.status, q.run.queueHeld, q.text]);

    it("takes the queue back from the lobby, and keeps its runs queued with queueHeld", async () => {
      const { calls, live, queuedId } = await stopHolding();
      expect(calls).toEqual([
        { op: "cancel", args: ["running-echo-hi-with-bash-tool", undefined, true] },
      ]);
      expect(held(live)).toEqual([[queuedId, "queued", true, "later please"]]);
      expect(live.projection.runs.find((r) => r.id === queuedId)?.queuePosition).toBe(1);
    });

    it("holds a prompt the lobby handed back that was not shown queued, as a run of its own", async () => {
      const { live, queuedId } = await stopHolding(["later please", "and this"]);
      const runs = held(live);
      expect(runs[0]).toEqual([queuedId, "queued", true, "later please"]);
      expect(runs.slice(1).map((r) => r.slice(1))).toEqual([["queued", true, "and this"]]);
    });

    it("resends the held prompts on queue.resume, and the same run starts", async () => {
      const { commands, calls, live, queuedId } = await stopHolding();
      calls.length = 0;
      await commands.dispatch(identity, { type: "queue.resume", ...base });
      expect(calls).toEqual([
        {
          op: "prompt",
          args: ["running-echo-hi-with-bash-tool", undefined, { text: "later please", wait: true }],
        },
      ]);
      expect(live.projection.runs.find((r) => r.id === queuedId)?.queueHeld).toBe(false);
      live.model.onFrame(
        lobbyEvent({ id: 904, kind: "user", turnId: "t-next", body: "later please" }),
      );
      const started = live.projection.runs.find((r) => r.id === queuedId);
      expect(started).toMatchObject({ status: "running", queueHeld: false });
      expect(live.projection.runs.filter((r) => r.status === "queued")).toEqual([]);
    });

    it("keeps one run when a resumed prompt is queued behind a turn again", async () => {
      const { commands, live, queuedId } = await stopHolding();
      live.model.onFrame(lobbyEvent({ id: 905, kind: "user", turnId: "t-other", body: "other" }));
      await commands.dispatch(identity, { type: "queue.resume", ...base });
      live.model.onFrame(meta(906, "queued", "later please"));
      expect(held(live)).toEqual([[queuedId, "queued", false, "later please"]]);
    });

    it("cancels and edits a held prompt where it is, since the lobby no longer has it", async () => {
      const { commands, calls, live, queuedId } = await stopHolding(["later please", "and this"]);
      const second = live.model.mapper.queuedRuns[1]?.run.id ?? RunId.make("none");
      calls.length = 0;
      await commands.dispatch(identity, {
        type: "queued-run.edit",
        ...base,
        runId: queuedId,
        text: "later, edited",
      });
      await commands.dispatch(identity, { type: "queued-run.cancel", ...base, runId: second });
      expect(calls).toEqual([]);
      expect(held(live)).toEqual([[queuedId, "queued", true, "later, edited"]]);
      expect(live.projection.runs.find((r) => r.id === second)?.status).toBe("cancelled");
    });

    it("restores held prompts into a model rebuilt from the same log", async () => {
      const { live, queuedId } = await stopHolding(["later please", "and this"]);
      const kept = live.model.mapper.heldRuns;
      // A rebuild (or a restart) replays the log, where the hand-back reads as
      // the prompt leaving the queue.
      const rebuilt = setup().live;
      runningFrames(rebuilt);
      rebuilt.model.onFrame(meta(901, "queued", "later please"));
      rebuilt.model.onFrame(meta(902, "unqueued", "later please"));
      rebuilt.model.onFrame(lobbyEvent({ id: 903, kind: "turn_end", turnId: "t-stop" }));
      expect(rebuilt.projection.runs.find((r) => r.id === queuedId)?.status).toBe("cancelled");

      rebuilt.commit(rebuilt.model.mapper.restoreHeld(kept));
      const runs = held(rebuilt);
      expect(runs[0]).toEqual([queuedId, "queued", true, "later please"]);
      expect(runs.slice(1).map((r) => r.slice(1))).toEqual([["queued", true, "and this"]]);
      expect(rebuilt.model.mapper.heldRuns.map((r) => r.text)).toEqual([
        "later please",
        "and this",
      ]);
      const second = rebuilt.projection.runs.find((r) => r.id === runs[1]?.[0]);
      expect(second?.userMessageId).toBe(kept[1]?.messageId);
    });

    it("restores nothing the lobby still queues or the model already holds", async () => {
      const { live } = await stopHolding();
      const before = held(live);
      live.commit(live.model.mapper.restoreHeld(live.model.mapper.heldRuns));
      expect(held(live)).toEqual(before);
      const t = setup();
      runningFrames(t.live);
      t.live.model.onFrame(meta(901, "queued", "later please"));
      t.live.commit(
        t.live.model.mapper.restoreHeld([
          { messageId: MessageId.make("m-x"), text: "later please" },
        ]),
      );
      expect(held(t.live).map((r) => r.slice(1))).toEqual([["queued", undefined, "later please"]]);
    });

    it("lets the queue go again when the lobby refuses the Stop", async () => {
      const api = fakeApi({
        cancel: () => {
          throw new LobbyError(409, "the session's Claude did not stop the turn: idle");
        },
      });
      const { commands, live } = setup({ api });
      runningFrames(live);
      live.model.onFrame(meta(901, "queued", "later please"));
      await expect(
        commands.dispatch(identity, {
          type: "run.interrupt",
          ...base,
          runId: live.model.mapper.activeRun?.id ?? RunId.make("x"),
          holdQueue: true,
        }),
      ).rejects.toThrow("did not stop the turn");
      expect(held(live).map((r) => r[2])).toEqual([false]);
    });
  });

  it("sets the mode and moves the composer on the lobby's confirmation", async () => {
    const { commands, calls, live } = setup();
    await commands.dispatch(identity, {
      type: "thread.runtime-mode.set",
      ...base,
      runtimeMode: "approval-required",
    });
    expect(calls).toEqual([
      { op: "mode", args: ["running-echo-hi-with-bash-tool", undefined, "manual"] },
    ]);
    expect(live.projection.thread.runtimeMode).toBe("approval-required");
  });

  it("says so when the mode did not change", async () => {
    const api = fakeApi({ mode: () => ({ applied: false, reason: "dialog-open" }) });
    const { commands } = setup({ api });
    await expect(
      commands.dispatch(identity, {
        type: "thread.interaction-mode.set",
        ...base,
        interactionMode: "plan",
      }),
    ).rejects.toThrow("stayed in its mode (dialog-open)");
  });

  it("logs a command the lobby refused, with the reason", async () => {
    const api = fakeApi({ mode: () => ({ applied: false, reason: "dialog-open" }) });
    const { commands, logs } = setup({ api });
    await expect(
      commands.dispatch(identity, {
        type: "thread.interaction-mode.set",
        ...base,
        interactionMode: "plan",
      }),
    ).rejects.toThrow();
    expect(logs).toEqual([
      "wizard: thread.interaction-mode.set on scratch",
      "wizard: thread.interaction-mode.set on scratch failed: The session stayed in its mode (dialog-open).",
    ]);
  });

  it("surfaces a busy session's refusal of a model change", async () => {
    const api = fakeApi({
      model: () => {
        throw new LobbyError(409, "the session is working — stop it first");
      },
    });
    const { commands } = setup({ api });
    await expect(
      commands.dispatch(identity, {
        type: "thread.model-selection.set",
        ...base,
        modelSelection: { instanceId: CLAUDE_INSTANCE_ID, model: "claude-sonnet-5" },
      }),
    ).rejects.toThrow("the session is working — stop it first");
  });
});

describe("launchThread", () => {
  it("claims a slot in the project, keeps T3's thread id, and sends the first prompt when ready", async () => {
    let claims = 0;
    const api = fakeApi({
      claim: () => ({
        claimed: ++claims >= 2,
        found: claims >= 2 ? "claimed" : "none",
        placed: claims >= 2,
      }),
      mode: () => ({ applied: true, mode: "bypassPermissions" }),
    });
    const { commands, calls, aliases, pending, live } = setup({ api });
    const result = await commands.launch(identity, {
      commandId: CommandId.make("c-launch"),
      threadId: ThreadId.make("t3-draft"),
      projectId: ProjectId.make("project:lobby"),
      title: "New thread",
      modelSelection: { instanceId: CLAUDE_INSTANCE_ID, model: "claude-haiku-4-5-20251001" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make("first-m"), text: "say hi", attachments: [] },
    });
    expect(aliases).toEqual([["bw8k5gt9v314", "t3-draft"]]);
    expect(calls.map((c) => [c.op, c.args.at(-1)])).toEqual([
      ["prewarm", { dir: "/home/wizard/code/lobby", model: "claude-haiku-4-5-20251001" }],
      [
        "claim",
        {
          name: "bw8k5gt9v314",
          dir: "/home/wizard/code/lobby",
          model: "claude-haiku-4-5-20251001",
          project: "lobby",
        },
      ],
      [
        "claim",
        {
          name: "bw8k5gt9v314",
          dir: "/home/wizard/code/lobby",
          model: "claude-haiku-4-5-20251001",
          project: "lobby",
        },
      ],
      // The mode is in place before the first prompt reaches Claude.
      ["mode", "bypassPermissions"],
      ["prompt", { text: "say hi", awaitReady: true, id: "c-launch" }],
    ]);
    expect(pending.list(live.pendingKey).map((p) => p.messageId)).toEqual(["first-m"]);
    expect(result.threadId).toBe("scratch");
  });

  const launchInput = (interactionMode: "default" | "plan", runtimeMode = "full-access") => ({
    commandId: CommandId.make("c-launch"),
    threadId: ThreadId.make("t3-draft"),
    projectId: ProjectId.make("project:lobby"),
    title: "New thread",
    modelSelection: { instanceId: CLAUDE_INSTANCE_ID, model: "claude-haiku-4-5-20251001" },
    runtimeMode: runtimeMode as "full-access" | "approval-required",
    interactionMode,
    workspaceStrategy: { type: "root" as const },
    initialMessage: { messageId: MessageId.make("first-m"), text: "plan it", attachments: [] },
  });

  it("waits for the new session to take the chosen mode before sending the first prompt", async () => {
    const replies = [
      { applied: false, reason: "unreadable" },
      { applied: false, reason: "unverified" },
      { applied: true, mode: "plan" },
    ];
    const api = fakeApi({ mode: () => replies.shift() });
    const { commands, calls, live } = setup({ api });
    await commands.launch(identity, launchInput("plan"));
    expect(calls.filter((c) => c.op === "mode" || c.op === "prompt").map((c) => c.op)).toEqual([
      "mode",
      "mode",
      "mode",
      "prompt",
    ]);
    expect(live.projection.thread.interactionMode).toBe("plan");
  });

  it("does not send the first prompt when the session cannot take the chosen mode", async () => {
    const api = fakeApi({ mode: () => ({ applied: false, reason: "unavailable" }) });
    const { commands, calls, pending, live } = setup({ api });
    await expect(
      commands.launch(identity, launchInput("default", "approval-required")),
    ).rejects.toThrow("first message was not sent");
    expect(calls.filter((c) => c.op === "mode")).toHaveLength(1);
    expect(calls.some((c) => c.op === "prompt")).toBe(false);
    expect(pending.list(live.pendingKey)).toEqual([]);
  });

  it("refuses a project that is not the user's own", async () => {
    const { commands } = setup();
    await expect(
      commands.launch(identity, {
        commandId: CommandId.make("c"),
        projectId: ProjectId.make("shared:emo"),
        title: "x",
        modelSelection: { instanceId: CLAUDE_INSTANCE_ID, model: "m" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      }),
    ).rejects.toThrow("your own projects");
  });
  it("asks again while the new session's Claude has not said hello yet", async () => {
    let prompts = 0;
    const api = fakeApi({
      mode: () => ({ applied: true, mode: "bypassPermissions" }),
      prompt: () => {
        if (++prompts < 3) {
          throw new LobbyError(
            503,
            "session is not ready for input: its Claude has not connected to the lobby",
          );
        }
      },
    });
    const { commands, calls, pending, live } = setup({ api });
    await commands.launch(identity, launchInput("default"));
    // The same id each time, so session-events joins an attempt still waiting.
    expect(calls.filter((c) => c.op === "prompt").map((c) => c.args.at(-1))).toEqual([
      { text: "plan it", awaitReady: true, id: "c-launch" },
      { text: "plan it", awaitReady: true, id: "c-launch" },
      { text: "plan it", awaitReady: true, id: "c-launch" },
    ]);
    expect(pending.list(live.pendingKey).map((p) => p.messageId)).toEqual(["first-m"]);
  });

  it("does not ask again when the lobby refuses the first prompt for another reason", async () => {
    const api = fakeApi({
      mode: () => ({ applied: true, mode: "bypassPermissions" }),
      prompt: () => {
        throw new LobbyError(409, "session scratch is suspended — resume it before sending");
      },
    });
    const { commands, calls } = setup({ api });
    await expect(commands.launch(identity, launchInput("default"))).rejects.toThrow("suspended");
    expect(calls.filter((c) => c.op === "prompt")).toHaveLength(1);
  });

  it("sends a retried launch into the session it already started, not a new one", async () => {
    const api = fakeApi({ mode: () => ({ applied: true, mode: "bypassPermissions" }) });
    const { commands, calls, aliases } = setup({ api, draftListed: true });
    const result = await commands.launch(identity, {
      ...launchInput("default"),
      reuseExistingThread: true,
    });
    expect(calls.map((c) => c.op)).toEqual(["mode", "prompt"]);
    expect(aliases).toEqual([]);
    expect(result.threadId).toBe("scratch");
  });

  it("logs a launch and why it failed, never the first prompt's text", async () => {
    const api = fakeApi({ mode: () => ({ applied: false, reason: "unavailable" }) });
    const { commands, logs } = setup({ api });
    await expect(
      commands.launch(identity, launchInput("default", "approval-required")),
    ).rejects.toThrow("first message was not sent");
    expect(logs.filter((l) => l.startsWith("wizard: launch"))).toEqual([
      "wizard: launch t3-draft in project:lobby",
      "wizard: launch t3-draft failed: The new session could not be put in manual mode (unavailable), so the first message was not sent.",
    ]);
    expect(logs.some((l) => l.includes("plan it"))).toBe(false);
  });
});
