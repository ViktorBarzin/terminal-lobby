/**
 * The sidecar's HTTP surface: the T3 web build at /, the handful of HTTP
 * routes the client calls, and Effect RPC on /ws.
 *
 * Every route goes through `guarded`, which runs the auth gate (auth.ts)
 * before anything else, so an unauthenticated caller learns nothing, not even
 * whether a path exists or which protocol version the sidecar speaks. The
 * WebSocket upgrade is a GET to /ws and takes the same path, then must carry
 * an Origin naming this host, and a write a browser marks as sent from another
 * origin is refused (origin.ts).
 *
 * Routes:
 *   GET  /.well-known/t3/environment   environment descriptor (protocol 2)
 *   GET  /.well-known/t3/thread/:key   the thread id for a key the lobby frames a session by
 *   GET  /api/auth/session             authenticated, chat scopes only
 *   GET  /api/orchestration/shell      shell snapshot; needs the protocol header
 *   GET  /api/orchestration/threads/:id/bounded   a thread's snapshot (the whole window for now)
 *   GET  /api/orchestration/threads/:id/history   older rows (none: the bounded window is complete)
 *   POST /api/observability/v1/traces  204: the client posts traces unconditionally
 *   GET  /ws?orchestrationProtocol=2   Effect RPC (WsRpcGroup), JSON frames; 426 on mismatch
 *   GET  *                             the web build, index.html for app routes; a
 *                                      thread route named by another key of the same
 *                                      session redirects to its thread id
 */
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthSessionState,
  ExecutionEnvironmentDescriptor,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadHistoryPage,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import type { Identity, ProxyAuthGate } from "./auth.ts";
import type { Commands } from "./commands/dispatch.ts";
import { authSessionState } from "./descriptor.ts";
import type { Hub } from "./hub.ts";
import {
  hasCompatibleOrchestrationProtocol,
  hasOrchestrationProtocolHeader,
  protocolIncompatibleBody,
} from "./protocol.ts";
import { frameAncestors, isCrossSiteWrite, isSameOriginUpgrade } from "./origin.ts";
import { rpcScopeAuthorization } from "./rpc/authorization.ts";
import { makeHandlers } from "./rpc/handlers.ts";
import type { SequenceClock } from "./sequence.ts";
import type { ConfigContext } from "./serverConfig.ts";

export interface SidecarDeps {
  readonly gate: ProxyAuthGate;
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

function guarded<E, R>(
  gate: ProxyAuthGate,
  handler: (
    identity: Identity,
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return (request: HttpServerRequest.HttpServerRequest) =>
    Effect.flatMap(
      Effect.promise(() => gate.check(request.headers)),
      (decision): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> => {
        if (!decision.ok) {
          return Effect.succeed(
            HttpServerResponse.text(decision.status === 502 ? "lobby unavailable" : "forbidden", {
              status: decision.status,
            }),
          );
        }
        if (isCrossSiteWrite(request.method, request.headers)) {
          return Effect.succeed(HttpServerResponse.text("forbidden", { status: 403 }));
        }
        return handler(decision.identity, request);
      },
    );
}

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
  const { gate } = deps;
  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/.well-known/t3/environment",
      guarded(gate, () =>
        Effect.succeed(schemaJson(ExecutionEnvironmentDescriptor, deps.config.descriptor)),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/.well-known/t3/thread/:key",
      guarded(gate, (identity) =>
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
      "/api/auth/session",
      guarded(gate, () =>
        Effect.sync(() => schemaJson(AuthSessionState, authSessionState(Date.now()))),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/api/orchestration/shell",
      guarded(gate, (identity, request) =>
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
      guarded(gate, (identity, request) =>
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
      "/api/orchestration/threads/:threadId/history",
      guarded(gate, (identity, request) =>
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
      guarded(gate, () => Effect.succeed(HttpServerResponse.empty({ status: 204 }))),
    ),
    HttpRouter.add(
      "GET",
      "/ws",
      guarded(gate, (identity, request) =>
        Effect.gen(function* () {
          if (!isSameOriginUpgrade(request.headers)) {
            return HttpServerResponse.text("forbidden", { status: 403 });
          }
          const url = HttpServerRequest.toURL(request);
          if (Option.isNone(url) || !hasCompatibleOrchestrationProtocol(url.value)) {
            return HttpServerResponse.jsonUnsafe(protocolIncompatibleBody, { status: 426 });
          }
          const upgrade = yield* rpcOverWebSocket(deps, identity);
          return yield* upgrade;
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "*",
      guarded(gate, (identity, request) => {
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
