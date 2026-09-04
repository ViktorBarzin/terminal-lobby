import { promptUrl } from "./config";

/**
 * Delivering the first prompt of a session the composer just created.
 *
 * This is not the same job as sending a prompt to a session someone is looking
 * at. Two things are true only here, and both were measured against Claude Code
 * 2.1.260 on 2026-09-04:
 *
 * 1. The session may not exist yet. Creating one reaches no server — the
 *    browser mints the id and ttyd's `tmux new-session -A` brings it into being
 *    when the terminal iframe attaches (ADR-0019) — so the first POST can
 *    arrive before there is anything to inject into. session-events runs no
 *    registry lookup on POST /prompt, so that failure happens inside `tmux
 *    send-keys` and comes back as 502, not 404.
 *
 * 2. REACHABLE is not READY. A session tmux has created accepts send-keys
 *    immediately, while the Claude in its pane takes another ~2s to draw its
 *    input. Text injected into that gap is dropped: the POST returns 204, tmux
 *    exits 0, and nothing reaches the conversation. Measured by injecting
 *    `/model sonnet` at fixed offsets from creation — lost at +0s and +1s,
 *    landed at +2s and +3s, with no error at any offset.
 *
 * So delivery walks a ladder, and asks the SERVER to hold each attempt until
 * the pane can take it. The readiness check lives there because that is where
 * the evidence is: `sessionio.AwaitInputReady` watches the pane draw Claude's
 * own `❯` and then hold still for 300ms, which is the same check the T3 bridge
 * already runs after a resurrection, for the same reason. Nothing about a
 * pane's input line reaches the browser, so a browser-side version of this
 * could only ever be a proxy for it.
 */

/**
 * The ladder a first prompt retries on, in ms of wait BEFORE each attempt.
 *
 * The same rungs `store.stampTitleWhenAlive` and `quickRefreshBurst` use, for
 * the same reason: they are how long it takes a just-created session to show
 * up. 11.3s in total.
 */
export const FIRST_PROMPT_LADDER: readonly number[] = [700, 1600, 3000, 6000];

/**
 * The gap between two lines sent back to back.
 *
 * Injecting is four tmux commands (clear the input line, set the buffer, paste
 * it, Enter) and the second line's clear can reach the pane while the first is
 * still being applied. Measured back to back with no gap on a session still
 * settling after boot, the FIRST line was the one lost.
 *
 * Mostly redundant when `awaitReady` is on, since the server's own check makes
 * the second line wait for the pane to settle after the first repainted it —
 * measured live, that hold was 662ms. Kept for the case it does not cover, and
 * it costs a quarter second on a path that already spends seconds.
 */
export const LINE_GAP_MS = 250;

export interface DeliverFirstPromptOptions {
  /** The session id to address. */
  session: string;
  /** The lines to send, in order. Empty ones are dropped. */
  lines: readonly string[];
  /**
   * Ask the server to wait for the pane to be able to take the text.
   *
   * `session-events` answers 503 rather than injecting when it cannot, which
   * this treats like any other "not yet". The check is `sessionio`'s own — the
   * pane drawing Claude's `❯` and then holding still — so it reads the input
   * line rather than guessing from anything the browser can see.
   *
   * Only for a command that draws that prompt, which is Claude. Asking for it
   * where nothing will ever draw one would spend every rung waiting and then
   * give up with the text unsent, so a caller starting something else leaves
   * this off and takes the ladder alone.
   */
  awaitReady?: boolean;
  ladder?: readonly number[];
  gapMs?: number;
  /** injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** injectable for tests; defaults to window.fetch. */
  fetchImpl?: typeof fetch;
}

/** What one POST /prompt means for whether to try again. */
type Attempt = "ok" | "later" | "no";

async function post(
  session: string,
  text: string,
  awaitReady: boolean,
  fetchImpl: typeof fetch,
): Promise<Attempt> {
  try {
    const res = await fetchImpl(promptUrl(session), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, awaitReady }),
      credentials: "same-origin",
    });
    if (res.ok) return "ok";
    // Three ways of saying "not yet". 503 is the pane not ready, which is the
    // answer `awaitReady` asks for. 502 is what a session tmux cannot find
    // answers, because the injection — not a lookup — is what fails. 404 is
    // covered for a proxy that answers ahead of the route. Everything else (400
    // for an empty body, an auth refusal) would produce the same answer again.
    const later = res.status === 503 || res.status === 502 || res.status === 404;
    return later ? "later" : "no";
  } catch {
    return "later"; // a blip on the way out, not a refusal
  }
}

/**
 * Send the lines that start a session, waiting for it to be able to take them.
 *
 * Resolves true once every line has landed. A refusal that will not get better
 * stops immediately; anything that reads as "not yet" waits for the next rung
 * and RESUMES at the line that did not land, so a line already delivered is
 * never sent twice — a repeated `/model sonnet` would be a second visible
 * command in someone's pane.
 *
 * The LAST rung asks for no readiness wait. By then the ladder has spent 11s,
 * and a pane that has not drawn a prompt in that time is one that never will —
 * a Claude that crashed at launch, or something else entirely in the pane. The
 * text is better sent there than dropped, and it is the operator who can see
 * both.
 */
export async function deliverFirstPrompt(
  o: DeliverFirstPromptOptions,
): Promise<boolean> {
  const lines = o.lines.filter((l) => l !== "");
  if (lines.length === 0) return true;

  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = o.fetchImpl ?? fetch;
  const ladder = o.ladder ?? FIRST_PROMPT_LADDER;
  const gapMs = o.gapMs ?? LINE_GAP_MS;

  let sent = 0;
  for (let rung = 0; rung < ladder.length; rung++) {
    await sleep(ladder[rung]!);
    const wait = (o.awaitReady ?? false) && rung < ladder.length - 1;
    while (sent < lines.length) {
      const r = await post(o.session, lines[sent]!, wait, fetchImpl);
      if (r === "no") return false;
      if (r === "later") break; // next rung, resuming at this line
      sent += 1;
      if (sent < lines.length) await sleep(gapMs);
    }
    if (sent === lines.length) return true;
  }
  return false;
}
