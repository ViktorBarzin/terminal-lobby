/**
 * The transport every call in the app goes through.
 *
 * Two things belong to the wire rather than to any one endpoint, and both were
 * being restated (or forgotten) per call site: the deadline, and same-origin
 * credentials. Twenty-two fetches across the session store, the file and skills
 * clients, push and the gallery carried neither, so any of them could hang for
 * good — the caller's catch never running, the UI stuck mid-action.
 */

/**
 * How long any tmux-api call may take before it is abandoned.
 *
 * Without a deadline a fetch on a half-open connection never settles at all —
 * which is exactly what a phone hands us when the radio drops a socket without
 * an RST. The promise stays pending forever, and every caller awaiting it stays
 * with it: the lobby's poll simply stops producing polls, showing a stale list
 * and no error to explain it. 8s is past the p99 of these endpoints (all of
 * them are a tmux shell-out or a small JSON file) while still well inside the
 * poll's own 5s-and-backing-off cadence.
 */
export const REQUEST_TIMEOUT_MS = 8000;

/**
 * The signal a request runs under: a timeout deadline, merged with the caller's
 * own signal when it has one, so neither can be lost by adding the other.
 *
 * Merged by hand rather than with `AbortSignal.any`, which reached Safari only
 * in 17.4 — too new to put in the path of every lobby call on a phone (and
 * jsdom has yet to ship it either). Exported for testing.
 */
export function withDeadline(ms: number, caller?: AbortSignal | null): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  if (!caller) return deadline;
  const merged = new AbortController();
  const forward = (from: AbortSignal) => merged.abort(from.reason);
  if (caller.aborted) forward(caller);
  else if (deadline.aborted) forward(deadline);
  else {
    caller.addEventListener("abort", () => forward(caller), { once: true });
    deadline.addEventListener("abort", () => forward(deadline), { once: true });
  }
  return merged.signal;
}

/**
 * fetch with a deadline and same-origin credentials.
 *
 * `signal` goes after the caller's init on purpose: a caller's own signal is
 * merged into the deadline by withDeadline, never dropped by it. `credentials`
 * goes before, so a caller can still choose something else.
 */
export function fetchWithDeadline(
  input: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, {
    credentials: "same-origin",
    ...init,
    signal: withDeadline(timeoutMs, init?.signal),
  });
}
