/**
 * tl-t3-view: serves T3 Code's web client against lobby sessions.
 * Configuration is environment variables only (config.ts); README.md has the
 * full contract.
 */
import { hostname } from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProxyAuthGate } from "./auth.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { environmentDescriptor, environmentIdFor } from "./descriptor.ts";
import { SequenceClock } from "./sequence.ts";
import { sidecarLayer } from "./server.ts";
import { placeholderShell } from "./shell.ts";
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

  process.stderr.write(
    `tl-t3-view: identity header ${config.authHeader}, tmux-api ${config.tmuxApiUrl}, ` +
      `web ${config.webDir}, sequences from ${clock.base}\n`,
  );

  NodeRuntime.runMain(
    Layer.launch(
      sidecarLayer(
        {
          gate,
          webDir: config.webDir,
          config: { descriptor, cwd: "/", startedAt },
          clock,
          shell: (identity) =>
            Effect.sync(() =>
              placeholderShell({
                osUser: identity.osUser,
                snapshotSequence: clock.current(),
                startedAt,
              }),
            ),
        },
        { host: config.bind, port: config.port },
      ),
    ),
  );
}

start();
