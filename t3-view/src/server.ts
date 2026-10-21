/**
 * The sidecar's HTTP surface: the T3 web build at /, the HTTP routes T3's
 * clients call, and Effect RPC on /ws.
 *
 * Almost every route goes through `guarded`, which admits the request
 * (access.ts) before anything else, so an unadmitted caller learns nothing,
 * not even whether a path exists. Three answers need no credential, as on
 * T3's own server: the environment descriptor (an app reads it before it has
 * paired), /oauth/token (the pairing code is the credential) and CORS
 * preflights. /api/auth/session answers a caller with no credential that it
 * is not signed in.
 *
 * A browser's WebSocket upgrade must carry an Origin naming this host, and a
 * write a browser marks as sent from another origin is refused (origin.ts).
 * Neither applies to the bearer path: a page cannot put a bearer on a request
 * the browser sends for it, and a ticket is issued only for a bearer.
 *
 * Routes:
 *   GET  /.well-known/t3/environment   environment descriptor (protocol 2), no credential
 *   GET  /.well-known/t3/thread/:key   the thread id for a key the lobby frames a session by
 *   GET  /.well-known/t3/session/:threadId   the other way: the lobby key and session name
 *   GET  /api/auth/session             who the caller is: chat scopes, or not signed in
 *   POST /api/auth/browser-session     a browser opening /pair: it is already signed in
 *   POST /oauth/token                  a pairing code for a device token, no credential
 *   POST /api/auth/websocket-ticket    a single-use ticket for /ws, bearer only
 *   GET  /api/orchestration/shell      shell snapshot; needs the protocol header
 *   GET  /api/orchestration/threads/:id/bounded   a thread's snapshot (the whole window for now)
 *   GET  /api/orchestration/threads/:id/history   older rows (none: the bounded window is complete)
 *   GET  /api/orchestration/threads/:id/transcript   the thread's visible rows, for "attach thread"
 *   POST /api/observability/v1/traces  204: the client posts traces unconditionally
 *   GET  /ws?orchestrationProtocol=2   Effect RPC (WsRpcGroup), JSON frames; 426 on mismatch
 *   OPTIONS *                          CORS preflight, 204
 *   GET  *                             the web build, index.html for app routes; a
 *                                      thread route named by another key of the same
 *                                      session redirects to its thread id
 */
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthBrowserSessionResult,
  AuthClientMetadataDeviceType,
  AuthEnvironmentBootstrapTokenType,
  AuthSessionState,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  ExecutionEnvironmentDescriptor,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadTranscript,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import {
  type Access,
  authenticate,
  authInvalid,
  internalError,
  notFound,
  onBearerPath,
  PREFLIGHT_HEADERS,
  requestInvalid,
  withCors,
} from "./access.ts";
import type { BearerAuthGate, Identity, ProxyAuthGate } from "./auth.ts";
import type { Commands } from "./commands/dispatch.ts";
import {
  authSessionState,
  browserSessionResult,
  GRANTED_SCOPE_STRING,
  UNAUTHENTICATED_SESSION,
} from "./descriptor.ts";
import type { Hub } from "./hub.ts";
import type { DeviceExchange } from "./pairing.ts";
import {
  hasCompatibleOrchestrationProtocol,
  hasOrchestrationProtocolHeader,
  protocolIncompatibleBody,
} from "./protocol.ts";
import { frameAncestors, isCrossSiteWrite, isSameOriginUpgrade } from "./origin.ts";
import { AUTH_CLOSE_CODE, AUTH_CLOSE_REASON, type BearerWatch } from "./revocation.ts";
import { rpcScopeAuthorization } from "./rpc/authorization.ts";
import { makeHandlers } from "./rpc/handlers.ts";
import type { SequenceClock } from "./sequence.ts";
import type { ConfigContext } from "./serverConfig.ts";
import type { WsTickets } from "./tickets.ts";

export interface SidecarDeps {
  readonly gate: ProxyAuthGate;
  readonly bearer: BearerAuthGate;
  readonly tickets: WsTickets;
  readonly watch: BearerWatch;
  readonly exchange: DeviceExchange;
  readonly webDir: string;
  readonly config: ConfigContext;
  readonly clock: SequenceClock;
  readonly hub: Hub;
  readonly commands: Commands;
}

/**
 * As T3's server: a defect in one handler fails only its own request, instead
 * of a socket-level Defect frame that ends every pending request on the socket.
 */
const RPC_SERVER_OPTIONS = { disableTracing: true, disableFatalDefects: true } as const;

