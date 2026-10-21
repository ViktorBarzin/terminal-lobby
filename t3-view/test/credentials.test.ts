/**
 * Which credential a shared upstream stream runs under (hub.ts): every
 * client of a (user, session) shares one stream, so one client leaving or
 * being revoked must move it, never end the others' view.
 */
import { afterEach, describe, expect, it } from "vitest";

import { type Identity, type RelayCredentials, relayKey } from "../src/auth.ts";
import { Hub } from "../src/hub.ts";
import { LobbyApi } from "../src/lobby/api.ts";
import { SequenceClock } from "../src/sequence.ts";
import { PendingDispatches } from "../src/threads/pending.ts";
import { BORN_AS, type FakeLobby, startFakeLobby } from "./helpers/fakeLobby.ts";

const BROWSER: RelayCredentials = { header: "X-Authentik-Username", identity: "viktor", secret: "s3cret" };
const PHONE: RelayCredentials = { bearer: "tld1_phone" };
const LAPTOP: RelayCredentials = { bearer: "tld1_laptop" };
const as = (relay: RelayCredentials): Identity => ({ osUser: "wizard", authentik: "viktor", relay });

let lobby: FakeLobby | undefined;
let hub: Hub | undefined;

afterEach(async () => {
  hub?.dispose();
  await lobby?.close();
  hub = undefined;
  lobby = undefined;
});

async function setup() {
  lobby = await startFakeLobby({
    identity: "viktor",
    secret: "s3cret",
    fixture: "01-open-first-turn.sse",
    bearers: new Set(["tld1_phone", "tld1_laptop"]),
  });
  const api = new LobbyApi({ tmuxApiUrl: lobby.url, sessionEventsUrl: lobby.url });
  hub = new Hub({
    api,
    clock: new SequenceClock(1_791_800_000_000),
    pending: new PendingDispatches(),
    startedAt: "2026-10-12T08:00:00.000Z",
  });
  return { lobby, hub };
}

const lastAuth = () => lobby?.streams.at(-1)?.auth;

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("shared stream credentials", () => {
  it("opens under the newest held credential", async () => {
    const { hub } = await setup();
    const user = hub.user(as(BROWSER));
    user.hold(BROWSER);
    user.hold(PHONE);
    const live = await user.thread(BORN_AS, PHONE);
    await live?.ready();
    expect(lastAuth()).toBe("bearer:tld1_phone");
    expect(live?.streamKey).toBe(relayKey(PHONE));
  });

  it("moves the stream when the client it runs under closes, and keeps the others' view", async () => {
    const { hub, lobby } = await setup();
    const user = hub.user(as(BROWSER));
    user.hold(BROWSER);
    const releasePhone = user.hold(PHONE);
    const live = await user.thread(BORN_AS, PHONE);
    await live?.ready();
    const opened = lobby.streams.length;
    releasePhone();
    await until(() => lobby.streams.length > opened);
    expect(lastAuth()).toBe("proxy:viktor");
    expect(lobby.streams.at(-1)?.path).toContain("lastEventId=");
  });

  it("leaves the stream alone when a client it does not run under closes", async () => {
    const { hub, lobby } = await setup();
    const user = hub.user(as(BROWSER));
    const releaseBrowser = user.hold(BROWSER);
    user.hold(PHONE);
    const live = await user.thread(BORN_AS, PHONE);
    await live?.ready();
    const opened = lobby.streams.length;
    releaseBrowser();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lobby.streams.length).toBe(opened);
  });

  it("keeps the stream when the last client closes: it idles out on its own", async () => {
    const { hub, lobby } = await setup();
    const user = hub.user(as(PHONE));
    const release = user.hold(PHONE);
    const live = await user.thread(BORN_AS, PHONE);
    await live?.ready();
    const opened = lobby.streams.length;
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lobby.streams.length).toBe(opened);
    expect(live?.streamKey).toBe(relayKey(PHONE));
  });

  it("moves a revoked credential's stream to another client, or closes it when none is left", async () => {
    const { hub, lobby } = await setup();
    const user = hub.user(as(LAPTOP));
    user.hold(LAPTOP);
    user.hold(PHONE);
    const live = await user.thread(BORN_AS, PHONE);
    await live?.ready();
    hub.revoke(relayKey(PHONE));
    await until(() => lastAuth() === "bearer:tld1_laptop");
    expect(user.credential()?.key).toBe(relayKey(LAPTOP));

    const opened = lobby.streams.length;
    hub.revoke(relayKey(LAPTOP));
    await until(() => live?.streamKey === undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lobby.streams.length).toBe(opened);
    expect(user.credential()).toBeUndefined();

    // A client arriving brings the stream back, under its own credential.
    user.hold(BROWSER);
    await until(() => lastAuth() === "proxy:viktor");
  });
});
