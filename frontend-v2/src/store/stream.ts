import type { Event, StreamDelta } from "../types/events";

/**
 * The reply Claude is writing right now, block by block, from the mod's
 * `delta` frames (ADR-0036).
 *
 * Pure and immutable: every function returns the state it was given when
 * nothing changed, so a signal holding it notifies only on real change. The
 * store folds deltas and events through here in arrival order and publishes
 * the result once per frame, alongside the events that supersede it.
 *
 * Only the main thread streams into the timeline. A subagent's deltas are
 * dropped: its work is read from its own transcript in the drill-in.
 */

export interface StreamBlock {
  stream: StreamDelta["stream"];
  /** The content block's index within the current model response. */
  block: number;
  body: string;
}

export interface StreamState {
  /** The mod's turn id for the blocks held, "" when nothing streams. */
  turnId: string;
  /** In block order. */
  blocks: readonly StreamBlock[];
}

export const NO_STREAM: StreamState = { turnId: "", blocks: [] };

/** Append one delta to its block. A delta from a new turn starts over. */
export function applyDelta(s: StreamState, d: StreamDelta): StreamState {
  if (d.agentId || !d.body) return s;
  const base = d.turnId === s.turnId ? s.blocks : [];
  const at = base.findIndex((b) => b.block === d.block && b.stream === d.stream);
  let blocks: StreamBlock[];
  if (at >= 0) {
    blocks = base.slice();
    blocks[at] = { ...base[at]!, body: base[at]!.body + d.body };
  } else {
    const added: StreamBlock = { stream: d.stream, block: d.block, body: d.body };
    const after = base.findIndex((b) => b.block > d.block);
    blocks = after < 0 ? [...base, added] : [...base.slice(0, after), added, ...base.slice(after)];
  }
  return { turnId: d.turnId, blocks };
}

/**
 * What a stored event leaves of the stream.
 *
 * The stored `text` supersedes the streamed text and the stored `thinking` the
 * streamed thinking. A `tool_use` ends the response, so whatever it streamed
 * is stored by then. A turn end closes everything: only one main-thread turn
 * is open at a time, so it is that one whatever turn id the stored log uses.
 */
export function afterEvent(s: StreamState, e: Event): StreamState {
  if (s.blocks.length === 0 && s.turnId === "") return s;
  if (e.agentId || e.sidechain) return s;
  switch (e.kind) {
    case "text":
    case "thinking":
      return without(s, e.kind);
    case "tool_use":
      return s.blocks.length === 0 ? s : { turnId: s.turnId, blocks: [] };
    case "turn_end":
      return NO_STREAM;
    default:
      return s;
  }
}

function without(s: StreamState, stream: StreamBlock["stream"]): StreamState {
  if (!s.blocks.some((b) => b.stream === stream)) return s;
  return { turnId: s.turnId, blocks: s.blocks.filter((b) => b.stream !== stream) };
}

/**
 * Below every id a pending prompt can take (they count down from -1), so a
 * stand-in can never share a row key with one.
 */
const STREAM_ID_BASE = -1_000_000_000;

/** The stand-in event id for one block: stable while the block grows, so its
 *  row keeps its key and only its body re-renders. */
export function streamId(b: Pick<StreamBlock, "stream" | "block">): number {
  return STREAM_ID_BASE - (b.block * 2 + (b.stream === "thinking" ? 1 : 0));
}

/**
 * One stand-in event per block, for the row derivation.
 *
 * No body and no turn id. The body is read live by id (`streamBody`), so a
 * growing block does not re-derive the timeline. Without a turn id the stand-in
 * joins the turn the stored events are in, whatever ids they carry.
 */
export function streamEvents(s: StreamState, session: string): Event[] {
  return s.blocks.map((b) => ({
    id: streamId(b),
    kind: b.stream,
    session,
    body: "",
    streaming: true,
  }));
}

/**
 * The turn key a reply streamed after the main thread's turn ended is drawn
 * under, until the stored row arrives with the server's own id.
 */
const STREAM_TURN = "streaming";

/**
 * Whether the main thread's last turn has ended: a turn_end comes after its
 * last word. A subagent's work and the harness's status lines (an agent
 * finishing) arrive after the end without reopening it.
 */
function mainTurnEnded(events: Event[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.sidechain || e.agentId) continue;
    switch (e.kind) {
      case "turn_end":
        return true;
      case "user":
      case "text":
      case "thinking":
      case "tool_use":
      case "tool_result":
        return false;
    }
  }
  return false;
}

/**
 * The events with the stream's stand-ins after them; `events` itself when
 * nothing streams.
 *
 * A reply with no prompt in front of it, which is how the main thread answers
 * a background agent finishing, streams while the last turn has already ended.
 * Joined to that turn, its words were drawn inside the settled group, then
 * jumped to a turn of their own when the stored row landed (2026-10-03). They
 * open a turn of their own from the first word instead.
 */
export function withStreaming(events: Event[], s: StreamState): Event[] {
  if (s.blocks.length === 0) return events;
  const own = mainTurnEnded(events);
  const stand = streamEvents(s, events[0]?.session ?? "");
  return [...events, ...(own ? stand.map((e) => ({ ...e, turnId: STREAM_TURN })) : stand)];
}

/** What a stand-in's block holds right now, "" once it has gone. */
export function streamBody(s: StreamState, id: number): string {
  for (const b of s.blocks) if (streamId(b) === id) return b.body;
  return "";
}

/** Same blocks, whatever their bodies: the derivation's equality. */
export function sameShape(a: StreamState, b: StreamState): boolean {
  if (a === b) return true;
  if (a.blocks.length !== b.blocks.length) return false;
  return a.blocks.every(
    (x, i) => x.block === b.blocks[i]!.block && x.stream === b.blocks[i]!.stream,
  );
}
