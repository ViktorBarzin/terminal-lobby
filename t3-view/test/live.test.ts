import { afterEach, describe, expect, it } from "vitest";

import { LobbyApi } from "../src/lobby/api.ts";
import { SequenceClock } from "../src/sequence.ts";
import { LiveThread } from "../src/threads/live.ts";
import { modeFromPane } from "../src/threads/modes.ts";
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

async function open(pane: string | undefined): Promise<LiveThread> {
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

describe("modeFromPane", () => {
  it("reads the newest status line in the pane", () => {
    expect(modeFromPane("⏵⏵ bypass permissions on\n...\n⏸ manual mode on")).toBe("manual");
    expect(modeFromPane("⏵⏵ don't ask on (shift+tab to cycle)")).toBe("dontAsk");
    expect(modeFromPane("nothing here")).toBe("");
  });
});
