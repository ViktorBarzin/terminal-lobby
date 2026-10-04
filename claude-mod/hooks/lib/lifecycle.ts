// What session.end means for the link. Everything outside is injected.
//
// A /clear or a resume ends the conversation and the process goes on under
// another (claude-code.d.ts, SessionEndReason), so the mod must keep talking
// for the new one; stopping the link there left a resumed conversation with
// no status for the rest of the process (L-F1). Any other reason is the
// process going.

export type EndDeps = {
  bye: (reason: string, sid: string) => void;
  // Resolves once the queue is posted, or after a deadline.
  drain: () => Promise<void>;
  // Forgets what belonged to the conversation that ended.
  forget: () => void;
  // Says hello again once the session id is no longer `endedSid`: the engine
  // still answers the old id for a moment after its end step (measured
  // 2026-10-04: ~500 ms after `next` returned).
  rehello: (endedSid: string) => void;
  stop: () => void;
};

export function continuesAfter(reason: string): boolean {
  return reason === 'clear' || reason === 'resume';
}

export async function endSession<R>(deps: EndDeps, e: { reason: string; sessionId: string }, next: () => Promise<R>): Promise<R> {
  try {
    deps.bye(e.reason, e.sessionId);
    await deps.drain();
  } catch {
    // The session ends either way.
  }
  if (!continuesAfter(e.reason)) {
    deps.stop();
    return next();
  }
  const r = await next();
  deps.forget();
  deps.rehello(e.sessionId);
  return r;
}
