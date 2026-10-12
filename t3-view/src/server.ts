/**
 * The sidecar's HTTP surface: the T3 web build at /, the handful of HTTP
 * routes the client calls, and Effect RPC on /ws.
 *
 * Every route goes through `guarded`, which runs the auth gate (auth.ts)
 * before anything else, so an unauthenticated caller learns nothing, not even
 * whether a path exists or which protocol version the sidecar speaks. The
 * WebSocket upgrade is a GET to /ws and takes the same path.
 *
 * Routes:
 *   GET  /.well-known/t3/environment   environment descriptor (protocol 2)
 *   GET  /api/auth/session             authenticated, chat scopes only
 *   GET  /api/orchestration/shell      shell snapshot; needs the protocol header
 *   POST /api/observability/v1/traces  204: the client posts traces unconditionally
 *   GET  /ws?orchestrationProtocol=2   Effect RPC (WsRpcGroup), JSON frames; 426 on mismatch
 *   GET  *                             the web build, index.html for app routes
 */
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthSessionState,
  ExecutionEnvironmentDescriptor,
  OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellSnapshot as ShellSnapshot,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import type { Identity, ProxyAuthGate } from "./auth.ts";
import { authSessionState } from "./descriptor.ts";
import {
  hasCompatibleOrchestrationProtocol,
  hasOrchestrationProtocolHeader,
  protocolIncompatibleBody,
} from "./protocol.ts";
import { rpcScopeAuthorization } from "./rpc/authorization.ts";
import { makeHandlers } from "./rpc/handlers.ts";
import type { SequenceClock } from "./sequence.ts";
import type { ConfigContext } from "./serverConfig.ts";

export interface SidecarDeps {
  readonly gate: ProxyAuthGate;
  readonly webDir: string;
  readonly config: ConfigContext;
  readonly clock: SequenceClock;
  readonly shell: (identity: Identity) => Effect.Effect<ShellSnapshot>;
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
      (decision): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R> =>
        decision.ok
          ? handler(decision.identity, request)
          : Effect.succeed(
              HttpServerResponse.text(decision.status === 502 ? "lobby unavailable" : "forbidden", {
                status: decision.status,
              }),
            ),
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

function rpcOverWebSocket(deps: SidecarDeps, identity: Identity) {
  const handlers = WsRpcGroup.toLayer(
    makeHandlers({ identity, config: deps.config, clock: deps.clock, shell: deps.shell }),
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
          ? Effect.map(deps.shell(identity), (snapshot) =>
              schemaJson(OrchestrationV2ShellSnapshot, snapshot),
            )
          : Effect.succeed(
              HttpServerResponse.jsonUnsafe(protocolIncompatibleBody, { status: 400 }),
            ),
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
      guarded(gate, (_identity, request) => {
        const url = HttpServerRequest.toURL(request);
        return Option.isNone(url)
          ? Effect.succeed(HttpServerResponse.text("bad request", { status: 400 }))
          : serveWebBuild(deps.webDir, url.value.pathname);
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
