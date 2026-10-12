/**
 * Recorded lobby streams of one scratch Haiku session, fed through the thread
 * model and checked at the level T3's own testkit checks its projections:
 * which runs exist, which item types they hold, and that every reference
 * resolves. The captures (test/fixtures/lobby) were taken with curl against
 * session-events on 2026-10-12; 02 to 05 are resumes of the same session, so
 * they are fed one after another into one model, as a reconnecting sidecar
 * would.
 */
import { MessageId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { SseFrame } from "../src/lobby/wire.ts";
import { SequenceClock } from "../src/sequence.ts";
import { ThreadModel } from "../src/threads/model.ts";
import { PendingDispatches } from "../src/threads/pending.ts";
import {
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  fixture,
  testThread,
  visibleTypes,
} from "./helpers/projection.ts";

const KEY = "wizard\u0000scratch";

function makeModel(pending = new PendingDispatches({ now: () => 1_791_794_200_000 })) {
  const clock = new SequenceClock(1_791_794_000_000);
  const model = new ThreadModel({
    threadId: testThread().id,
    thread: testThread(),
    clock,
    logCapacity: 1000,
    now: () => 1_791_794_200_000,
    messages: { take: (text) => pending.take(KEY, text) },
    eventPrefix: "test",
  });
  return { model, clock, pending };
}

function feed(model: ThreadModel, frames: ReadonlyArray<SseFrame>) {
  for (const frame of frames) {
    const outcome = model.onFrame(frame);
    expect(outcome.kind).toBe("events");
  }
}

const itemsOf = (model: ThreadModel, runOrdinal: number) => {
  const run = model.projection.runs.find((r) => r.ordinal === runOrdinal);
  return model.projection.turnItems.filter((item) => item.runId === run?.id);
};

const ofType = <T extends OrchestrationV2TurnItem["type"]>(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  type: T,
) => items.filter((i): i is Extract<OrchestrationV2TurnItem, { type: T }> => i.type === type);

describe("a reverse open of a finished first turn", () => {
  it("builds one completed run with the prompt, the Bash call and the reply", () => {
    const { model } = makeModel();
    feed(model, fixture("01-open-first-turn.sse"));
    const p = model.projection;
    expect(model.synced).toBe(true);
    expect(model.epoch).toBe("88a3b767c163e517");
    expect(model.lastEventId).toBe(17);
    expect(p.runs.map((r) => [r.ordinal, r.status])).toEqual([[1, "completed"]]);
    expect(visibleTypes(p)).toEqual(["user_message", "command_execution", "assistant_message"]);
    const [command] = ofType(p.turnItems, "command_execution");
    expect(command).toMatchObject({ input: "echo hi", output: "hi", status: "completed" });
    const [user] = ofType(p.turnItems, "user_message");
    expect(user?.text).toContain("echo hi");
    expect(p.messages.find((m) => m.id === user?.messageId)?.role).toBe("user");
    expect(p.thread.modelSelection.model).toBe("claude-haiku-5-5");
    expect(p.thread.runtimeMode).toBe("full-access");
    assertSemanticProjectionIntegrity(p);
  });
});

describe("a session followed across reconnects", () => {
  const replay = () => {
    const ctx = makeModel();
    feed(ctx.model, fixture("01-open-first-turn.sse"));
    return ctx;
  };

  it("shows the permission card while held and settles it when answered", () => {
    const { model } = replay();
    const frames = fixture("02-permission.sse");
    const askingAt = frames.findIndex((f) => f.data.includes('"meta":"asking"'));
    feed(model, frames.slice(0, askingAt + 1));
    const held = itemsOf(model, 2);
    const [approval] = ofType(held, "approval_request");
    expect(approval).toMatchObject({ status: "waiting", requestKind: "command" });
    expect(approval?.prompt).toContain("touch /tmp/t3view-probe-file");
    const request = model.projection.runtimeRequests.find((r) => r.id === approval?.requestId);
    expect(request).toMatchObject({
      status: "pending",
      kind: "command",
      responseCapability: { type: "live" },
    });
    expect(model.mapper.openDialogs.map((d) => [d.kind, d.toolId])).toEqual([
      ["permission", "toolu_01LNxqGL65zRa7tULyGynHs5"],
    ]);

    feed(model, frames.slice(askingAt + 1));
    const done = itemsOf(model, 2);
    expect(ofType(done, "approval_request")[0]?.status).toBe("completed");
    expect(model.projection.runtimeRequests[0]?.status).toBe("resolved");
    expect(model.mapper.openDialogs).toEqual([]);
    // The streamed reply and its stored row are one item.
    const replies = ofType(done, "assistant_message");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ streaming: false, status: "completed" });
    expect(replies[0]?.text).toContain("now exists");
    assertSemanticProjectionIntegrity(model.projection);
  });

  it("keeps a streamed reply's item id when the stored row lands", () => {
    const { model } = replay();
    const frames = fixture("02-permission.sse");
    const firstDelta = frames.findIndex((f) => f.data.includes('"kind":"delta"'));
    feed(model, frames.slice(0, firstDelta + 1));
    const streaming = ofType(itemsOf(model, 2), "assistant_message");
    expect(streaming).toHaveLength(1);
    expect(streaming[0]).toMatchObject({ streaming: true, status: "running", text: "Done." });
    feed(model, frames.slice(firstDelta + 1));
    const stored = ofType(itemsOf(model, 2), "assistant_message");
    expect(stored.map((i) => i.id)).toEqual(streaming.map((i) => i.id));
  });

  it("shows a held question as a user input request keyed by the question", () => {
    const { model } = replay();
    feed(model, fixture("02-permission.sse"));
    const frames = fixture("03-question.sse");
    const heldAt = frames.findIndex((f) => f.data.includes('"meta":"held"'));
    feed(model, frames.slice(0, heldAt + 1));
    const [ask] = ofType(itemsOf(model, 3), "user_input_request");
    expect(ask?.status).toBe("waiting");
    expect(ask?.questions).toEqual([
      {
        id: "Which colour do you prefer?",
        header: "Colour",
        question: "Which colour do you prefer?",
        options: [
          { label: "Red", description: "Red" },
          { label: "Blue", description: "Blue" },
        ],
        allowCustomAnswer: true,
      },
    ]);
    expect(model.mapper.openDialogs[0]).toMatchObject({
      kind: "ask",
      toolId: "toolu_01VdjTrNDPQuz3TuCz7XUinB",
    });
    feed(model, frames.slice(heldAt + 1));
    expect(ofType(itemsOf(model, 3), "user_input_request")[0]?.status).toBe("completed");
    expect(itemsOf(model, 3).map((i) => i.type)).toEqual([
      "user_message",
      "dynamic_tool",
      "user_input_request",
      "assistant_message",
    ]);
  });

  it("delivers a mid-turn prompt as a steer in the running run, with the sender's message id", () => {
    const { model, pending } = replay();
    feed(model, fixture("02-permission.sse"));
    feed(model, fixture("03-question.sse"));
    pending.add(KEY, {
      messageId: MessageId.make("client-banana"),
      text: "Also mention the word banana in your reply.",
      at: 1_791_794_100_000,
    });
    const frames = fixture("04-steer.sse");
    const queuedAt = frames.findIndex((f) => f.data.includes('"meta":"queued"'));
    feed(model, frames.slice(0, queuedAt + 1));
    const queued = model.mapper.queuedRuns;
    expect(queued.map((q) => [q.run.status, q.run.queuePosition, q.run.userMessageId])).toEqual([
      ["queued", 1, "client-banana"],
    ]);
    // The client's optimistic row is acknowledged as soon as it is queued.
    expect(model.projection.messages.some((m) => m.id === "client-banana")).toBe(true);

    feed(model, frames.slice(queuedAt + 1));
    expect(model.mapper.queuedRuns).toEqual([]);
    const steered = itemsOf(model, 4);
    expect(ofType(steered, "user_message").map((u) => [u.inputIntent, u.messageId])).toEqual([
      ["turn_start", expect.stringMatching(/^message:/)],
      ["steer", "client-banana"],
    ]);
    expect(ofType(steered, "command_execution")).toHaveLength(2);
    expect(model.projection.runs.map((r) => [r.ordinal, r.status])).toEqual([
      [1, "completed"],
      [2, "completed"],
      [3, "completed"],
      [4, "completed"],
      [5, "cancelled"],
    ]);
    // A cancelled queued run never shows as a row.
    expect(visibleTypes(model.projection).filter((t) => t === "user_message")).toHaveLength(5);
    assertSemanticProjectionIntegrity(model.projection);
  });

  it("keeps the whole session consistent through all five captures", () => {
    const { model } = replay();
    for (const name of [
      "02-permission.sse",
      "03-question.sse",
      "04-steer.sse",
      "05-steer-at-stop.sse",
    ]) {
      feed(model, fixture(name));
    }
    assertSemanticProjectionIntegrity(model.projection);
    assertTurnItemTypes(model.projection, [
      "user_message",
      "command_execution",
      "assistant_message",
      "approval_request",
      "user_input_request",
      "dynamic_tool",
    ]);
    expect(model.mapper.activeRun).toBeUndefined();
    expect(model.lastEventId).toBe(48);
    const failed = ofType(model.projection.turnItems, "command_execution").filter(
      (i) => i.status === "failed",
    );
    expect(failed).toHaveLength(1);
  });
});

