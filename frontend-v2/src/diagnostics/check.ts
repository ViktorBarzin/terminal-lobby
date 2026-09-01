/**
 * Run check — exercise each channel on demand and say what came back.
 *
 * Passive state answers "what is happening now". It cannot answer "is push
 * broken?", because a push subscription looks healthy right up until nothing
 * arrives, and it cannot tell a quiet channel from a dead one. That is what
 * this is for.
 *
 * THREE RULES, all of them learned from the link this app exists to survive.
 *
 * 1. NON-DISRUPTIVE. No probe here touches a live connection. They read state
 *    and make their own throwaway requests, so the broken state someone came to
 *    look at is still on screen after they press the button. Repairing is a
 *    separate, explicitly tapped action.
 * 2. PARALLEL, AND EACH ROW LANDS ON ITS OWN. Every probe starts together and
 *    is reported the moment it finishes, so a dead channel reads "timed out"
 *    while the others have already answered. Serialised, the same check costs
 *    20-25s on a bad link and people stop waiting for it.
 * 3. CAPPED. The signature of a half-open mobile network is a request that
 *    never settles; one of those must not hold the other four. Five seconds
 *    matches the cap the SSE client already puts on its own probe.
 */

import { SESSION_CHANNELS, type Channel, type ChannelId, type ChannelState } from "./status";

/** Matches PROBE_TIMEOUT_MS in sse/client.ts, for the same reason. */
export const CHECK_TIMEOUT_MS = 5000;

export interface CheckProbe {
  id: ChannelId;
  /** Read this channel without disturbing it. Must honour the abort signal. */
  run(signal: AbortSignal): Promise<Channel>;
  /**
   * What a timeout MEANS for this channel. Defaults to `down` — no answer in
   * five seconds is a fault for anything that answers over the network. A
   * channel whose silence means something softer overrides it: the terminal
   * iframe not replying means it is not reporting, not that the socket died.
   */
  timeoutState?: ChannelState;
  timeoutDetail?: string;
}

export interface CheckOutcome {
  id: ChannelId;
  state: ChannelState;
  detail: string;
  /** how long this probe took, in ms. */
  ms: number;
}

export interface RunCheckOptions {
  timeoutMs?: number;
  now?: () => number;
}

function message(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const s = String(err ?? "");
  return s || "failed";
}

/**
 * Run every probe, reporting each through `onResult` as it lands, and resolve
 * with all of them in row order.
 *
 * Row order for the return value and completion order for the callback are both
 * deliberate: the panel repaints one row at a time as answers arrive, and the
 * telemetry record wants a stable field order.
 */
export async function runCheck(
  probes: readonly CheckProbe[],
  onResult: (r: CheckOutcome) => void,
  opts: RunCheckOptions = {},
): Promise<CheckOutcome[]> {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());

  const settled = await Promise.all(
    probes.map(async (p) => {
      const started = now();
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<Channel>((resolve) => {
        timer = setTimeout(() => {
          // Abort first: a probe we have stopped waiting for must not keep a
          // request, a listener or a socket alive behind the panel.
          ac.abort();
          resolve({
            id: p.id,
            state: p.timeoutState ?? "down",
            detail: p.timeoutDetail ?? "timed out",
          });
        }, timeoutMs);
      });

      let row: Channel;
      try {
        row = await Promise.race([p.run(ac.signal), timeout]);
      } catch (err) {
        row = { id: p.id, state: "down", detail: message(err) };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      const out: CheckOutcome = {
        id: row.id,
        state: row.state,
        detail: row.detail,
        ms: Math.max(0, Math.round(now() - started)),
      };
      onResult(out);
      return out;
    }),
  );

  // Sorted by the canonical row order rather than the order the caller happened
  // to build its probes in, so the returned list matches the panel top to
  // bottom and the telemetry record has a stable field order.
  return settled
    .slice()
    .sort((a, b) => SESSION_CHANNELS.indexOf(a.id) - SESSION_CHANNELS.indexOf(b.id));
}
