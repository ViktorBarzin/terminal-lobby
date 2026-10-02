import { modeFromPane } from "../logic/compose.logic";
import { promptUrl } from "./config";
import { fetchWithDeadline } from "./http";
import type { ModelHarness } from "./models";

/**
 * Delivering the first prompt of a session the composer just created.
 *
 * This is not the same job as sending a prompt to a session someone is looking
 * at. Two things are true only here, and both were measured against Claude Code
 * 2.1.260 on 2026-09-04:
 *
 * 1. The session may not exist yet. Creating one reaches no server — the
 *    browser mints the id and ttyd's `tmux new-session -A` brings it into being
 *    when the terminal's WebSocket attaches (ADR-0019) — so the first POST can
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
 * input box (its `❯` under the box's rule) and then hold still for 300ms,
 * which is the same check the T3 bridge already runs after a resurrection,
 * for the same reason. Nothing about a pane's input line reaches the browser,
 * so a browser-side version of this could only ever be a proxy for it.
 *
 * Claude's folder-trust dialog, raised on its first start in a repository
 * nobody has trusted, draws a `❯` of its own on "No, exit". The server
 * refuses a prompt while it is up ("trust-open"), and the caller is told the
 * reason (`onRefused`).
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
 * Pi's ladder: Claude's four rungs, then more, about 76s of waiting in all.
 *
 * Pi loads every extension the person installed before it takes input, and a
 * large one is slow: 8s on a quiet devvm with pi-fabric installed, 49s on a
 * loaded one (2026-09-26). The server's wait answers the moment pi is ready,
 * so the extra rungs cost nothing on a fast start.
 */
export const PI_FIRST_PROMPT_LADDER: readonly number[] = [
  ...FIRST_PROMPT_LADDER,
  10_000,
  15_000,
  20_000,
  20_000,
];

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
   * pane drawing Claude's input box and then holding still — so it reads the input
   * line rather than guessing from anything the browser can see.
   *
   * Only for a command that draws something the server can wait on, which is
   * Claude, pi and codex (see `firstPromptDelivery`). Asking for it where nothing will
   * ever draw one would spend every rung waiting and then give up with the text
   * unsent, so a caller starting something else leaves this off and takes the
   * ladder alone.
   */
  awaitReady?: boolean;
  /**
   * Which harness the session runs, for a server that has to know. Absent is
   * Claude, which is what session-events has always assumed; pi and codex say
   * so, because the wait reads a different thing off their panes.
   */
  tool?: FirstPromptTool;
  ladder?: readonly number[];
  gapMs?: number;
  /** injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** injectable for tests; defaults to a deadlined same-origin fetch. */
  fetchImpl?: typeof fetch;
  /** Told the reason of a 409 refusal ("trust-open", session-events
   *  refusal.go), which ends the delivery. */
  onRefused?: (reason: string) => void;
}

/**
 * What a send refused over Claude's folder-trust dialog tells the reader
 * (session-events "trust-open"). Claude raises it on its first start in a
 * folder nobody has trusted, no card answers it, and a prompt's Enter there
 * picked "No, exit" and ended the session (deployed review round 4,
 * 2026-09-28).
 */
export const TRUST_NOTICE =
  "Claude is asking whether to trust this folder. Answer it in the Terminal, then send again.";

/**
 * Whether a pane shows Claude's folder-trust dialog: its two rows, and no
 * status line under an input box, which a conversation quoting the rows would
 * have. The same reading as session-events' (sessionio ClaudeTrustPending).
 */
export function trustDialogUp(pane: string): boolean {
  if (!pane.includes("No, exit") || !pane.toLowerCase().includes("trust this folder")) return false;
  return modeFromPane(pane) === "";
}

/** The harnesses a first prompt names for the server's wait. */
export type FirstPromptTool = "pi" | "codex";

