/**
 * tl-t3-view: serves T3 Code's web client against lobby sessions.
 * Configuration is environment variables only (config.ts); README.md has the
 * full contract.
 */
import { hostname } from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Layer from "effect/Layer";

import { join } from "node:path";

import { ProxyAuthGate } from "./auth.ts";
import { Commands } from "./commands/dispatch.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { environmentDescriptor, environmentIdFor } from "./descriptor.ts";
import { Hub } from "./hub.ts";
import { LobbyApi } from "./lobby/api.ts";
import { LOBBY_CLAUDE_MODELS } from "./models.ts";
import { SequenceClock } from "./sequence.ts";
import { sidecarLayer } from "./server.ts";
import { ThreadAliases } from "./shell/aliases.ts";
import { PendingDispatches } from "./threads/pending.ts";
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
  const gate = new ProxyAuthGate({
    authHeader: config.authHeader,
    whoami: tmuxApiWhoami(config.tmuxApiUrl),
  });

  const log = (message: string) => process.stderr.write(`tl-t3-view: ${message}\n`);
  const state = (name: string) =>
    config.stateDir === undefined ? undefined : join(config.stateDir, name);
  const api = new LobbyApi({
    tmuxApiUrl: config.tmuxApiUrl,
    sessionEventsUrl: config.sessionEventsUrl,
  });
  const pendingFile = state("pending.json");
  const pending = new PendingDispatches(pendingFile === undefined ? {} : { file: pendingFile });
  const aliases = new ThreadAliases(state("aliases.json"));
  const hub = new Hub({ api, clock, pending, aliases, startedAt, log });
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
    knownModels: new Set(LOBBY_CLAUDE_MODELS.map((m) => m.slug)),
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