describe("a reply stored after its turn ended", () => {
  it("joins the turn it belongs to instead of opening a run of its own", () => {
    // A launched session: the mod's turn_end (id 9) landed before Claude's
    // stored reply (id 10), and the next prompt (id 12) is a run of its own.
    const { model } = makeModel();
    feed(model, fixture("06-reply-after-turn-end.sse"));
    expect(model.projection.runs.map((r) => [r.ordinal, r.status])).toEqual([
      [1, "completed"],
      [2, "completed"],
    ]);
    expect(model.mapper.activeRun).toBeUndefined();
    const first = model.projection.runs[0];
    expect(
      model.projection.turnItems.filter((i) => i.runId === first?.id).map((i) => i.type),
    ).toEqual(["user_message", "assistant_message"]);
    assertSemanticProjectionIntegrity(model.projection);
  });
});

describe("a streamed reply whose turn_end lands before its stored text", () => {
  const event = (o: Record<string, unknown>) => ({
    event: "message",
    data: JSON.stringify({ session: "s", ...o }),
  });

  it("keeps the streamed row and gives it the stored text, instead of drawing the reply twice", () => {
    const { model } = makeModel();
    feed(model, fixture("01-open-first-turn.sse"));
    model.onFrame(event({ id: 50, kind: "user", turnId: "t2", body: "say hi" }));
    model.onFrame(
      event({ id: 0, kind: "delta", turnId: "t2", stream: "text", block: 0, body: "Hi" }),
    );
    model.onFrame(
      event({ id: 0, kind: "delta", turnId: "t2", stream: "text", block: 0, body: " there" }),
    );
    const streamed = ofType(model.projection.turnItems, "assistant_message").at(-1);
    model.onFrame(event({ id: 51, kind: "turn_end", turnId: "t2" }));
    model.onFrame(event({ id: 52, kind: "text", turnId: "t2", body: "Hi there" }));
    const run = model.projection.runs.at(-1);
    const items = model.projection.turnItems.filter((i) => i.runId === run?.id);
    expect(items.map((i) => i.type)).toEqual(["user_message", "assistant_message"]);
    const [reply] = ofType(items, "assistant_message");
    expect(reply).toMatchObject({ id: streamed?.id, text: "Hi there", streaming: false });
    expect(visibleTypes(model.projection).slice(-2)).toEqual(["user_message", "assistant_message"]);
    assertSemanticProjectionIntegrity(model.projection);
  });

  it("does not hand a settled row of one turn to the next turn's reply", () => {
    const { model } = makeModel();
    feed(model, fixture("01-open-first-turn.sse"));
    model.onFrame(event({ id: 50, kind: "user", turnId: "t2", body: "one" }));
    model.onFrame(
      event({ id: 0, kind: "delta", turnId: "t2", stream: "text", block: 0, body: "A" }),
    );
    model.onFrame(event({ id: 51, kind: "turn_end", turnId: "t2" }));
    model.onFrame(event({ id: 52, kind: "user", turnId: "t3", body: "two" }));
    model.onFrame(event({ id: 53, kind: "text", turnId: "t3", body: "B" }));
    model.onFrame(event({ id: 54, kind: "turn_end", turnId: "t3" }));
    const [second, third] = model.projection.runs.slice(-2);
    const textsOf = (runId: string | undefined) =>
      ofType(
        model.projection.turnItems.filter((i) => i.runId === runId),
        "assistant_message",
      ).map((i) => i.text);
    expect(textsOf(second?.id)).toEqual(["A"]);
    expect(textsOf(third?.id)).toEqual(["B"]);
  });
});

