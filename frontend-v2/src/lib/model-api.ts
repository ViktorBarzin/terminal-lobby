import { modelUrl } from "./config";
import { fetchWithDeadline } from "./http";
import { FIRST_PROMPT_LADDER } from "./first-prompt";
import type { ModelHarness, ModelState } from "./models";

/**
 * Putting a session on a model, an effort level, or both.
 *
 * The work happens on the server, which drives the CLI's own picker
 * (sessionio/setmodel.go). What lives here is the two things a browser owns:
 * when to try again, and what to believe afterwards.
 *
 * WHAT TO BELIEVE. The reply is what the session reports AFTER the change, and
 * it is not always what was asked for. An effort change can be refused without
 * anything failing — measured on this box, an `env.CLAUDE_CODE_EFFORT_LEVEL` in
 * the account's settings.json overrides every runtime change and the slider
 * moves anyway — so a caller that showed its own request would show a level the
 * session is not on. Callers compare, and say so when the two differ.
 */

/** What one attempt means for whether to try again. */
type Attempt =
  | { kind: "ok"; state: ModelState }
  | { kind: "later" }
  | { kind: "no"; reason: string };

export interface SetModelOptions {
  session: string;
  harness: ModelHarness;
  /** Either may be "", meaning "leave this one alone". Both empty is refused. */
  model: string;
  effort: string;
  /**
   * Wait for the pane to be able to take input first. For a session that has
   * just been created: it accepts keys seconds before its TUI reads any, which
   * is the same gap the first prompt walks a ladder for.
   */
  awaitReady?: boolean;
  ladder?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export type SetModelResult =
  | { ok: true; state: ModelState }
  | { ok: false; reason: string };

async function attempt(o: SetModelOptions, fetchImpl: typeof fetch): Promise<Attempt> {
  try {
    const res = await fetchImpl(modelUrl(o.session), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: o.harness,
        model: o.model,
        effort: o.effort,
        awaitReady: o.awaitReady ?? false,
      }),
      credentials: "same-origin",
    });
    if (res.ok) return { kind: "ok", state: (await res.json()) as ModelState };
    // 503 is the pane not ready — the answer `awaitReady` asks for — and 404
    // covers a proxy answering ahead of the route on a session that is still
    // being created. Everything else is an answer, not a wait: 409 is a turn in
    // flight, and 502 carries the driver's own sentence, which names what the
    // session does offer.
    if (res.status === 503 || res.status === 404) return { kind: "later" };
    if (res.status === 409) {
      return { kind: "no", reason: "The session is working — stop the turn first." };
    }
    const said = (await res.text().catch(() => "")).trim();
    return { kind: "no", reason: said || `The session refused the change (${res.status}).` };
  } catch {
    return { kind: "later" }; // a blip on the way out, not a refusal
  }
}

/**
 * Apply a choice, walking the same rungs the first prompt walks.
 *
 * The LAST rung asks for no readiness wait, for the same reason
 * `deliverFirstPrompt` does: by then the ladder has spent 11s, and a pane that
 * has drawn no prompt in that time is one that never will.
 */
export async function setSessionModel(o: SetModelOptions): Promise<SetModelResult> {
  if (!o.model && !o.effort) return { ok: false, reason: "Nothing to change." };

  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl =
    o.fetchImpl ?? ((input, init) => fetchWithDeadline(String(input), init ?? undefined));
  const ladder = o.ladder ?? FIRST_PROMPT_LADDER;

  for (let rung = 0; rung < ladder.length; rung++) {
    await sleep(ladder[rung]!);
    const wait = (o.awaitReady ?? false) && rung < ladder.length - 1;
    const r = await attempt({ ...o, awaitReady: wait }, fetchImpl);
    if (r.kind === "ok") return { ok: true, state: r.state };
    if (r.kind === "no") return { ok: false, reason: r.reason };
  }
  return { ok: false, reason: "The session never became ready for the change." };
}
