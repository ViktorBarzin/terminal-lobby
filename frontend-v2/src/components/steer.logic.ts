import type { AgentInfo, Event } from "../types/events";

/**
 * Steering: the person messaging a subagent open in the drill-in, from the
 * composer (session-events steer.go, the claude-mod's `steer` op). A running
 * subagent reads it at its next tool boundary and an idle teammate when it
 * next runs, so the message waits on screen until the agent's own transcript
 * shows it, which can be seconds or minutes.
 */

/** A message sent to an agent that its transcript does not show yet. */
export interface PendingSteer {
  /** Negative, so it can never collide with a transcript event's id. */
  id: number;
  agent: string;
  text: string;
  at: number;
}

/**
 * Why the composer cannot message this agent, worded for the field's read-only
 * strip (its word before the colon is what the strip shows); undefined when it
 * can. Finished agents are read-only by choice (Viktor, 2026-10-03), and an
 * agent the set does not describe is never offered, since claiming one is
 * listening is the thing not to guess.
 */
export function steerNote(info: AgentInfo | undefined): string | undefined {
  if (info?.steerable === true) return undefined;
  switch (info?.steerNote) {
    case "workflow":
      return "Read-only: workflow members can't be messaged yet";
    case "old-mod":
      return "Restart: this session's Claude started before agents could be messaged; restart it to message them";
    default:
      return "Finished: this agent has finished, so it can only be read";
  }
}

/**
 * The messages the agent's stream does not show yet. `seen` remembers, per
 * message, how many of the person's messages with the same words the stream
 * held when this one was first looked at, so a message repeated word for word
 * waits for its own row rather than clearing on the last one's.
 */
export function unreadSteers(
  events: readonly Event[],
  sent: readonly PendingSteer[],
  seen: Map<number, number>,
): PendingSteer[] {
  const shown = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "user" && e.steer) shown.set(e.body ?? "", (shown.get(e.body ?? "") ?? 0) + 1);
  }
  const owed = new Map<string, number>();
  return sent.filter((p) => {
    if (!seen.has(p.id)) seen.set(p.id, shown.get(p.text) ?? 0);
    const ahead = owed.get(p.text) ?? 0;
    owed.set(p.text, ahead + 1);
    return (shown.get(p.text) ?? 0) - seen.get(p.id)! <= ahead;
  });
}

/** The events with a waiting bubble for each unread message, each its own turn. */
export function withSteers(events: Event[], unread: readonly PendingSteer[]): Event[] {
  if (unread.length === 0) return events;
  return [
    ...events,
    ...unread.map(
      (p): Event => ({
        id: p.id,
        kind: "user",
        session: "",
        turnId: `steer-${p.id}`,
        body: p.text,
        at: p.at,
        steer: true,
        sending: true,
      }),
    ),
  ];
}