type Codec<A> = Schema.Codec<A, unknown, never, never>;

/** JSON in T3's wire encoding (dates as ISO strings and so on). */
function schemaJson<A>(schema: Codec<A>, value: A): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(Schema.encodeSync(Schema.toCodecJson(schema))(value), {
    headers: { "cache-control": "no-store" },
  });
}

type AdmittedAccess = Exclude<Access, { readonly kind: "refused" }>;

function guarded<E, R>(
  deps: SidecarDeps,
  handler: (
    identity: Identity,
    request: HttpServerRequest.HttpServerRequest,
    access: AdmittedAccess,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return (request: HttpServerRequest.HttpServerRequest) =>
    Effect.flatMap(
      Effect.promise(() => authenticate(deps, request)),
      (access): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> => {
        if (access.kind === "refused") return Effect.succeed(access.response);
        if (access.kind === "bearer") {
          // A bearer is not ambient: no page can make a browser attach one,
          // so the cross-site check does not apply. Answers carry T3's CORS.
          return Effect.map(handler(access.identity, request, access), withCors);
        }
        if (isCrossSiteWrite(request.method, request.headers)) {
          return Effect.succeed(HttpServerResponse.text("forbidden", { status: 403 }));
        }
        return handler(access.identity, request, access);
      },
    );
}

/** How long the device token is said to last. It has no fixed expiry (ADR-0045), and T3 never refreshes one. */
const TOKEN_EXPIRES_IN_S = 10 * 365 * 24 * 60 * 60;
const TOKEN_BODY_MAX = 16 * 1024;
const DEVICE_TYPES = new Set<string>(AuthClientMetadataDeviceType.literals);

/** POST /oauth/token: T3's token exchange, with the pairing code as the subject token. */
function tokenExchange(deps: SidecarDeps, request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const body = yield* request.text.pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (body === undefined || body.length > TOKEN_BODY_MAX) {
      return withCors(
        HttpServerResponse.jsonUnsafe(
          { _tag: "HttpApiSchemaError", message: "unreadable request body" },
          { status: 400 },
        ),
      );
    }
    const form = new URLSearchParams(body);
    const field = (name: string) => {
      const value = form.get(name)?.trim();
      return value === undefined || value === "" ? undefined : value;
    };
    const code = field("subject_token");
    if (
      form.get("grant_type") !== AuthTokenExchangeGrantType ||
      form.get("subject_token_type") !== AuthEnvironmentBootstrapTokenType ||
      form.get("requested_token_type") !== AuthAccessTokenType ||
      code === undefined
    ) {
      return withCors(
        HttpServerResponse.jsonUnsafe(
          { _tag: "HttpApiSchemaError", message: "not a T3 environment token exchange" },
          { status: 400 },
        ),
      );
    }
    // A scope the client asks for must be well formed; what it gets is the
    // sidecar's chat scopes either way, as /api/auth/session reports them.
    const scope = form.get("scope");
    if (scope !== null && !/^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(scope)) {
      return requestInvalid("invalid_scope");
    }
    const label = field("client_label");
    const deviceType = field("client_device_type");
    const os = field("client_os");
    const result = yield* Effect.promise(() =>
      deps.exchange({
        code,
        ...(label === undefined ? {} : { label }),
        ...(deviceType === undefined || !DEVICE_TYPES.has(deviceType) ? {} : { deviceType }),
        ...(os === undefined ? {} : { os }),
      }),
    );
    if (!result.ok) {
      return result.status === 401
        ? authInvalid("invalid_credential")
        : internalError("access_token_issuance_failed");
    }
    return withCors(
      schemaJson(AuthAccessTokenResult, {
        access_token: result.token,
        issued_token_type: AuthAccessTokenType,
        token_type: "Bearer",
        expires_in: TOKEN_EXPIRES_IN_S,
        scope: GRANTED_SCOPE_STRING,
      }),
    );
  });
}

/**
 * GET /api/auth/session. As T3's server: a caller with no credential, or a
 * bearer that is refused, is told it is not signed in (200), so the client
 * offers to pair rather than retrying. A browser's refusal keeps its status.
 */