describe("stops and wakes", () => {
  const event = (o: Record<string, unknown>) => ({
    event: "message",
    data: JSON.stringify({ session: "s", ...o }),
  });

  it("ends a stopped run as interrupted when the mod's clean turn_end follows a T3 Stop", () => {
    const { model } = makeModel();
    feed(model, fixture("01-open-first-turn.sse"));
    model.onFrame(event({ id: 50, kind: "user", turnId: "t2", body: "long job" }));
    model.commit(model.mapper.interruptRequested());
    model.onFrame(event({ id: 51, kind: "turn_end", turnId: "t2" }));
    const run = model.projection.runs.at(-1);
    expect(run?.status).toBe("interrupted");
    expect(
      model.projection.turnItems.filter((i) => i.runId === run?.id).map((i) => i.type),
    ).toEqual(["user_message", "run_interrupt_request", "run_interrupt_result"]);
  });

  it("shows a background job's report once, as the notification that opens Claude's answer", () => {
    const { model } = makeModel();
    feed(model, fixture("01-open-first-turn.sse"));
    const note =
      '<task-notification>\n<task-id>b1</task-id>\n<summary>Background command "loop" completed (exit code 0)</summary>\n</task-notification>';
    model.onFrame(event({ id: 60, kind: "meta", meta: "queued", turnId: "t1", body: note }));
    model.onFrame(event({ id: 61, kind: "meta", meta: "unqueued", turnId: "t1", body: note }));
    model.onFrame(
      event({
        id: 62,
        kind: "state",
        turnId: "t1",
        body: 'Background command "loop" completed (exit code 0)',
      }),
    );
    model.onFrame(event({ id: 63, kind: "text", turnId: "t2", body: "The loop finished." }));
    model.onFrame(event({ id: 64, kind: "turn_end", turnId: "t2" }));
    const run = model.projection.runs.at(-1);
    const items = model.projection.turnItems.filter((i) => i.runId === run?.id);
    expect(items.map((i) => i.type)).toEqual(["notification", "assistant_message"]);
    expect(model.projection.turnItems.some((i) => i.type === "system_notice")).toBe(false);
    assertSemanticProjectionIntegrity(model.projection);
  });
});

