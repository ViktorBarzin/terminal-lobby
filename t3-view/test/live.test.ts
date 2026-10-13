import { MessageId, RunId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { LobbyApi } from "../src/lobby/api.ts";
import { SequenceClock } from "../src/sequence.ts";
import { HeldPrompts } from "../src/threads/held.ts";
import { LiveThread } from "../src/threads/live.ts";
import { effortFromPane, modeFromPane } from "../src/threads/modes.ts";
import { PendingDispatches } from "../src/threads/pending.ts";
import { type FakeLobby, SESSION_NAME, startFakeLobby } from "./helpers/fakeLobby.ts";
import { testThread } from "./helpers/projection.ts";

const relay = { header: "X-Authentik-Username", identity: "viktor", secret: "s" };

let lobby: FakeLobby | undefined;
let live: LiveThread | undefined;

afterEach(async () => {
  live?.dispose();
  await lobby?.close();
  live = undefined;
  lobby = undefined;
});

async function open(pane: string | undefined, held?: HeldPrompts): Promise<LiveThread> {
  lobby = await startFakeLobby({
    identity: relay.identity,
    secret: relay.secret,
    fixture: "01-open-first-turn.sse",
    ...(pane === undefined ? {} : { pane }),
  });
  const api = new LobbyApi({ tmuxApiUrl: lobby.url, sessionEventsUrl: lobby.url });
  live = new LiveThread({
    osUser: "wizard",
    threadId: testThread().id,
    thread: { ...testThread(), runtimeMode: "approval-required" },
    api,
    clock: new SequenceClock(1_791_794_000_000),
    pending: new PendingDispatches({ now: () => 1_791_794_200_000 }),
    locate: async () => ({ name: SESSION_NAME }),
    ...(held === undefined ? {} : { held }),
  });
  live.attach(relay);
  await live.ready(5_000);
  return live;
}

describe("LiveThread mode at ready", () => {
  // The fixture's state frame says bypassPermissions; the pane is the live answer.
  it("takes the mode from the pane's status line over the state frame's", async () => {
    const thread = await open(
      "  Done.\n\n> \n  ⏸ manual mode on (shift+tab to cycle)                    ◯ claude-haiku-5-5\n",
    );
    expect(thread.projection.thread.runtimeMode).toBe("approval-required");
    expect(thread.projection.thread.interactionMode).toBe("default");
  });

  it("shows plan mode the pane reports", async () => {
    const thread = await open("> \n  ⏸ plan mode on (shift+tab to cycle)\n");
    expect(thread.projection.thread.interactionMode).toBe("plan");
  });

  it("keeps the stream's mode when the pane cannot be read or names none", async () => {
    expect((await open(undefined)).projection.thread.runtimeMode).toBe("full-access");
    live?.dispose();
    await lobby?.close();
    expect((await open("> \n")).projection.thread.runtimeMode).toBe("full-access");
  });
});

describe("LiveThread effort from the pane", () => {
  const effortOf = (thread: LiveThread) =>
    thread.projection.thread.modelSelection.options?.find((o) => o.id === "effort")?.value;

  // The state frame names no effort for a session nobody changed it in, which
  // left T3 showing its default (Medium) for a session on high.
  it("takes the effort from the hint above the input", async () => {
    const thread = await open(
      "> \n                                        ● max · /effort\n  ⏸ manual mode on (shift+tab to cycle)\n",
    );
    expect(effortOf(thread)).toBe("max");
  });

  it("keeps the stream's effort when the pane names none", async () => {
    const thread = await open("> \n  ⏸ manual mode on (shift+tab to cycle)\n");
    expect(effortOf(thread)).toBe("high");
  });
});

describe("LiveThread mode at a turn's start and end", () => {
  // A mode chosen on the pane (a plan-exit menu, a Shift+Tab in the Terminal)
  // reaches no transcript event, so the pane is read again as a turn starts
  // and ends, as the Solid view does.
  const frame = (body: Record<string, unknown>) =>
    `event: message\ndata: ${JSON.stringify({ session: SESSION_NAME, at: 1_791_794_300_000, ...body })}\n\n`;
  const settle = async (thread: LiveThread, mode: string) => {
    for (let i = 0; i < 50 && thread.projection.thread.runtimeMode !== mode; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("reads the pane again when a turn ends", async () => {
    const thread = await open("> \n  ⏸ plan mode on (shift+tab to cycle)\n");
    expect(thread.projection.thread.interactionMode).toBe("plan");
    lobby?.setPane("> \n  ⏸ manual mode on (shift+tab to cycle)\n");
    lobby?.push(frame({ id: 30, kind: "turn_end", turnId: "t1" }));
    await settle(thread, "approval-required");
    expect(thread.projection.thread.interactionMode).toBe("default");
    expect(thread.projection.thread.runtimeMode).toBe("approval-required");
  });

  it("reads the pane again when a turn starts", async () => {
    const thread = await open("> \n  ⏸ manual mode on (shift+tab to cycle)\n");
    lobby?.setPane("> \n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n");
    lobby?.push(frame({ id: 30, kind: "user", turnId: "t2", body: "next" }));
    await settle(thread, "full-access");
    expect(thread.projection.thread.runtimeMode).toBe("full-access");
  });
});

describe("LiveThread held prompts", () => {
  const heldRuns = (thread: LiveThread) =>
    thread.projection.runs
      .filter((r) => r.status === "queued")
      .map((r) => [r.queueHeld, r.userMessageId]);

  it("brings back prompts a Stop held before the sidecar restarted", async () => {
    const held = new HeldPrompts();
    held.set("wizard", testThread().id, [
      { messageId: MessageId.make("client-m7"), text: "later please" },
    ]);
    const thread = await open(undefined, held);
    expect(heldRuns(thread)).toEqual([[true, "client-m7"]]);
    expect(thread.model.mapper.heldRuns.map((r) => r.text)).toEqual(["later please"]);
  });

  it("writes the held set back as it changes", async () => {
    const held = new HeldPrompts();
    held.set("wizard", testThread().id, [
      { messageId: MessageId.make("client-m7"), text: "later please" },
    ]);
    const thread = await open(undefined, held);
    const [run] = thread.model.mapper.heldRuns;
    thread.commit(thread.model.mapper.cancelHeld(run?.runId ?? RunId.make("none")));
    expect(held.get("wizard", testThread().id)).toEqual([]);
  });
});

describe("modeFromPane", () => {
  it("reads the newest status line in the pane", () => {
    expect(modeFromPane("⏵⏵ bypass permissions on\n...\n⏸ manual mode on")).toBe("manual");
    expect(modeFromPane("⏵⏵ don't ask on (shift+tab to cycle)")).toBe("dontAsk");
    expect(modeFromPane("nothing here")).toBe("");
  });
});

describe("effortFromPane", () => {
  it("reads the hint above the input", () => {
    expect(effortFromPane("❯ \n                                   ● high · /effort\n")).toBe("high");
    expect(effortFromPane("  ◐ xhigh · /effort")).toBe("xhigh");
  });

  it("reads the spinner while a turn runs", () => {
    expect(
      effortFromPane("✢ Combobulating… (5m 23s · ↓ 17.8k tokens · thinking with high effort)"),
    ).toBe("high");
  });

  it("takes the newest reading in the pane", () => {
    expect(effortFromPane("  ● low · /effort\n...\n✻ Working (thinking with max effort)")).toBe(
      "max",
    );
  });

  it("ignores the welcome banner, a picker's ruler and models without effort", () => {
    expect(effortFromPane("▝▜██████▀  claude-opus-5-5 with high effort · Claude API")).toBe("");
    expect(effortFromPane("▔▔▔▔▔▔▔▔ ● high · /effort ▔")).toBe("");
    expect(effortFromPane("   ○ Effort not supported for claude-haiku-4-5-20251001")).toBe("");
    expect(effortFromPane("  ● ultracode · /effort")).toBe("");
  });
});
