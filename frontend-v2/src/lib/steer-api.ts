import { agentMessageUrl } from "./config";
import { fetchWithDeadline } from "./http";

/** What became of a message sent to an agent from the drill-in. */
export type SteerOutcome =
  /** Queued in the agent's inbox; it reads it at its next step. */
  | { kind: "sent" }
  /** The mod did not confirm in time, and may still deliver it: the words are
   *  not handed back, so they cannot be sent twice. */
  | { kind: "unconfirmed" }
  /** Not sent. `final` when it is the agent's state (finished, or one that
   *  cannot be addressed), which keeps the field read-only from then on. */
  | { kind: "refused"; message: string; final: boolean };

export async function steerAgent(
  session: string,
  agent: string,
  text: string,
  fetchImpl: typeof fetchWithDeadline = fetchWithDeadline,
): Promise<SteerOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(agentMessageUrl(session, agent), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    return { kind: "refused", message: "The message could not be sent. Try again.", final: false };
  }
  if (res.status === 204) return { kind: "sent" };
  if (res.status === 504) return { kind: "unconfirmed" };
  const said = (await res.text().catch(() => "")).trim();
  return {
    kind: "refused",
    message: said || `The message was not sent (HTTP ${res.status}).`,
    final: res.status === 409 || res.status === 501,
  };
}
