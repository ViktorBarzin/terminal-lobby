// A message the person sends a subagent from the lobby's Text view, the
// `steer` command (session-events steer.go).
//
// The engine delivers a plugin's message framed as the coordinator's, so the
// prefix tells the agent the words are the person's. sessionio's SteerPrefix
// spells the same line, and strips it so the view shows only what was typed.
import { type AgentStatus, isLive } from './wire.ts';

export const STEER_PREFIX = 'The person watching this session in the lobby says:';

export type SteerAgent = { id: string; type: string; status: AgentStatus };
export type SteerSend = { isDelivered: true } | { isDelivered: false; reason: string };
export type SteerDeps = {
  list: () => Promise<SteerAgent[]>;
  send: (args: { to: { agentId: string }; text: string }) => Promise<SteerSend>;
};
export type SteerResult = { ok: true } | { ok: false; error: string };

// steer sends text to agentId unless the engine lists it ended (completed,
// failed or killed): a pending, waiting or idle agent still reads its
// messages. Finished agents are read-only (Viktor, 2026-10-03), though the
// engine would resume one; a workflow is listed as the run, not its members,
// so neither the run nor an unlisted id is addressed. The error's first word is what
// session-events reads to tell the agent's state from a failure.
export async function steer(deps: SteerDeps, agentId: string, text: string): Promise<SteerResult> {
  if (!agentId || !text.trim()) return { ok: false, error: 'empty' };
  const agent = (await deps.list()).find((a) => a.id === agentId);
  if (!agent || agent.type === 'workflow') {
    return { ok: false, error: 'not-addressable: this agent cannot be messaged' };
  }
  if (!isLive(agent.status)) {
    return { ok: false, error: 'finished: this agent has finished' };
  }
  const r = await deps.send({ to: { agentId }, text: `${STEER_PREFIX}\n\n${text}` });
  return r.isDelivered ? { ok: true } : { ok: false, error: r.reason };
}
