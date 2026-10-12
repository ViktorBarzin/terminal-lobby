/**
 * RpcScopeAuthorization for the sidecar's WebSocket: T3's own server
 * implementation (apps/server/src/auth/RpcAuthorization.ts at the pin), which
 * holds the required scope of every RPC in WsRpcGroup and is typed to cover
 * all of them, applied to the scopes /api/auth/session grants. That file
 * imports only contracts and effect, so reusing it keeps the per-RPC table in
 * T3's hands: a pin bump brings T3's current table with it.
 *
 * With GRANTED_SCOPES, terminal RPCs and source-control writes fail with
 * EnvironmentAuthorizationError before any handler runs. Each refusal is
 * logged with the RPC's tag, so the journal shows what the client asked for
 * and was denied.
 */
import { EnvironmentAuthorizationError, RpcScopeAuthorization } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layer as t3RpcAuthorization } from "t3/src/auth/RpcAuthorization.ts";

import { GRANTED_SCOPES } from "../descriptor.ts";

export const rpcScopeAuthorization = Layer.effect(RpcScopeAuthorization)(
  Effect.gen(function* () {
    const authorize = yield* RpcScopeAuthorization;
    return RpcScopeAuthorization.of((effect, options) =>
      authorize(effect, options).pipe(
        Effect.tapError((error) =>
          error instanceof EnvironmentAuthorizationError
            ? Effect.logWarning(`refused ${options.rpc._tag}: ${error.message}`)
            : Effect.void,
        ),
      ),
    );
  }),
).pipe(Layer.provide(t3RpcAuthorization(GRANTED_SCOPES)));
