/**
 * The WsRpcGroup handlers for one WebSocket connection.
 *
 * Real handlers cover booting and sitting on a page (config, lifecycle,
 * probe, and the RPCs the stage 1 trace saw the client call unprompted, each
 * answered with an honest empty value), the read path (the shell and
 * threads, from the hub) and the commands (commands/dispatch.ts). Everything
 * else falls through to STUB_HANDLERS.
 *
 * Every lobby call made for this connection relays `identity` (auth.ts), and
 * every cache it reads is keyed by `identity.osUser` (hub.ts).
 */
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadStreamItem,
  OrchestrationV2ThreadLaunchError,
  ProjectReadFileError,
  type ServerConfigStreamEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { Identity } from "../auth.ts";
import { CommandFailure, type Commands } from "../commands/dispatch.ts";
import type { Hub } from "../hub.ts";
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
  readonly hub: Hub;
  readonly commands: Commands;
}

/** A finite prefix, then a subscription that stays open until the client ends it. */
const thenStayOpen = <A>(items: ReadonlyArray<A>): Stream.Stream<A> =>
  Stream.concat(Stream.fromIterable(items), Stream.never);

/**
 * A stream fed by a subscription: `open` registers a listener and returns
 * what to send first; the listener's items follow, in order, until the client
 * ends the stream, which unsubscribes.
 */
function subscription<A>(
  open: (emit: (item: A) => void) => Promise<{
    readonly start: ReadonlyArray<A>;
    readonly unsubscribe: () => void;
  }>,
): Stream.Stream<A> {
  return Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.promise(async () => {
        const sub = await open((item) => {
          Queue.offerUnsafe(queue, item);
        });
        for (const item of sub.start) Queue.offerUnsafe(queue, item);
        return sub;
      }),
      (sub) => Effect.sync(() => sub.unsubscribe()),
    ),
  );
}

const failureMessage = (error: unknown): string =>
  error instanceof CommandFailure || error instanceof Error ? error.message : String(error);

export const MISSING_FAVICON_URL = "/api/assets/project-favicon-missing";
const FAR_FUTURE_MS = Date.UTC(2100, 0, 1);

/** The id under which this process's preview state would reset; there is none. */
const PREVIEW_EPOCH = "tl-t3-view";

/** The VCS status of a session's directory: the sidecar reports no repository. */
const NO_REPO = {
  isRepo: false,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
} as const;

export function makeHandlers(context: ConnectionContext) {
  const liveModels = () => context.hub.user(context.identity).liveModels;
  const config = () => serverConfig(context.config, liveModels());
  const provider = () => claudeProvider(context.config.startedAt, liveModels());

  return WsRpcGroup.of({
    ...STUB_HANDLERS,

    [WS_METHODS.serverProbe]: () => Effect.succeed({}),
    [WS_METHODS.serverGetConfig]: () => Effect.sync(config),
    [WS_METHODS.serverRefreshProviders]: () => Effect.sync(() => ({ providers: [provider()] })),

    // The provider's models follow the user's live sessions (models.ts), so a
    // change is sent as providerStatuses after the snapshot.
    [WS_METHODS.subscribeServerConfig]: (input) =>
      subscription<ServerConfigStreamEvent>(async (emit) => {
        const events: ServerConfigStreamEvent[] = [
          { version: 1, type: "snapshot", config: config() },
        ];
        if (input.usageLimitSources === true) {
          events.push({ version: 1, type: "usageLimitSourcesUpdated", payload: { sources: [] } });
        }
        if (input.environmentThemes === true) {
          events.push({ version: 1, type: "environmentThemesUpdated", payload: { themes: [] } });
        }
        const unsubscribe = context.hub
          .user(context.identity)
          .subscribeModels(() =>
            emit({ version: 1, type: "providerStatuses", payload: { providers: [provider()] } }),
          );
        return { start: events, unsubscribe };
      }),
    [WS_METHODS.subscribeServerLifecycle]: () => thenStayOpen(lifecycleEvents(context.config)),

    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
      subscription<OrchestrationV2ShellStreamItem>(async (emit) => {
        const user = context.hub.user(context.identity);
        await user.refresh().catch(() => undefined);
        const sub = user.subscribeShell(input.afterSequence, emit);
        return {
          start:
            input.requestCompletionMarker === true
              ? [...sub.start, { kind: "synchronized" }]
              : sub.start,
          unsubscribe: sub.unsubscribe,
        };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: () =>
      Effect.promise(async () => {
        const user = context.hub.user(context.identity);
        await user.refresh().catch(() => undefined);
        const snapshot = user.shellSnapshot();
        return {
          schemaVersion: SHELL_SCHEMA_VERSION,
          snapshotSequence: snapshot.snapshotSequence,
          projects: snapshot.projects,
          threads: [],
        };
      }),
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
      subscription<OrchestrationV2ThreadStreamItem>(async (emit) => {
        const live = await context.hub
          .user(context.identity)
          .thread(input.threadId, context.identity.relay);
        if (live === undefined) {
          // A thread the lobby does not list (deleted, or a draft T3 has not
          // launched yet): nothing to stream, and the client keeps waiting.
          return {
            start: input.requestCompletionMarker === true ? [{ kind: "synchronized" }] : [],
            unsubscribe: () => {},
          };
        }
        await live.ready();
        const sub = live.subscribe(input.afterSequence, emit);
        const start = sub.start.kind === "snapshot" ? [sub.start.item] : sub.start.items;
        return {
          start:
            input.requestCompletionMarker === true ? [...start, { kind: "synchronized" }] : start,
          unsubscribe: sub.unsubscribe,
        };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
      Effect.tryPromise({
        try: async () => {
          const live = await context.hub
            .user(context.identity)
            .thread(input.threadId, context.identity.relay);
          if (live === undefined) throw new Error("The lobby lists no such session.");
          await live.ready();
          return live.projection;
        },
        catch: (error) =>
          new OrchestrationV2GetThreadProjectionError({
            threadId: input.threadId,
            message: failureMessage(error),
          }),
      }),
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
      Effect.tryPromise({
        try: async () => {
          await context.commands.dispatch(context.identity, command);
          return { sequence: context.clock.current() };
        },
        catch: (error) =>
          new OrchestrationV2DispatchCommandError({
            commandId: command.commandId,
            commandType: command.type,
            message: failureMessage(error),
          }),
      }),
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
      Effect.tryPromise({
        try: async () => {
          const result = await context.commands.launch(context.identity, input);
          return {
            threadId: result.projection.thread.id,
            projection: result.projection,
            resumed: false,
          };
        },
        catch: (error) =>
          new OrchestrationV2ThreadLaunchError({
            commandId: input.commandId,
            projectId: input.projectId,
            message: failureMessage(error),
          }),
      }),

    // Called unprompted by the web client; each has nothing to report here.
    [WS_METHODS.previewReportProfiles]: () => Effect.void,
    [WS_METHODS.serverReportClientActivity]: () => Effect.void,
    [WS_METHODS.subscribeProjectClones]: () => thenStayOpen([[]]),
    [WS_METHODS.scheduledTasksSubscribe]: () => thenStayOpen([{ tasks: [] }]),
    [WS_METHODS.subscribeVcsStatus]: () =>
      thenStayOpen([{ _tag: "snapshot" as const, local: NO_REPO, remote: null }]),
    [WS_METHODS.vcsRefreshStatus]: () =>
      Effect.succeed({
        ...NO_REPO,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
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