describe("rebuilds and replays", () => {
  it("asks for a rebuild when ready names another log", () => {
    const { model } = makeModel();
    feed(model, fixture("01-open-first-turn.sse"));
    expect(model.onFrame({ event: "ready", data: '{"head":3,"epoch":"other"}' })).toEqual({
      kind: "rebuild",
    });
  });

  it("skips stored events it has already applied", () => {
    const { model } = makeModel();
    const frames = fixture("01-open-first-turn.sse");
    feed(model, frames);
    const before = model.projection;
    const again = model.onFrame({
      event: "message",
      data: '{"id":15,"kind":"text","session":"s","turnId":"t1","body":"dup"}',
    });
    expect(again).toEqual({ kind: "events", events: [] });
    expect(model.projection).toBe(before);
  });

  it("puts every committed event in the log in sequence order", () => {
    const { model } = makeModel();
    feed(model, fixture("01-open-first-turn.sse"));
    const resumed = model.log.resume(model.log.floor);
    expect(resumed.kind).toBe("replay");
    if (resumed.kind !== "replay") return;
    const sequences = resumed.events.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(sequences.at(-1)).toBe(model.snapshotSequence);
  });

  it("shows a session whose Claude exited as one notice, once, and a starting one as none", () => {
    const { model } = makeModel();
    model.onFrame({ event: "starting", data: '{"waitS":30}' });
    model.onFrame({ event: "nomod", data: '{"claude":"exited"}' });
    model.onFrame({ event: "nomod", data: '{"claude":"exited"}' });
    feed(model, fixture("01-open-first-turn.sse"));
    const notices = ofType(model.projection.turnItems, "system_notice");
    expect(notices.map((n) => n.message)).toEqual([
      "This session's Claude is not running. Open it in the lobby to start it again.",
    ]);
  });
});

describe("the model and effort pickers", () => {
  it("draws /model and /effort as notices on the run before, not as prompts or runs", () => {
    const { model } = makeModel();
    for (const frame of fixture("07-model-and-effort-pickers.sse")) model.onFrame(frame);
    const p = model.projection;
    expect(p.runs.map((r) => [r.ordinal, r.status])).toEqual([
      [1, "completed"],
      [2, "completed"],
    ]);
    const users = ofType(p.turnItems, "user_message").map((u) => u.text);
    expect(users).not.toContain("/model");
    expect(users).not.toContain("/effort");
    expect(ofType(itemsOf(model, 1), "system_notice").map((n) => n.message)).toEqual([
      "Set model to `claude-sonnet-5` for this session only",
      "Set effort level to high (this session only): Comprehensive implementation with extensive testing and documentation",
    ]);
    expect(p.thread.modelSelection.model).toBe("claude-sonnet-5");
    assertSemanticProjectionIntegrity(p);
  });
});
