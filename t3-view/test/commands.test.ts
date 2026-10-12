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
  options: { access?: string; frames?: string[]; api?: ReturnType<typeof fakeApi> } = {},
) {
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
    thread: async (_identity, id) =>
      id === entry.threadId || id === "t3-draft" ? handle : undefined,
    project: async (_identity, id) => (id === project.id ? project : undefined),
    alias: (_identity, minted, threadId) => aliases.push([minted, threadId]),
    sleep: async () => {},
    mintName: () => "bw8k5gt9v314",
  });
  return { commands, calls, live, pending, aliases };
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
  });

  it("stops the turn and shows the request", async () => {
    const { commands, calls, live } = setup();
    runningFrames(live);
    const run = live.model.mapper.activeRun;
    await commands.dispatch(identity, {
      type: "run.interrupt",
      ...base,
      runId: run?.id ?? RunId.make("x"),
      holdQueue: true,
    });
    expect(calls).toEqual([
      { op: "cancel", args: ["running-echo-hi-with-bash-tool", undefined, false] },
    ]);
    expect(live.projection.turnItems.some((i) => i.type === "run_interrupt_request")).toBe(true);
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
      ["prompt", { text: "say hi", awaitReady: true, id: "c-launch" }],
      ["mode", "bypassPermissions"],
    ]);
    expect(pending.list(live.pendingKey).map((p) => p.messageId)).toEqual(["first-m"]);
    expect(result.threadId).toBe("scratch");
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
});
