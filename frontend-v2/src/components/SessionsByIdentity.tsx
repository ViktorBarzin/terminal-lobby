import { createMemo, For, type Accessor, type JSX } from "solid-js";
import { sessionKey } from "../store/keepalive";
import type { Session } from "../types/lobby";

/**
 * One row per session, keyed by its identity (store/keepalive.ts `keyOf`)
 * rather than by the row object.
 *
 * The rows change object twice in a new session's first seconds: when the
 * first poll replaces the optimistic card with the server's row, and when the
 * first title renames the session (ADR-0022). A `<For>` over the objects read
 * each as a new session and rebuilt its card. Keyed by birth name, the card is
 * built once and its row is handed over through the accessor.
 */
export function SessionsByIdentity(props: {
  each: readonly Session[];
  me: string;
  children: (session: Accessor<Session>) => JSX.Element;
}): JSX.Element {
  const byKey = createMemo(() => new Map(props.each.map((s) => [sessionKey(s, props.me), s] as const)));
  const keys = createMemo(() => [...byKey().keys()]);
  return (
    <For each={keys()}>
      {(key) => {
        // The last row seen, for the moment between the list dropping this
        // session and <For> disposing its card.
        const session = createMemo<Session>((prev) => byKey().get(key) ?? prev, byKey().get(key)!);
        return props.children(session);
      }}
    </For>
  );
}
