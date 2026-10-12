import {
  AuthSessionState,
  ExecutionEnvironmentDescriptor,
  OrchestrationV2ShellSnapshot,
  ServerConfig,
  ServerLifecycleStreamEvent,
  sessionGrantsScope,
  sessionHasLegacyPermissions,
} from "@t3tools/contracts";
import { isFreshFirstRunWorkspace } from "@t3tools/web/src/onboarding/firstRun.logic.ts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  authSessionState,
  environmentDescriptor,
  environmentIdFor,
  GRANTED_SCOPES,
} from "../src/descriptor.ts";
import { lifecycleEvents, serverConfig } from "../src/serverConfig.ts";
import { placeholderShell } from "../src/shell.ts";

/** Encode with T3's JSON codec and decode the wire form back, as the client does. */
function roundTrip<
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(schema: S, value: S["Type"]): S["Type"] {
  const codec = Schema.toCodecJson(schema);
  const wire: unknown = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(value)));
  return Schema.decodeUnknownSync(codec)(wire);
}

const descriptor = environmentDescriptor({
  environmentId: environmentIdFor("devvm"),
  label: "devvm",
});
const context = { descriptor, cwd: "/", startedAt: "2026-10-12T08:00:00.000Z" };

describe("environment descriptor", () => {
  it("decodes as T3's descriptor and speaks protocol 2", () => {
    expect(roundTrip(ExecutionEnvironmentDescriptor, descriptor).orchestrationProtocolVersion).toBe(
      2,
    );
  });

  it("keeps one environment id per host across restarts", () => {
    expect(environmentIdFor("devvm")).toBe(environmentIdFor("devvm"));
    expect(environmentIdFor("devvm")).not.toBe(environmentIdFor("other"));
    expect(environmentIdFor("devvm")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("auth session", () => {
  const session = roundTrip(AuthSessionState, authSessionState(Date.parse(context.startedAt)));

  it("is authenticated without pairing", () => {
    expect(session.authenticated).toBe(true);
  });

  it("grants the chat and nothing for terminals or source control writes", () => {
    expect(sessionGrantsScope(session, "orchestration:read")).toBe(true);
    expect(sessionGrantsScope(session, "orchestration:operate")).toBe(true);
    for (const scope of ["terminal:read", "terminal:operate", "source-control:write"] as const) {
      expect(sessionGrantsScope(session, scope)).toBe(false);
      expect(GRANTED_SCOPES).not.toContain(scope);
    }
  });

  it("does not raise the client's legacy-permissions toast", () => {
    expect(sessionHasLegacyPermissions(session)).toBe(false);
  });
});

describe("server config and lifecycle", () => {
  it("decodes as T3's ServerConfig", () => {
    const config = roundTrip(ServerConfig, serverConfig(context));
    expect(config.environment.environmentId).toBe(descriptor.environmentId);
  });

  it("offers one ready, authenticated Claude provider with the lobby's models", () => {
    const [provider, ...others] = roundTrip(ServerConfig, serverConfig(context)).providers;
    expect(others).toEqual([]);
    expect(provider).toMatchObject({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
    });
    expect(provider?.models.map((m) => m.slug)).toContain("claude-opus-5-5");
    expect(provider?.models.filter((m) => m.isDefault).map((m) => m.slug)).toEqual([
      "claude-opus-5-5",
    ]);
  });

  it("sends welcome then ready, and the welcome is final", () => {
    const events = lifecycleEvents(context).map((e) => roundTrip(ServerLifecycleStreamEvent, e));
    expect(events.map((e) => [e.type, e.sequence])).toEqual([
      ["welcome", 1],
      ["ready", 2],
    ]);
    expect(events[0]?.type === "welcome" && events[0].payload.bootstrapStatus).toBe("complete");
  });
});

describe("shell", () => {
  const shell = roundTrip(
    OrchestrationV2ShellSnapshot,
    placeholderShell({ osUser: "wizard", snapshotSequence: 42, startedAt: context.startedAt }),
  );

  it("decodes as T3's shell snapshot at the given sequence", () => {
    expect(shell.snapshotSequence).toBe(42);
  });

  it("is not a fresh workspace to the web client's first-run gate", () => {
    const fresh = isFreshFirstRunWorkspace({
      primaryEnvironmentId: descriptor.environmentId,
      serverCwd: context.cwd,
      projects: shell.projects.map((p) => ({
        id: p.id,
        environmentId: descriptor.environmentId,
        workspaceRoot: p.workspaceRoot,
      })),
      threads: [],
    });
    expect(fresh).toBe(false);
  });
});
