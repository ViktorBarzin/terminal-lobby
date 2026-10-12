/**
 * The WsRpcGroup handlers for one WebSocket connection.
 *
 * Real handlers cover what the web client needs to boot and to sit on a page:
 * config, lifecycle, probe, the shell, and the RPCs the stage 1 trace saw it
 * call unprompted, each answered with an honest empty value (no previews, no
 * VCS, no scheduled tasks). Everything else falls through to STUB_HANDLERS.
 *
 * Extension points for the next stages:
 * - Read path (stage 3): `ConnectionContext.lobby` grows the user's projects
 *   and sessions; subscribeShell and subscribeThread take their snapshots and
 *   live events from it, with sequences from `clock`.
 * - Commands (stage 4): orchestration.dispatchCommand and launchThread branch
 *   on the command type below and call session-events / tmux-api with
 *   `identity.relay` on every request.
 */
import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  ProjectReadFileError,
  type ServerConfigStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Identity } from "../auth.ts";
import type { SequenceClock } from "../sequence.ts";
import {
  type ConfigContext,
  claudeProvider,
  lifecycleEvents,
  serverConfig,
} from "../serverConfig.ts";
import { SHELL_SCHEMA_VERSION } from "../shell.ts";
import { STUB_HANDLERS, unavailable } from "./stubs.ts";

export interface ConnectionContext {
  readonly identity: Identity;
  readonly config: ConfigContext;
  readonly clock: SequenceClock;
  /** The user's shell at the clock's current sequence. */
  readonly shell: (identity: Identity) => Effect.Effect<OrchestrationV2ShellSnapshot>;
}

/** A finite prefix, then a subscription that stays open until the client ends it. */
const thenStayOpen = <A>(items: ReadonlyArray<A>): Stream.Stream<A> =>
  Stream.concat(Stream.fromIterable(items), Stream.never);

export const MISSING_FAVICON_URL = "/api/assets/project-favicon-missing";
const FAR_FUTURE_MS = Date.UTC(2100, 0, 1);

/** The id under which this process's preview state would reset; there is none. */
const PREVIEW_EPOCH = "tl-t3-view";

export function makeHandlers(context: ConnectionContext) {
  const config = () => serverConfig(context.config);

  return WsRpcGroup.of({
    ...STUB_HANDLERS,

    [WS_METHODS.serverProbe]: () => Effect.succeed({}),
    [WS_METHODS.serverGetConfig]: () => Effect.sync(config),
    [WS_METHODS.serverRefreshProviders]: () =>
      Effect.sync(() => ({ providers: [claudeProvider(context.config.startedAt)] })),

    [WS_METHODS.subscribeServerConfig]: (input) => {
      const events: ServerConfigStreamEvent[] = [
        { version: 1, type: "snapshot", config: config() },
      ];
      if (input.usageLimitSources === true) {
        events.push({ version: 1, type: "usageLimitSourcesUpdated", payload: { sources: [] } });
      }
      if (input.environmentThemes === true) {
        events.push({ version: 1, type: "environmentThemesUpdated", payload: { themes: [] } });
      }
      return thenStayOpen(events);
    },
    [WS_METHODS.subscribeServerLifecycle]: () => thenStayOpen(lifecycleEvents(context.config)),

    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
      Stream.unwrap(
        Effect.map(context.shell(context.identity), (snapshot) => {
          // Stage 2 keeps no shell events, so every resume that is not
          // already current is answered with the snapshot.
          const items: OrchestrationV2ShellStreamItem[] =
            input.afterSequence === snapshot.snapshotSequence
              ? []
              : [{ kind: "snapshot", snapshot }];
          if (input.requestCompletionMarker === true) {
            items.push({ kind: "synchronized" });
          }
          return thenStayOpen(items);
        }),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: () =>
      Effect.map(context.shell(context.identity), (snapshot) => ({
        schemaVersion: SHELL_SCHEMA_VERSION,
        snapshotSequence: snapshot.snapshotSequence,
        projects: snapshot.projects,
        threads: [],
      })),
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command, options) =>
      command.type === "thread.visit"
        ? Effect.sync(() => ({ sequence: context.clock.current() }))
        : unavailable(command, { rpc: { _tag: `${options.rpc._tag} ${command.type}` } }),

    // Called unprompted by the web client; each has nothing to report here.
    [WS_METHODS.previewReportProfiles]: () => Effect.void,
    [WS_METHODS.serverReportClientActivity]: () => Effect.void,
    [WS_METHODS.subscribeProjectClones]: () => thenStayOpen([[]]),
    [WS_METHODS.scheduledTasksSubscribe]: () => thenStayOpen([{ tasks: [] }]),
    [WS_METHODS.subscribeVcsStatus]: () =>
      thenStayOpen([
        {
          _tag: "snapshot" as const,
          local: {
            isRepo: false,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          },
          remote: null,
        },
      ]),
    [WS_METHODS.vcsListRefs]: () =>
      Effect.succeed({
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      }),
    [WS_METHODS.serverDiscoverSourceControl]: () =>
      Effect.succeed({ versionControlSystems: [], sourceControlProviders: [] }),
    [WS_METHODS.previewList]: () =>
      Effect.succeed({ sessions: [], serverEpoch: PREVIEW_EPOCH, revision: 0 }),
    [WS_METHODS.filesystemGetMetadata]: (input) =>
      Effect.succeed({ entries: input.paths.map(() => null) }),
    // The client reads an optional t3.json per project and treats this
    // failure as "no project config", as it does against T3's own server.
    [WS_METHODS.projectsReadFile]: (input) =>
      Effect.fail(
        new ProjectReadFileError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          failure: "operation_failed",
        }),
      ),
    // Projects have no icon here. The URL is one the sidecar answers 404, which
    // is what T3's own server answers for a project without a favicon.
    [WS_METHODS.assetsCreateUrl]: (input, options) =>
      input.resource._tag === "project-favicon"
        ? Effect.succeed({ relativeUrl: MISSING_FAVICON_URL, expiresAt: FAR_FUTURE_MS })
        : unavailable(input, options),
    [WS_METHODS.agentSessionsScan]: () =>
      Effect.sync(() => ({ candidates: [], scannedAt: new Date().toISOString() })),
  });
}
