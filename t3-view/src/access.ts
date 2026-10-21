/**
 * How a request is admitted, and the answers T3's client expects when it is
 * not (ADR-0045).
 *
 * A request takes exactly one path, chosen by what it carries:
 *
 *   ?wsTicket=<ticket>             the bearer the ticket was issued for (tickets.ts)
 *   Authorization: Bearer <token>  that bearer
 *   anything else                  the browser path: identity header and proxy secret
 *
 * The first two are the bearer path, decided by BearerAuthGate alone. A
 * request on it that fails never falls through to the header gate, so an
 * identity header beside a bad bearer or a spent ticket admits nothing.
 *
 * Refusals on the bearer path are T3's JSON errors: a 401 must be
 * EnvironmentAuthInvalidError, or the client retries forever instead of
 * asking to pair again (client-runtime connection/errors.ts). Every bearer
 * answer carries T3's CORS headers: the desktop app's renderer runs on
 * t3code://app and reads them cross-origin. They grant no credentials, so a
 * page elsewhere cannot use a browser's cookie through them.
 */
import { randomBytes } from "node:crypto";

import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Option from "effect/Option";

import type { BearerAuthGate, Identity, ProxyAuthGate, RequestHeaders } from "./auth.ts";
import { headerValue } from "./auth.ts";
import type { WsTickets } from "./tickets.ts";

export type Access =
  | { readonly kind: "browser"; readonly identity: Identity }
  | { readonly kind: "bearer"; readonly identity: Identity; readonly bearer: string }
  | {
      readonly kind: "refused";
      /** Which path refused: a bearer refusal is JSON, a browser one plain text. */
      readonly path: "bearer" | "browser";
      readonly status: number;
      readonly response: HttpServerResponse.HttpServerResponse;
    };

export interface AccessDeps {
  readonly gate: ProxyAuthGate;
  readonly bearer: BearerAuthGate;
  readonly tickets: WsTickets;
}

/** T3's own list (apps/server/src/httpCors.ts). */
export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
} as const;

export const PREFLIGHT_HEADERS = {
  ...CORS_HEADERS,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "authorization,b3,traceparent,content-type,dpop,x-t3-orchestration-protocol",
  "access-control-max-age": "600",
} as const;

export function withCors(
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.setHeaders(response, CORS_HEADERS);
}

const traceId = (): string => randomBytes(16).toString("hex");

const errorJson = (status: number, body: Record<string, unknown>) =>
  withCors(
    HttpServerResponse.jsonUnsafe(
      { ...body, traceId: traceId() },
      { status, headers: { "cache-control": "no-store" } },
    ),
  );

export const authInvalid = (reason: "missing_credential" | "invalid_credential") =>
  errorJson(401, { _tag: "EnvironmentAuthInvalidError", code: "auth_invalid", reason });

export const internalError = (reason: string) =>
  errorJson(500, { _tag: "EnvironmentInternalError", code: "internal_error", reason });

export const requestInvalid = (reason: string) =>
  errorJson(400, { _tag: "EnvironmentRequestInvalidError", code: "invalid_request", reason });

export const notFound = (reason: string) =>
  errorJson(404, { _tag: "EnvironmentResourceNotFoundError", code: "not_found", reason });

const BEARER = /^bearer(?:\s+(.*))?$/i;

/**
 * The bearer an Authorization header carries: undefined when there is no
 * bearer header at all, "" when the scheme is Bearer but the token is empty.
 */
export function presentedBearer(headers: RequestHeaders): string | undefined {
  const raw = headerValue(headers, "authorization");
  if (raw === undefined) return undefined;
  const match = BEARER.exec(raw);
  return match === null ? undefined : (match[1] ?? "").trim();
}

export function presentedTicket(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return undefined;
  return url.value.searchParams.get("wsTicket") ?? undefined;
}

/** Whether the request names a bearer-path credential at all. */
export function onBearerPath(request: HttpServerRequest.HttpServerRequest): boolean {
  return presentedTicket(request) !== undefined || presentedBearer(request.headers) !== undefined;
}

async function bearerAccess(deps: AccessDeps, bearer: string): Promise<Access> {
  const decision = await deps.bearer.check(bearer);
  if (decision.ok) return { kind: "bearer", identity: decision.identity, bearer };
  if (decision.status === 502) {
    return { kind: "refused", path: "bearer", status: 500, response: internalError("internal_error") };
  }
  return {
    kind: "refused",
    path: "bearer",
    status: 401,
    response: authInvalid("invalid_credential"),
  };
}

export async function authenticate(
  deps: AccessDeps,
  request: HttpServerRequest.HttpServerRequest,
): Promise<Access> {
  const ticket = presentedTicket(request);
  if (ticket !== undefined) {
    const bearer = deps.tickets.consume(ticket);
    return bearer === undefined
      ? { kind: "refused", path: "bearer", status: 401, response: authInvalid("invalid_credential") }
      : bearerAccess(deps, bearer);
  }
  const bearer = presentedBearer(request.headers);
  if (bearer !== undefined) {
    return bearer === ""
      ? { kind: "refused", path: "bearer", status: 401, response: authInvalid("missing_credential") }
      : bearerAccess(deps, bearer);
  }
  const decision = await deps.gate.check(request.headers);
  if (decision.ok) return { kind: "browser", identity: decision.identity };
  return {
    kind: "refused",
    path: "browser",
    status: decision.status,
    response: HttpServerResponse.text(
      decision.status === 502 ? "lobby unavailable" : "forbidden",
      { status: decision.status },
    ),
  };
}
