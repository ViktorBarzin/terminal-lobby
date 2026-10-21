/**
 * What an RPC the sidecar does not serve answers (stubs.ts maps every such
 * RPC to one of these).
 *
 * - A unary RPC dies with "tl-t3-view does not serve <tag>", the same shape
 *   T3's own server gives for an unknown tag ("Unknown request tag").
 * - A subscription stays open and silent. The client re-raises any failure a
 *   subscription ends with that is not one of its expected errors
 *   (client-runtime/src/rpc/client.ts), so a stream must never die.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const unavailable = (
  _payload: unknown,
  options: { readonly rpc: { readonly _tag: string } },
): Effect.Effect<never> =>
  Effect.logWarning(`does not serve ${options.rpc._tag}`).pipe(
    Effect.andThen(Effect.die(`tl-t3-view does not serve ${options.rpc._tag}`)),
  );

export const silentStream = (): Stream.Stream<never> => Stream.never;
