/**
 * Who this environment is, and what a browser session may do in it.
 *
 * The descriptor is what GET /.well-known/t3/environment, the lifecycle
 * events and the server config all carry. Its id is derived from the host
 * name so it is the same on every start: the client keys its IndexedDB cache
 * and saved environment by it.
 *
 * The session answer. A browser's identity comes from forward-auth and the
 * proxy secret, a paired app's from its device token (auth.ts); either way
 * /api/auth/session says "authenticated" with the scopes a chat needs, and
 * names the method the caller used. No terminal scope and no
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

// The tag= line of T3_PIN, set at build time: build-sidecar.sh and
// gen-stubs.sh pass it to esbuild as a define, vitest.config.ts as one too.
declare const __T3_PIN_TAG__: string | undefined;

/** A T3 release tag as T3 reports its own version: v0.1.0 -> 0.1.0. */
export function serverVersionOf(tag: string): string {
  return tag.replace(/^v/, "");
}

/** Reported as serverVersion: the T3 release the contracts come from (T3_PIN). */
export const T3_SERVER_VERSION =
  typeof __T3_PIN_TAG__ === "string" ? serverVersionOf(__T3_PIN_TAG__) : "0.0.0-unpinned";

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

/** The scope string /oauth/token answers with (RFC 6749: space-separated). */
export const GRANTED_SCOPE_STRING = GRANTED_SCOPES.join(" ");

/**
 * A browser signs in through forward-auth; an app pairs with a one-time code
 * from the lobby's Settings and then sends its bearer.
 */
export const AUTH_DESCRIPTOR: ServerAuthDescriptor = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie", "bearer-access-token"],
  sessionCookieName: "tl_t3_view_session",
};

export type SessionMethod = "browser-session-cookie" | "bearer-access-token";

export function authSessionState(
  nowMs: number,
  method: SessionMethod = "browser-session-cookie",
): AuthSessionState {
  return {
    authenticated: true,
    auth: AUTH_DESCRIPTOR,
    ...authScopeResponse(GRANTED_SCOPES),
    sessionMethod: method,
    expiresAt: DateTime.makeUnsafe(nowMs + SESSION_HORIZON_MS),
  };
}

/** What a caller with no credential, or one that was refused, is told. */
export const UNAUTHENTICATED_SESSION: AuthSessionState = {
  authenticated: false,
  auth: AUTH_DESCRIPTOR,
};

/** The answer to POST /api/auth/browser-session from a caller already signed in. */
export function browserSessionResult(nowMs: number, method: SessionMethod) {
  return {
    authenticated: true as const,
    ...authScopeResponse(GRANTED_SCOPES),
    sessionMethod: method,
    expiresAt: DateTime.makeUnsafe(nowMs + SESSION_HORIZON_MS),
  };
}
