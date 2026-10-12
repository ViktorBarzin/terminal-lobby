/**
 * Who this environment is, and what a browser session may do in it.
 *
 * The descriptor is what GET /.well-known/t3/environment, the lifecycle
 * events and the server config all carry. Its id is derived from the host
 * name so it is the same on every start: the client keys its IndexedDB cache
 * and saved environment by it.
 *
 * The session answer replaces T3's pairing flow. Forward-auth and the proxy
 * secret already decided who the caller is (auth.ts), so /api/auth/session
 * says "authenticated" with the scopes a chat needs. No terminal scope and no
 * source-control write: the sidecar serves neither, and T3's RpcScopeAuthorization
 * (rpc/authorization.ts) refuses those RPCs by the same list. At least one
 * non-legacy scope (filesystem:read) is granted, because a session whose
 * permissions are all legacy parent scopes makes the client raise a
 * "Permissions have changed" toast (contracts auth.ts sessionHasLegacyPermissions).
 */
import { createHash } from "node:crypto";

import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  type AuthSessionState,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ServerAuthDescriptor,
  authScopeResponse,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Reported as serverVersion: the T3 release the contracts come from. */
export const T3_SERVER_VERSION = "0.0.46";

export const GRANTED_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthFilesystemReadScope,
];

/** How long the client is told its session lasts. Forward-auth decides the real lifetime. */
const SESSION_HORIZON_MS = 24 * 60 * 60 * 1000;

export function environmentIdFor(hostname: string): EnvironmentId {
  const hex = createHash("sha256").update(`tl-t3-view:${hostname}`).digest("hex");
  return EnvironmentId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
}

export function environmentDescriptor(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}): ExecutionEnvironmentDescriptor {
  return {
    environmentId: input.environmentId,
    label: input.label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: T3_SERVER_VERSION,
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: {
      repositoryIdentity: false,
      connectionProbe: true,
    },
  };
}

export const AUTH_DESCRIPTOR: ServerAuthDescriptor = {
  policy: "remote-reachable",
  bootstrapMethods: [],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "tl_t3_view_session",
};

export function authSessionState(nowMs: number): AuthSessionState {
  return {
    authenticated: true,
    auth: AUTH_DESCRIPTOR,
    ...authScopeResponse(GRANTED_SCOPES),
    sessionMethod: "browser-session-cookie",
    expiresAt: DateTime.makeUnsafe(nowMs + SESSION_HORIZON_MS),
  };
}
