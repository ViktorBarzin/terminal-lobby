import { batch, createSignal, onCleanup, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { SseClient, type EventSourceLike, type ReadyFrame, type SseStatus } from "../sse/client";
import { agentEarlierUrl, agentEventsUrl, agentResultUrl } from "../lib/config";
import { fetchWithDeadline } from "../lib/http";
import type { Event } from "../types/events";
import {
  EARLIER_STEPS_BYTES,
  mergeById,
  TRANSCRIPT_READ_TIMEOUT_MS,
  type NotifyKind,
} from "./session";

/**
 * One agent's own transcript, `agent-<id>.jsonl`, as the drill-in reads it
 * (design step 6, docs/plans/2026-09-12-agent-workflow-visualisation-design.md).
 *
 * The server serves it with the session stream's framing (session-events
 * drill.go), so this is the session store's read path and nothing else: the
 * history arrives newest first behind a cursor, live events after it, and
 * paging back climbs the same step ladder. What the session store does beyond
 * that has no meaning for an agent. There is no composer, no answer card and
 * no queue, and the window never slides: an agent is one long turn, and its
 * work is what the reader opened it for. Nothing is written to the transcript
 * cache either, which is keyed by session and would take this for the
 * session's own conversation.
 */
export interface AgentStream {
  /** Ordered, one of each id. */
  events: Event[];
  status: Accessor<SseStatus>;
  /** True until the opening exchange has put something on screen, or said
   *  there is nothing to put there. */
  opening: Accessor<boolean>;
  /** False once paging has reached the agent's first record. */
  hasEarlier: Accessor<boolean>;
  /** One step further back. Resolves to how many events arrived. */
  loadEarlier: () => Promise<number>;
  /** One tool result in full, read from the agent's own file. */
  fullResult: (toolId: string) => Promise<string | null>;
  /** Close the stream while nobody is reading, keeping what is held. */
  park: () => void;
  /** Reopen a parked stream from the newest event held. */
  unpark: () => void;
  close: () => void;
}

export interface AgentStreamOptions {
  notify?: (message: string, kind: NotifyKind) => void;
  /** Injected in tests. */
  createSource?: (url: string) => EventSourceLike;
  probeStatus?: (url: string) => Promise<number | null>;
}

export function createAgentStream(
  session: string,
  agent: string,
  opts: AgentStreamOptions = {},
): AgentStream {
  const [events, setEvents] = createStore<Event[]>([]);
  const [status, setStatus] = createSignal<SseStatus>("connecting");
  const [opening, setOpening] = createSignal(true);
  const [hasEarlier, setHasEarlier] = createSignal(true);
  /** Where the next step back begins: the server's, as for a session. */
  let cursor = 0;
  /** How far up the step ladder paging has climbed. */
  let step = 0;
  const seen = new Set<number>();
  const takeFresh = (list: Event[]): Event[] => {
    const out: Event[] = [];
    for (const e of list) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  };

  // Both lanes land once a frame, as the session store's do: an opening burst
  // is hundreds of events, and each store write re-derives the rows.
  let backfill: Event[] = [];
  let pending: Event[] = [];
  let flushHandle = 0;
  const flush = (): void => {
    flushHandle = 0;
    const painted = backfill.length > 0;
    const arrived = takeFresh([...backfill, ...pending]).sort((a, b) => a.id - b.id);
    backfill = [];
    pending = [];
    if (arrived.length > 0) {
      batch(() => {
        const newest = events.length > 0 ? events[events.length - 1]!.id : 0;
        if (arrived[0]!.id > newest) {
          for (const e of arrived) setEvents(events.length, e);
        } else {
          setEvents((prev) => mergeById(prev, arrived));
        }
      });
    }
    // History comes newest first, so its first batch is the last thing the
    // agent did, and it goes on screen at once.
    if (painted) setOpening(false);
  };
  const scheduleFlush = (): void => {
    if (flushHandle) return;
    flushHandle =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(flush)
        : (setTimeout(flush, 0) as unknown as number);
  };
  const flushNow = (): void => {
    if (flushHandle) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(flushHandle);
      clearTimeout(flushHandle);
    }
    flush();
  };

  /** The stream came back on another file behind the same agent id. */
  const reset = (): void => {
    backfill = [];
    pending = [];
    seen.clear();
    cursor = 0;
    step = 0;
    batch(() => {
      setEvents([]);
      setHasEarlier(true);
      setOpening(true);
    });
  };

  const client = new SseClient({
    session,
    url: (s, lastEventId) => agentEventsUrl(s, agent, lastEventId),
    onReset: reset,
    onEvent: (e) => {
      pending.push(e);
      scheduleFlush();
    },
    onBackfill: (e) => {
      backfill.push(e);
      scheduleFlush();
    },
    onStatus: (s) => {
      // A 404 is an agent this session does not list. No `ready` will come,
      // and the view says so instead of loading for ever.
      if (s === "no-transcript") setOpening(false);
      setStatus(s);
    },
    onReady: (r: ReadyFrame) => {
      // What has arrived goes on screen before the opening is declared over,
      // so an agent with history never flashes as an empty one.
      flushNow();
      if (typeof r.cursor === "number") {
        cursor = r.cursor;
        setHasEarlier(cursor > 0);
      }
      setOpening(false);
    },
    ...(opts.createSource ? { createSource: opts.createSource } : {}),
    ...(opts.probeStatus ? { probeStatus: opts.probeStatus } : {}),
  });

  let closed = false;
  let parked = false;

  const park = (): void => {
    if (closed || parked) return;
    parked = true;
    flushNow();
    client.close();
  };
  const unpark = (): void => {
    if (closed || !parked) return;
    parked = false;
    client.start();
  };
  const close = (): void => {
    closed = true;
    flushNow();
    client.close();
  };

  const loadEarlier = async (): Promise<number> => {
    const before = cursor > 0 ? cursor : (events[0]?.id ?? 0);
    if (before <= 1) {
      setHasEarlier(false);
      return 0;
    }
    const ask = EARLIER_STEPS_BYTES[Math.min(step, EARLIER_STEPS_BYTES.length - 1)]!;
    try {
      const res = await fetchWithDeadline(
        agentEarlierUrl(session, agent, before, ask),
        undefined,
        TRANSCRIPT_READ_TIMEOUT_MS,
      );
      if (!res.ok) return 0;
      const body = (await res.json()) as { events?: Event[]; cursor?: number } | null;
      const older = body?.events ?? [];
      if (typeof body?.cursor === "number") cursor = body.cursor;
      if (older.length === 0 || body?.cursor === 0) setHasEarlier(false);
      const fresh = takeFresh(older);
      if (fresh.length > 0) setEvents((prev) => mergeById(prev, fresh));
      step++;
      return fresh.length;
    } catch {
      opts.notify?.("Couldn't load this agent's earlier steps", "error");
      return 0;
    }
  };

  const fullResult = async (toolId: string): Promise<string | null> => {
    try {
      const res = await fetchWithDeadline(
        agentResultUrl(session, agent, toolId),
        undefined,
        TRANSCRIPT_READ_TIMEOUT_MS,
      );
      if (!res.ok) {
        opts.notify?.("That output is no longer in the transcript", "warning");
        return null;
      }
      const body = (await res.json()) as { body?: string };
      return body.body ?? "";
    } catch {
      opts.notify?.("Couldn't load the full output", "error");
      return null;
    }
  };

  client.start();
  onCleanup(close);

  return {
    events,
    status,
    opening,
    hasEarlier,
    loadEarlier,
    fullResult,
    park,
    unpark,
    close,
  };
}
