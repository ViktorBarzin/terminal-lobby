// The commands session-events hands the mod through the poll, and their acks.
// Everything outside is injected, as in link.ts.

import { slashCall, type SlashCall } from './command.ts';
import type { Command } from './dialogs.ts';
import type { SeenCommands } from './seen.ts';
import { capStrings } from './shape.ts';
import type { SteerResult } from './steer.ts';
import type { SummaryOnce } from './summary.ts';
import type { EventBody } from './wire.ts';

// The command ops runCommand runs, and the wire features this mod speaks,
// named in every hello so session-events sends a mod only what it can do
// (steer arrived in 0.2.0; level and decide-feedback in 0.3.0).
export const OPS = ['prompt', 'abort', 'answer', 'decide', 'steer', 'level', 'decide-feedback'] as const;

export type CommandDeps = {
  send: (ev: EventBody) => void;
  seen: SeenCommands;
  commandNames: () => Promise<string[]>;
  // $.command.run.
  runSlash: (call: SlashCall) => Promise<{ exitCode?: number; text?: string }>;
  // $.prompt.submit, as the person.
  submit: (text: string) => Promise<{ drop?: string; text?: string; origin?: unknown }>;
  // $.session.turns.
  turns: () => Promise<number>;
  summary: SummaryOnce;
  summarize: (text: string) => void;
  mainTurn: () => string | null;
  abort: (turnId: string) => Promise<void>;
  // Hands an answer or a decision to the dialog waiting on it; false when none waits.
  answer: (toolId: string, c: Command) => boolean;
  steer: (agentId: string, text: string) => Promise<SteerResult>;
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ack(deps: CommandDeps, id: string, ok: boolean, error?: string): void {
  const outcome = error === undefined ? { ok } : { ok, error };
  deps.seen.record(id, outcome);
  deps.send({ type: 'ack', id, ...outcome });
}

// A command already acked that then did not happen. The server drops a second
// ack for one command, so this goes as its own event (wire contract v3, item 7).
function failed(deps: CommandDeps, id: string, op: string, error: string): void {
  deps.seen.record(id, { ok: false, error });
  deps.send({ type: 'command_failed', id, op, error });
}

export async function runCommand(deps: CommandDeps, c: Command): Promise<void> {
  const id = typeof c.id === 'string' ? c.id : '';
  const repeated = deps.seen.repeat(c);
  if (repeated) {
    deps.send({ type: 'ack', id, ...repeated });
    return;
  }
  let ok = true;
  let error: string | undefined;
  try {
    switch (c.op) {
      case 'prompt':
        await prompt(deps, id, String(c.text ?? ''));
        return;
      case 'abort': {
        const turn = deps.mainTurn();
        if (turn === null) { ok = false; error = 'idle'; break; }
        await deps.abort(turn);
        break;
      }
      case 'answer':
      case 'decide':
        if (!deps.answer(String(c.toolId ?? ''), c)) { ok = false; error = 'gone'; }
        break;
      case 'steer': {
        // A message the person typed to a subagent open in the Text view.
        const r = await deps.steer(String(c.agentId ?? ''), String(c.text ?? ''));
        if (!r.ok) { ok = false; error = r.error; }
        break;
      }
      default:
        ok = false;
        error = `unknown op ${String(c.op)}`;
    }
  } catch (err) {
    ok = false;
    error = errorText(err);
  }
  ack(deps, id, ok, error);
}

// Both $.command.run and $.prompt.submit wait out a busy Claude, minutes if a
// turn is running, so the prompt is acked as soon as it is handed over and a
// later failure goes out as command_failed.
async function prompt(deps: CommandDeps, id: string, text: string): Promise<void> {
  // A slash command runs as one (lib/command.ts).
  const call = slashCall(text, await deps.commandNames().catch(() => []));
  if (call) {
    const ran = deps.runSlash(call);
    ack(deps, id, true);
    ran.then(
      (r) => { if (r.exitCode) failed(deps, id, 'prompt', r.text || `exited ${r.exitCode}`); },
      (err: unknown) => failed(deps, id, 'prompt', errorText(err)),
    );
    return;
  }
  // The first prompt of a fresh conversation is the one to title it by; a
  // resumed one already has a title. Never in the prompt's way.
  const fresh = (await deps.turns().catch(() => -1)) === 0;
  const submitted = deps.submit(text);
  ack(deps, id, true);
  submitted.then(
    (r) => {
      if (r.drop !== undefined) {
        failed(deps, id, 'prompt', `dropped: ${r.drop}`);
        return;
      }
      const entered = r.text ?? text;
      // The mod's own prompt.submit hook does not see a prompt it submitted.
      deps.send({
        type: 'prompt',
        text: capStrings(entered) as string,
        origin: r.origin ?? { kind: 'plugin', name: 'terminal-lobby', asUser: true },
      });
      if (fresh && deps.summary.claim()) deps.summarize(entered);
    },
    (err: unknown) => failed(deps, id, 'prompt', errorText(err)),
  );
}
