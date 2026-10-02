import { createContext, useContext } from "solid-js";

/**
 * How a row Claude is still writing finds its words.
 *
 * A streaming row is derived with an empty body (timeline.logic MessageRow
 * `streaming`), so the derivation runs when a block starts or ends rather
 * than on every delta. The words are read here, by the row's id, from the
 * stream the timeline was handed (store/stream.ts `streamBody`). Only the row
 * that reads them re-renders as they grow.
 */
export const StreamBody = createContext<(id: number) => string>(() => "");

/** A message or thinking row's body: the stored one, or the live one while
 *  the row streams. Call in a component's setup, where context is in scope. */
export function useRowBody(
  row: () => { id: number; body: string; streaming?: true },
): () => string {
  const read = useContext(StreamBody);
  return () => {
    const r = row();
    return r.streaming ? read(r.id) : r.body;
  };
}
