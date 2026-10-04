// Workflow runs in the agent list the mod sends (session-events modstate.go
// bgTokens, which counts a running `workflow` entry as `w:<id>`).
//
// $.agent.list() names subagents and teammates only: a workflow run and its
// members carry ids no list names. The classic Stop and SubagentStop inputs
// list every task in flight as `background_tasks`, a run among them as type
// `workflow`, which is where the lobby's Stop hook read runs before this mod.

export type ListedAgent = { id: string; type: string; status: string; name?: string; description?: string };

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

// runningWorkflows reads the runs out of a `background_tasks` value, each as a
// running entry: the field lists only work in flight. undefined when the input
// had no such list, which says nothing about the runs.
export function runningWorkflows(tasks: unknown): ListedAgent[] | undefined {
  if (!Array.isArray(tasks)) return undefined;
  const out: ListedAgent[] = [];
  for (const t of tasks) {
    if (typeof t !== 'object' || t === null) continue;
    const o = t as Record<string, unknown>;
    const id = text(o.id);
    if (!id || o.type !== 'workflow') continue;
    const w: ListedAgent = { id, type: 'workflow', status: 'running' };
    if (text(o.name)) w.name = text(o.name);
    if (text(o.description)) w.description = text(o.description);
    out.push(w);
  }
  return out;
}

// withWorkflows is the engine's list with the runs added after it. An id the
// engine already names keeps the engine's entry.
export function withWorkflows<A extends { id: string }>(agents: A[], workflows: ListedAgent[]): (A | ListedAgent)[] {
  const named = new Set(agents.map((a) => a.id));
  return [...agents, ...workflows.filter((w) => !named.has(w.id))];
}
