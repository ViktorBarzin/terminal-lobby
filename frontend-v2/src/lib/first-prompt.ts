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
 * So delivery walks a ladder AND waits for a readiness signal, and the caller
 * supplies the signal because only it knows what it started.
 */

/**
 * The glyphs Claude Code puts at the head of the terminal title.
 *
 * Mirrors `claudeTitleGlyphs` in tmux-api/autotitle.go, which strips the same
 * set from a summary before storing it. Here the glyph is read for what its
 * PRESENCE means rather than removed: the title is the shell's own until Claude
 * writes over it, so a glyph at the head is the first thing anyone outside the
 * pane can see that says Claude has drawn its UI.
 */
export const CLAUDE_TITLE_GLYPHS = "·✢✳✶✻✽";

/**
 * The ladder a first prompt retries on, in ms of wait BEFORE each attempt.
 *
 * The same rungs `store.stampTitleWhenAlive` and `quickRefreshBurst` use, for
 * the same reason: they are how long it takes a just-created session to show
 * up. 11.3s in total.
 */
export const FIRST_PROMPT_LADDER: readonly number[] = [700, 1600, 3000, 6000];

/**
 * How long after the readiness signal to wait before injecting.
 *
 * The pane title carries its glyph from ~1.4s after creation and input is
 * accepted from ~1.9s, so the signal arrives slightly ahead of the thing it
 * signals. Sized for the measured gap with room for a loaded box, where every
 * number here stretches: the devvm sat at load 63 on 32 cores during these
 * measurements and the boot markers moved by several hundred ms.
 */
export const CLAUDE_SETTLE_MS = 750;

/**
 * The gap between two lines sent back to back.
 *
 * Injecting is four tmux commands (clear the input line, set the buffer, paste
 * it, Enter) and the second line's clear can reach the pane while the first is
 * still being applied. Measured back to back with no gap on a session still
 * settling after boot, the FIRST line was the one lost. Insurance rather than a
 * measured minimum: on a settled session every gap from 0ms up delivered both.
 */
export const LINE_GAP_MS = 250;

/**
 * Has Claude drawn its UI in this pane?
 *
 * Reading the pane title, which is the only thing about a pane's INSIDE that
 * reaches the browser (tmux-api serves it in every /sessions row). Before
 * Claude writes over it the title is whatever the shell left — the bare
 * hostname on this box — so a leading glyph is the signal.
 *
 * Necessary but not sufficient on its own, which is what CLAUDE_SETTLE_MS
 * covers, and absent entirely when CLAUDE_CODE_DISABLE_TERMINAL_TITLE is set,
 * which is what the ladder's last rung covers.
 */
export function claudeIsUp(paneTitle: string | undefined): boolean {
  const head = paneTitle?.[0];
  return head !== undefined && CLAUDE_TITLE_GLYPHS.includes(head);
}

export interface DeliverFirstPromptOptions {
  /** The session id to address. */
  session: string;
  /** The lines to send, in order. Empty ones are dropped. */
  lines: readonly string[];
  /**
   * Is the session ready to receive? Polled once per rung.
   *
   * Absent means "no opinion", and delivery falls back to the ladder alone —
   * which is what a command with no readiness signal of its own gets.
   */
  ready?: () => boolean;
  ladder?: readonly number[];
  settleMs?: number;
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
  fetchImpl: typeof fetch,
): Promise<Attempt> {
  try {
    const res = await fetchImpl(promptUrl(session), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      credentials: "same-origin",
    });
    if (res.ok) return "ok";
    // 502 is what a session tmux cannot find answers, because the injection —
    // not a lookup — is what fails. 404 is covered for a proxy that answers
    // ahead of the route. Everything else (400 for an empty body, an auth
    // refusal) means trying again would produce the same answer.
    return res.status === 502 || res.status === 404 ? "later" : "no";
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
 * The readiness gate is an optimisation, not a precondition: it is what lets a
 * pre-warmed session take its prompt on the first rung. The last rung sends
 * regardless, so a session that never raises the signal still gets what was
 * typed rather than losing it.
 */
export async function deliverFirstPrompt(
  o: DeliverFirstPromptOptions,
): Promise<boolean> {
  const lines = o.lines.filter((l) => l !== "");
  if (lines.length === 0) return true;

  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = o.fetchImpl ?? fetch;
  const ladder = o.ladder ?? FIRST_PROMPT_LADDER;
  const ready = o.ready ?? (() => true);
  const settleMs = o.settleMs ?? CLAUDE_SETTLE_MS;
  const gapMs = o.gapMs ?? LINE_GAP_MS;

  let sent = 0;
  let settled = false;
  for (let rung = 0; rung < ladder.length; rung++) {
    await sleep(ladder[rung]!);
    const last = rung === ladder.length - 1;
    if (!ready() && !last) continue;
    if (!settled) {
      await sleep(settleMs);
      settled = true;
    }
    while (sent < lines.length) {
      const r = await post(o.session, lines[sent]!, fetchImpl);
      if (r === "no") return false;
      if (r === "later") break; // next rung, resuming at this line
      sent += 1;
      if (sent < lines.length) await sleep(gapMs);
    }
    if (sent === lines.length) return true;
  }
  return false;
}
