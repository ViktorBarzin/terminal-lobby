/**
 * The ServerConfig snapshot and the two lifecycle events, which together are
 * everything the web client needs before it renders its shell.
 *
 * One provider exists, a fabricated claudeAgent: ready, authenticated, with the
 * lobby's models. The composer reads its status, models and option
 * descriptors; it never runs anything, because every thread is a lobby
 * session whose Claude is already running in tmux.
 */
import {
  type ExecutionEnvironmentDescriptor,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerLifecycleStreamEvent,
  type ServerProvider,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { AUTH_DESCRIPTOR } from "./descriptor.ts";
import { LOBBY_CLAUDE_MODELS, toProviderModel } from "./models.ts";

export const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

export function claudeProvider(checkedAt: string): ServerProvider {
  return {
    instanceId: CLAUDE_INSTANCE_ID,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    showInteractionModeToggle: true,
    reportsContextWindow: true,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: LOBBY_CLAUDE_MODELS.map((model, index) => toProviderModel(model, index === 0)),
    slashCommands: [],
    skills: [],
  };
}

export interface ConfigContext {
  readonly descriptor: ExecutionEnvironmentDescriptor;
  /**
   * The environment's working directory as T3 sees it. It must not equal any
   * project's root, or the first-run gate takes that project for the server's
   * own cwd bootstrap and shows the welcome wizard.
   */
  readonly cwd: string;
  readonly startedAt: string;
}

export function serverConfig(context: ConfigContext): ServerConfig {
  return {
    environment: context.descriptor,
    auth: AUTH_DESCRIPTOR,
    cwd: context.cwd,
    keybindingsConfigPath: "/dev/null",
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    issues: [],
    providers: [claudeProvider(context.startedAt)],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/dev/null",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
      otlpLogsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
    shellResumeCompletionMarker: true,
    threadResumeCompletionMarker: true,
  };
}

/** Sent as sequence 1 then 2 on every subscribeServerLifecycle. */
export function lifecycleEvents(context: ConfigContext): ReadonlyArray<ServerLifecycleStreamEvent> {
  return [
    {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment: context.descriptor,
        cwd: context.cwd,
        projectName: "Lobby",
        // No cwd auto-bootstrap happens here, so the workspace is final as sent.
        bootstrapStatus: "complete",
      },
    },
    {
      version: 1,
      sequence: 2,
      type: "ready",
      payload: { at: context.startedAt, environment: context.descriptor },
    },
  ];
}
