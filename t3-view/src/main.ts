/**
 * tl-t3-view: serves T3 Code's web client against lobby sessions.
 * Configuration is environment variables only (config.ts); README.md has the
 * full contract.
 */
import { hostname } from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Layer from "effect/Layer";

import { join } from "node:path";

import { BearerAuthGate, isBearerRelay, ProxyAuthGate } from "./auth.ts";
import { Commands } from "./commands/dispatch.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { environmentDescriptor, environmentIdFor } from "./descriptor.ts";
import { Hub } from "./hub.ts";
import { LobbyApi } from "./lobby/api.ts";
import { LOBBY_CLAUDE_SLUGS } from "./models.ts";
import { tmuxApiExchange } from "./pairing.ts";
import { BearerWatch } from "./revocation.ts";
import { SequenceClock } from "./sequence.ts";
import { sidecarLayer } from "./server.ts";
import { ThreadAliases } from "./shell/aliases.ts";
import { HeldPrompts } from "./threads/held.ts";
import { PendingDispatches } from "./threads/pending.ts";
import { WsTickets } from "./tickets.ts";
import { tmuxApiWhoami } from "./whoami.ts";

function start(): void {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env, hostname());
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`tl-t3-view: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const clock = new SequenceClock(startedAtMs);
  const descriptor = environmentDescriptor({
    environmentId: environmentIdFor(hostname()),
    label: config.environmentLabel,
  });
  const whoami = tmuxApiWhoami(config.tmuxApiUrl);
  const gate = new ProxyAuthGate({ authHeader: config.authHeader, whoami });
  const bearer = new BearerAuthGate({ whoami });

  const log = (message: string) => process.stderr.write(`tl-t3-view: ${message}\n`);
  const state = (name: string) =>
    config.stateDir === undefined ? undefined : join(config.stateDir, name);
  // A revoked device's sockets close, and the hub moves the streams they
  // shared to another client's credential (revocation.ts, hub.ts).
  const watch = new BearerWatch({ gate: bearer, onRevoked: (key) => hub.revoke(key), log });
  const api = new LobbyApi({
    tmuxApiUrl: config.tmuxApiUrl,
    sessionEventsUrl: config.sessionEventsUrl,
    // A 401 on a call made with a device's bearer: check that device now.
    onUnauthorized: (relay) => {
      if (isBearerRelay(relay)) void watch.suspect(relay.bearer);
    },
  });
  const pendingFile = state("pending.json");
  const pending = new PendingDispatches(pendingFile === undefined ? {} : { file: pendingFile });
  const aliases = new ThreadAliases(state("aliases.json"));
  const held = new HeldPrompts(state("held.json"));
  const hub = new Hub({ api, clock, pending, aliases, held, startedAt, log });
  const commands = new Commands({
    api,
    pending,
    now: Date.now,
    thread: async (identity, threadId) => {
      const user = hub.user(identity);
      const live = await user.thread(threadId, identity.relay);
      const entry = user.entry(threadId);
      return live === undefined || entry === undefined ? undefined : { entry, live };
    },
    project: async (identity, projectId) => {
      const user = hub.user(identity);
      await user.refresh();
      return user.directory.project(projectId);
    },
    alias: (identity, minted, threadId) => aliases.set(identity.osUser, minted, threadId),
    knownModels: (identity) => new Set([...LOBBY_CLAUDE_SLUGS, ...hub.user(identity).liveModels]),
    log,
  });

  log(
    `identity header ${config.authHeader}, tmux-api ${config.tmuxApiUrl}, ` +
      `session-events ${config.sessionEventsUrl}, web ${config.webDir}, ` +
      `state ${config.stateDir ?? "(memory)"}, sequences from ${clock.base}`,
  );

  NodeRuntime.runMain(
    Layer.launch(
      sidecarLayer(
        {
          gate,
          bearer,
          tickets: new WsTickets(),
          watch,
          exchange: tmuxApiExchange(config.tmuxApiUrl),
          webDir: config.webDir,
          config: { descriptor, cwd: "/", startedAt },
          clock,
          hub,
          commands,
        },
        { host: config.bind, port: config.port },
      ),
    ),
  );
}

start();
