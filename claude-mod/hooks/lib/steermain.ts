// Delivers prompts the lobby holds behind Claude's running main turn into that
// turn, at its next tool boundary (session-events/steermain.go). Viktor,
// 2026-10-10: "let's make it steer similarly to how Claude code works".
//
// $.prompt.submit cannot do it: a plugin's prompt runs once Claude is idle.
// A tool.call hook's result can carry context the model reads right after the
// tool's result, which is where Claude Code delivers a prompt typed in the
// pane mid-turn (measured on 2.1.296: the model changed course on it, and the
// engine stores it as a hook_additional_context row that session-events reads
// to confirm the delivery).

// MAIN_STEER_LEAD opens each delivered prompt: the words are the person's,
// and they are to be acted on now. sessionio's MainSteerLead spells it too,
// and finds the prompts in the stored row by it; a test holds the two
// together.
export const MAIN_STEER_LEAD =
  'The person watching this session in the lobby sent this message while you were working. Read it before your next step, and change course if it asks you to:';

// How long a tool call waits for session-events to hand over what it holds.
// Past it the call goes on without them, and what the server handed over goes
// out when the turn ends instead.
export const TAKE_WAIT_MS = 1500;

// The mod's own dialog ($.ui.ask) is an AskUserQuestion call with this id
// prefix; it is the mod talking to the person, not a step of Claude's.
const OWN_DIALOG_PREFIX = 'toolu_plugin_';

export function frameMainSteer(text: string): string {
  return `${MAIN_STEER_LEAD}\n\n${text.trim()}`;
}

export type SteerMainDeps = {
  take: () => Promise<string[]>;
  wait: (ms: number) => Promise<void>;
};

export type SteerMainCall = { toolId: string; agentId?: string; aborted: boolean };

// steerInto adds what is held to a finished call's result, one context entry
// per prompt after any the result carries. It takes nothing where the context
// could not land: a subagent's call, a denied one (a denial carries no
// context), one the person interrupted, or the mod's own dialog.
export async function steerInto<R extends object>(deps: SteerMainDeps, call: SteerMainCall, r: R): Promise<R> {
  const denied = 'deny' in r && r.deny !== undefined;
  if (call.agentId !== undefined || denied || call.aborted || call.toolId.startsWith(OWN_DIALOG_PREFIX)) {
    return r;
  }
  const texts = await Promise.race([
    deps.take().catch((): string[] => []),
    deps.wait(TAKE_WAIT_MS).then(() => null),
  ]);
  if (!texts || texts.length === 0) return r;
  const had: string[] = 'context' in r && Array.isArray(r.context) ? r.context.filter((c): c is string => typeof c === 'string') : [];
  return { ...r, context: [...had, ...texts.map(frameMainSteer)] };
}