function sessionState(deps: SidecarDeps, request: HttpServerRequest.HttpServerRequest) {
  return Effect.promise(async () => {
    const unauthenticated = () =>
      withCors(schemaJson(AuthSessionState, UNAUTHENTICATED_SESSION));
    if (!onBearerPath(request) && !deps.gate.presented(request.headers)) {
      return unauthenticated();
    }
    const access = await authenticate(deps, request);
    switch (access.kind) {
      case "refused":
        return access.path === "bearer" && access.status === 401
          ? unauthenticated()
          : access.response;
      case "bearer":
        return withCors(
          schemaJson(AuthSessionState, authSessionState(Date.now(), "bearer-access-token")),
        );
      case "browser":
        return schemaJson(AuthSessionState, authSessionState(Date.now()));
    }
  });
}

const encodeTranscript = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadTranscript));

/** Paths that are never part of the web build, so they 404 rather than fall back to index.html. */
const RESERVED_PREFIXES = ["/api/", "/ws", "/.well-known/"];

const IMMUTABLE_ASSET = /^assets\/.+-[\w-]{8}\.[^/]+$/;

function serveWebBuild(webDir: string, pathname: string) {
  return Effect.gen(function* () {
    if (RESERVED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return HttpServerResponse.text("not found", { status: 404 });
    }
    let relative: string;
    try {
      relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    } catch {
      return HttpServerResponse.text("bad path", { status: 400 });
    }
    const root = resolve(webDir);
    const candidate = resolve(root, relative === "" ? "index.html" : relative);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      return HttpServerResponse.text("bad path", { status: 400 });
    }
    const info = yield* Effect.promise(() => stat(candidate).catch(() => undefined));
    let file = candidate;
    if (info === undefined || !info.isFile()) {
      if (extname(candidate) !== "") {
        return HttpServerResponse.text("not found", { status: 404 });
      }
      // An app route such as /<environment>/<thread>: the SPA owns it.
      file = resolve(root, "index.html");
    }
    const immutable = IMMUTABLE_ASSET.test(file.slice(root.length + 1));
    return yield* HttpServerResponse.file(file, {
      headers: {
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      },
    }).pipe(
      Effect.catch(() => Effect.succeed(HttpServerResponse.text("not found", { status: 404 }))),
    );
  });
}

/**
 * The lobby frames a session by its birth name (frontend-v2 keyOf), and the
 * thread id differs for a session T3 created or a hand-named one renamed
 * while the sidecar watched. T3's client sends a route whose thread is not in
 * the shell to a draft, so the sidecar answers such a route with a redirect
 * to the thread's own id.
 */
function threadRedirect(deps: SidecarDeps, identity: Identity, url: URL) {
  return Effect.promise(async (): Promise<HttpServerResponse.HttpServerResponse | undefined> => {
    const match = /^\/([^/]+)\/([^/.]+)$/.exec(url.pathname);
    if (match === null || match[1] !== deps.config.descriptor.environmentId) return undefined;
    let key: string;
    try {
      key = decodeURIComponent(match[2] ?? "");
    } catch {
      return undefined;
    }
    const entry = await deps.hub
      .user(identity)
      .resolve(key)
      .catch(() => undefined);
    if (entry === undefined || entry.threadId === key) return undefined;
    return HttpServerResponse.redirect(
      `/${match[1]}/${encodeURIComponent(entry.threadId)}${url.search}`,
      { status: 302, headers: { "cache-control": "no-store" } },
    );
  });
}

/**
 * One WebSocket: Effect RPC over the upgraded socket, for as long as it is
 * open. While it is, the socket holds its credential with the user's hub
 * (hub.ts hold), and a bearer socket is watched for revocation
 * (revocation.ts), which closes it with AUTH_CLOSE_CODE.
 *
 * Effect's websocket protocol upgrades the request itself and offers no way
 * to close the socket with a code of our choosing, so the upgrade happens
 * here first and the protocol is handed a request whose `upgrade` is that
 * socket. Everything else about the request is the original's.
 */
function serveWebSocket(
  deps: SidecarDeps,
  request: HttpServerRequest.HttpServerRequest,
  access: AdmittedAccess,
) {
  return Effect.gen(function* () {
    const socket = yield* Effect.orDie(request.upgrade);
    const writer = yield* socket.writer;
    const close = () => {
      Effect.runFork(
        writer.write(new Socket.CloseEvent(AUTH_CLOSE_CODE, AUTH_CLOSE_REASON)).pipe(Effect.ignore),
      );
    };
    const upgraded: HttpServerRequest.HttpServerRequest = Object.create(request, {
      upgrade: { value: Effect.succeed(socket) },
    });
    const release = deps.hub.user(access.identity).hold(access.identity.relay);
    const unwatch = access.kind === "bearer" ? deps.watch.watch(access.bearer, close) : () => {};
    const serve = yield* rpcOverWebSocket(deps, access.identity);
    return yield* serve.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, upgraded),
      Effect.ensuring(
        Effect.sync(() => {
          unwatch();
          release();
        }),
      ),
    );
  });
}