/**
 * How the first prompt of a session running harness `h` asks to be delivered
 * (null for a command that is not a harness).
 *
 * Claude, pi and codex all draw something the server can wait for, so all
 * three ask for the wait. What they draw differs: Claude's input line shows
 * its `❯`, pi sets its pane title to `π - …` once startup and any "Trust
 * project folder?" question are over, and codex draws `›` at its input line
 * (and as the cursor of its menus, which the server tells apart). So pi's and
 * codex's prompts name the harness, and Claude's leaves the field out, which
 * the server has always read as Claude.
 *
 * Codex asked for no wait until the deployed review on 2026-09-28 found its
 * first prompt left unsent on the input line: posted blind 700 ms in, its
 * Enter was lost while codex started, 2 times in 2.
 */
export function firstPromptDelivery(h: ModelHarness | null): {
  awaitReady: boolean;
  tool?: FirstPromptTool;
} {
  switch (h) {
    case "claude":
      return { awaitReady: true };
    case "pi":
      return { awaitReady: true, tool: "pi" };
    case "codex":
      return { awaitReady: true, tool: "codex" };
    case null:
      return { awaitReady: false };
  }
}

/** What one POST /prompt means for whether to try again. */
type Attempt = "ok" | "later" | "no";

async function post(
  session: string,
  text: string,
  awaitReady: boolean,
  tool: FirstPromptTool | undefined,
  fetchImpl: typeof fetch,
  onRefused?: (reason: string) => void,
): Promise<Attempt> {
  try {
    const res = await fetchImpl(promptUrl(session), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tool ? { text, awaitReady, tool } : { text, awaitReady }),
      credentials: "same-origin",
    });
    if (res.ok) return "ok";
    if (res.status === 409 && onRefused) {
      const reason = await refusalReason(res);
      if (reason) onRefused(reason);
    }
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

/** The reason in a 409 refusal's `{"applied": false, "reason": ...}`, or "". */
async function refusalReason(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    return typeof body === "object" &&
      body !== null &&
      "reason" in body &&
      typeof body.reason === "string"
      ? body.reason
      : "";
  } catch {
    return "";
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
 *
 * Pi is the exception, and keeps the wait to the end of its own, longer
 * ladder. Text typed before pi owns the terminal is echoed by the tty, whose
 * line discipline turns Enter into a line feed, and pi's editor reads a line
 * feed as a new line, so a blind send leaves the prompt unsent in pi's input
 * box. Giving up instead parks the text in the session's composer.
 *
 * Codex keeps the wait to the end too: a codex that never showed its input
 * line is on a menu, and a blind prompt plus Enter picks the menu's
 * highlighted row.
 */
export async function deliverFirstPrompt(o: DeliverFirstPromptOptions): Promise<boolean> {
  const lines = o.lines.filter((l) => l !== "");
  if (lines.length === 0) return true;

  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Deadlined like every other request the lobby makes: a phone whose radio
  // drops a socket without an RST leaves a bare fetch pending forever, and this
  // one is awaited by a routine nobody is watching. The default comfortably
  // clears the server's own hold (session-events PromptReadyWait, 4s).
  const fetchImpl =
    o.fetchImpl ?? ((input, init) => fetchWithDeadline(String(input), init ?? undefined));
  const pi = o.tool === "pi";
  const waitToTheEnd = pi || o.tool === "codex";
  const ladder = o.ladder ?? (pi ? PI_FIRST_PROMPT_LADDER : FIRST_PROMPT_LADDER);
  const gapMs = o.gapMs ?? LINE_GAP_MS;

  let sent = 0;
  for (let rung = 0; rung < ladder.length; rung++) {
    await sleep(ladder[rung]!);
    const wait = (o.awaitReady ?? false) && (waitToTheEnd || rung < ladder.length - 1);
    while (sent < lines.length) {
      const r = await post(o.session, lines[sent]!, wait, o.tool, fetchImpl, o.onRefused);
      if (r === "no") return false;
      if (r === "later") break; // next rung, resuming at this line
      sent += 1;
      if (sent < lines.length) await sleep(gapMs);
    }
    if (sent === lines.length) return true;
  }
  return false;
}
