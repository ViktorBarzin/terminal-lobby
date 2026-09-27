import { modelUrl } from "./config";
import { fetchWithDeadline } from "./http";
import type { ModeId } from "../logic/modes";

/**
 * Putting a session in a permission mode, from the Text view's model sheet.
 *
 * The CLI has no command for it: Shift+Tab is the only way a running session
 * changes mode, one stop per press. So the server walks it (wire contract 1,
 * 2026-09-24): it reads the mode off the pane, presses Shift+Tab ONE AT A
 * TIME, reads the pane after each press and stops the moment the mode asked
 * for shows. It refuses a walk that would pass THROUGH bypass or no ask while
 * Claude works, since the 120 ms a stop is held between two presses is that
 * mode for whatever tool call lands in them.
 *
 * THE ROUTE IS THE MODEL ROUTE, with a `mode` field in the body. A route of
 * its own would have needed a change in the infra repo, because the
 * IngressRoute allow-lists session-events paths one by one, and every other
 * prefix answers with the SPA's own index.html.
 *
 * NO RETRY LADDER, unlike `setSessionModel` beside this. A request that timed
 * out may still have walked, and a second walk from a start nobody read is a
 * guess about the pane. One request, and whatever it says.
 *
 * WHAT TO BELIEVE. The reply's `mode` is what the pane showed when the walk
 * ended, whether or not it got where it was asked to go. A refusal is an
 * ordinary reply carrying that reading, and the model button shows it.
 */

/** What the server says about a mode request. */
export interface SetModeReply {
  /** The pane shows the mode asked for. */
  applied: boolean;
  /**
   * Why it does not: `unavailable` (the session does not offer that mode),
   * `unsafe-path` (the walk would pass through, or stopped on, bypass or no
   * ask while Claude works), `dialog-open`, or another word the server uses.
   */
  reason?: string;
  /** The mode the pane shows now, by the CLI's identifier. */
  mode: string;
  /** How many times Shift+Tab went in. */
  presses: number;
}

export type SetModeResult = { ok: true; reply: SetModeReply } | { ok: false; reason: string };

/** A body the server sent that has the shape of a reply, whatever its status. */
function asReply(text: string): SetModeReply | null {
  try {
    const v = JSON.parse(text) as Partial<SetModeReply> | null;
    if (!v || typeof v.applied !== "boolean" || typeof v.mode !== "string") return null;
    return {
      applied: v.applied,
      ...(typeof v.reason === "string" && v.reason ? { reason: v.reason } : {}),
      mode: v.mode,
      presses: typeof v.presses === "number" ? v.presses : 0,
    };
  } catch {
    return null;
  }
}

export async function setSessionMode(o: {
  session: string;
  mode: ModeId;
  fetchImpl?: typeof fetch;
}): Promise<SetModeResult> {
  const fetchImpl =
    o.fetchImpl ?? ((input, init) => fetchWithDeadline(String(input), init ?? undefined));
  let res: Response;
  try {
    res = await fetchImpl(modelUrl(o.session), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: o.mode }),
      credentials: "same-origin",
    });
  } catch {
    // Deliberately not "nothing changed": a dropped reply cannot say whether
    // the walk ran, and the model button keeps the mode it last read until a reading
    // says otherwise.
    return { ok: false, reason: "Couldn't reach the session to change the mode." };
  }
  const text = (await res.text().catch(() => "")).trim();
  // A refusal can come back under an error status and still carry the pane's
  // reading, which is worth more than the status: the model button shows it.
  const read = asReply(text);
  if (read) return { ok: true, reply: read };
  // A sentence from the server is worth passing on. A page is not: a route the
  // ingress does not carry answers 200 with the SPA's own index.html.
  const said = text && !text.startsWith("<") && text.length <= 200 ? text : "";
  return {
    ok: false,
    reason: said || `The session could not change the mode (${res.status}).`,
  };
}