function rpcOverWebSocket(deps: SidecarDeps, identity: Identity) {
  const handlers = WsRpcGroup.toLayer(
    makeHandlers({
      identity,
      config: deps.config,
      clock: deps.clock,
      hub: deps.hub,
      commands: deps.commands,
    }),
  );
  return Effect.gen(function* () {
    const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* RpcServer.make(WsRpcGroup, RPC_SERVER_OPTIONS).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(rpcScopeAuthorization),
      Effect.forkScoped,
    );
    return httpEffect;
  }).pipe(Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerJson)));
}

export function routes(deps: SidecarDeps) {
  return Layer.mergeAll(
    // No credential: an app reads this before it has paired, and checks the
    // environment id on every reconnect.
    HttpRouter.add("GET", "/.well-known/t3/environment", () =>
      Effect.succeed(withCors(schemaJson(ExecutionEnvironmentDescriptor, deps.config.descriptor))),
    ),
    HttpRouter.add("OPTIONS", "*", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 204, headers: PREFLIGHT_HEADERS })),
    ),
    HttpRouter.add("POST", "/oauth/token", (request) => tokenExchange(deps, request)),
    HttpRouter.add("GET", "/api/auth/session", (request) => sessionState(deps, request)),
    HttpRouter.add(
      "POST",
      "/api/auth/browser-session",
      guarded(deps, (_identity, _request, access) =>
        Effect.sync(() =>
          schemaJson(
            AuthBrowserSessionResult,
            browserSessionResult(
              Date.now(),
              access.kind === "bearer" ? "bearer-access-token" : "browser-session-cookie",
            ),
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/api/auth/websocket-ticket",
      guarded(deps, (_identity, _request, access) =>
        Effect.sync(() => {
          if (access.kind !== "bearer") return authInvalid("missing_credential");
          const issued = deps.tickets.issue(access.bearer);
          return schemaJson(AuthWebSocketTicketResult, {
            ticket: issued.ticket,
            expiresAt: DateTime.makeUnsafe(issued.expiresAt),
          });
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/t3/thread/:key",
      guarded(deps, (identity) =>
        Effect.gen(function* () {
          const { key } = yield* HttpRouter.params;
          if (key === undefined) return HttpServerResponse.text("not found", { status: 404 });
          return yield* Effect.promise(async () => {
            const entry = await deps.hub
              .user(identity)
              .resolve(key)
              .catch(() => undefined);
            return entry === undefined
              ? HttpServerResponse.text("not found", { status: 404 })
              : HttpServerResponse.jsonUnsafe(
                  { threadId: entry.threadId },
                  { headers: { "cache-control": "no-store" } },
                );
          });
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/t3/session/:threadId",
      guarded(deps, (identity) =>
        Effect.gen(function* () {
          const { threadId } = yield* HttpRouter.params;
          if (threadId === undefined) return HttpServerResponse.text("not found", { status: 404 });
          return yield* Effect.promise(async () => {
            const found = await deps.hub
              .user(identity)
              .lobbyKey(threadId)
              .catch(() => undefined);
            return found === undefined
              ? HttpServerResponse.text("not found", { status: 404 })
              : HttpServerResponse.jsonUnsafe(
                  { key: found.key, name: found.name },
                  { headers: { "cache-control": "no-store" } },
                );
          });
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/api/orchestration/shell",
      guarded(deps, (identity, request) =>
        hasOrchestrationProtocolHeader(request.headers)
          ? Effect.promise(async () => {
              const user = deps.hub.user(identity);
              await user.refresh().catch(() => undefined);
              return schemaJson(OrchestrationV2ShellSnapshot, user.shellSnapshot());
            })
          : Effect.succeed(
              HttpServerResponse.jsonUnsafe(protocolIncompatibleBody, { status: 400 }),
            ),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/api/orchestration/threads/:threadId/bounded",
      guarded(deps, (identity, request) =>
        Effect.gen(function* () {
          if (!hasOrchestrationProtocolHeader(request.headers)) {
            return HttpServerResponse.jsonUnsafe(protocolIncompatibleBody, { status: 400 });
          }
          const { threadId } = yield* HttpRouter.params;
          if (threadId === undefined) return HttpServerResponse.text("not found", { status: 404 });
          return yield* Effect.promise(async () => {
            const live = await deps.hub.user(identity).thread(threadId, identity.relay);
            if (live === undefined) return HttpServerResponse.text("not found", { status: 404 });
            await live.ready();
            // Paging is the second cut: the window is the whole projection,
            // so there is no older history to fetch.
            return schemaJson(OrchestrationV2ThreadBoundedSnapshot, {
              snapshotSequence: live.model.snapshotSequence,
              projection: live.projection,
              historyCursor: null,
              hasMoreHistory: false,
              latestLocalTurnOrdinal: live.model.latestLocalTurnOrdinal,
            });
          });
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/api/orchestration/threads/:threadId/transcript",
      guarded(deps, (identity, request) =>
        Effect.gen(function* () {
          if (!hasOrchestrationProtocolHeader(request.headers)) {
            return HttpServerResponse.jsonUnsafe(protocolIncompatibleBody, { status: 400 });
          }
          const { threadId } = yield* HttpRouter.params;
          if (threadId === undefined) return notFound("thread_not_found");
          return yield* Effect.promise(async () => {
            const live = await deps.hub.user(identity).thread(threadId, identity.relay);
            if (live === undefined) return notFound("thread_not_found");
            await live.ready();
            // As T3's server (ThreadManagementService getThreadTranscript):
            // the visible rows, refused past the size a turn may attach.
            const transcript = {
              threadId: live.projection.thread.id,
              title: live.projection.thread.title,
              updatedAt: live.projection.updatedAt,
              items: live.projection.visibleTurnItems,
            };
            const json = JSON.stringify(encodeTranscript(transcript));
            return Buffer.byteLength(json, "utf8") > PROVIDER_SEND_TURN_MAX_FILE_BYTES
              ? requestInvalid("thread_transcript_too_large")
              : HttpServerResponse.text(json, {
                  contentType: "application/json",
                  headers: { "cache-control": "no-store" },
                });
          });
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/api/orchestration/threads/:threadId/history",
      guarded(deps, (identity, request) =>
        Effect.gen(function* () {
          if (!hasOrchestrationProtocolHeader(request.headers)) {
            return HttpServerResponse.jsonUnsafe(protocolIncompatibleBody, { status: 400 });
          }
          const { threadId } = yield* HttpRouter.params;
          const live =
            threadId === undefined ? undefined : deps.hub.user(identity).liveThread(threadId);
          return schemaJson(OrchestrationV2ThreadHistoryPage, {
            snapshotSequence: live?.model.snapshotSequence ?? deps.clock.current(),
            items: [],
            nextCursor: null,
            hasMoreHistory: false,
          });
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/api/observability/v1/traces",
      guarded(deps, () => Effect.succeed(HttpServerResponse.empty({ status: 204 }))),
    ),
    HttpRouter.add(
      "GET",
      "/ws",
      guarded(deps, (_identity, request, access) =>
        Effect.gen(function* () {
          // A browser's cookie reaches this host whatever page opened the
          // socket, so a browser upgrade must come from this origin. A ticket
          // or a bearer is not ambient, and an app's origin is its own.
          if (access.kind === "browser" && !isSameOriginUpgrade(request.headers)) {
            return HttpServerResponse.text("forbidden", { status: 403 });
          }
          const url = HttpServerRequest.toURL(request);
          if (Option.isNone(url) || !hasCompatibleOrchestrationProtocol(url.value)) {
            return HttpServerResponse.jsonUnsafe(protocolIncompatibleBody, { status: 426 });
          }
          return yield* serveWebSocket(deps, request, access);
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "*",
      guarded(deps, (identity, request) => {
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) {
          return Effect.succeed(HttpServerResponse.text("bad request", { status: 400 }));
        }
        // Every page the sidecar serves says who may frame it: the lobby only.
        const csp = frameAncestors(request.headers.host);
        return Effect.flatMap(threadRedirect(deps, identity, url.value), (redirect) =>
          redirect === undefined
            ? serveWebBuild(deps.webDir, url.value.pathname)
            : Effect.succeed(redirect),
        ).pipe(
          Effect.map((response) =>
            HttpServerResponse.setHeader(response, "content-security-policy", csp),
          ),
        );
      }),
    ),
  );
}

export interface Listen {
  readonly host: string;
  readonly port: number;
}

/** The whole sidecar as one layer: routes, router, and a Node HTTP server on `listen`. */
export function sidecarLayer(deps: SidecarDeps, listen: Listen) {
  return HttpRouter.serve(routes(deps), { disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => createServer(), listen)),
  );
}
