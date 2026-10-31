/**
 * Prompt requests that got no answer.
 *
 * Reported by Viktor on 2026-10-31: offline on a phone, a send failed and the
 * composer put the words back, but back online the message had been sent, so
 * the field held words Claude already had. A request that fails on the wire (a
 * dropped connection, or the deadline in lib/http.ts running out) says nothing
 * about whether the server took the prompt: the radio can lose the response
 * after the request went out. A refusal the server answers is different, it
 * said no.
 *
 * The session store notes each unanswered prompt with a promise that settles if
 * the session turns out to have it (store/session.ts). The composer that put the
 * words back takes that promise, by the text it sent, and empties the field
 * when it settles, provided the field still holds what it put back. The words
 * come back at once, as before, because most of the time they really did not
 * go. Same shape as lib/leaving.ts.
 */
const waiting = new Map<string, Promise<void>>();

/** A request for `text` got no answer; `landed` settles if the session has it. */
export function noteUnanswered(text: string, landed: Promise<void>): void {
  waiting.set(text, landed);
}

/** The promise noted for `text`, once, or undefined when its request was answered. */
export function takeUnanswered(text: string): Promise<void> | undefined {
  const landed = waiting.get(text);
  waiting.delete(text);
  return landed;
}
