// The dialogs the lobby can answer from the web: Claude's own AskUserQuestion
// menu and plan approval, which run in tool.call, and permission prompts the
// mod holds in tool.check behind a dialog of its own ($.ui.ask). Each races
// the terminal against the web. Everything outside is injected, as in link.ts,
// so the races run the same under `node --test` and inside Claude Code.

import type { Pending } from './pending.ts';
import {
  capStrings, decisionFromLabel, decisionFromWeb, dialogFor, webAnswer, type QuestionResult,
} from './shape.ts';
import type { DialogEvent } from './wire.ts';

export type Command = { id?: unknown; op?: unknown; [field: string]: unknown };

export type Question = { question: string };

export type CheckResult = { decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string; hook?: string };

export type DialogDeps = {
  // A dialog opening: recorded as open and reported.
  announce: (ev: DialogEvent) => void;
  // A dialog answered or gone: recorded as closed and reported.
  settled: (toolId: string, by: 'web' | 'terminal' | 'gone') => void;
  // The mod's dialog failed and Claude draws its own for the call (contract
  // item 11): still open, and not settled.
  handOver: (toolId: string) => void;
  // Web answers, keyed by tool_use_id.
  web: Pending<Command>;
  own: OwnDialogs;
  // $.ui.ask.
  ask: (question: string, options: { options: string[]; header: string }) => Promise<string>;
  now: () => number;
  // The subagent whose row asked for a tool call, when the mod saw it.
  agentOf: (toolId: string) => string | undefined;
  // Words the person sent with a plan approval, for the plan's tool result
  // (racePlan).
  feedback: (toolId: string, words: string) => void;
};

// The mod's own terminal dialogs ($.ui.ask), keyed by question text. Each
// promise resolves with a label when the web answered first; the dialog is
// then answered with that label, which takes it off the screen.
export class OwnDialogs {
  #byQuestion = new Map<string, Promise<string>>();

  // Registers a dialog about to be drawn under a question no other open one
  // uses, and how to take it down.
  claim(question: string): { question: string; takedown: (label: string) => void; release: () => void } {
    let unique = question;
    for (let n = 2; this.#byQuestion.has(unique); n++) unique = `${question} (${n})`;
    let takedown!: (label: string) => void;
    const taken = new Promise<string>((resolve) => { takedown = resolve; });
    this.#byQuestion.set(unique, taken);
    return {
      question: unique,
      takedown,
      release: () => {
        if (this.#byQuestion.get(unique) === taken) this.#byQuestion.delete(unique);
      },
    };
  }

  get(question: string): Promise<string> | undefined {
    return this.#byQuestion.get(question);
  }
}

// One hold per tool call. Claude Code can check a call's permission twice
// (measured 2026-10-02, CLI 2.1.287: once answered, the same dialog came
// straight back for the same tool_use_id), and a second check while the first
// is still held would draw a second dialog. A repeat while held awaits the
// same hold; one repeat after it settled takes the answer given; a later one
// asks again, so a call that keeps asking reaches the person rather than
// looping on a remembered answer.
export class Holds<T> {
  #byId = new Map<string, { promise: Promise<T>; settled: boolean; reused: boolean }>();
  #max: number;

  constructor(max = 64) {
    this.#max = max;
  }

  run(id: string, start: () => Promise<T>): Promise<T> {
    const held = this.#byId.get(id);
    if (held && !held.settled) return held.promise;
    if (held && !held.reused) {
      held.reused = true;
      return held.promise;
    }
    let promise: Promise<T>;
    try {
      promise = start();
    } catch (err) {
      this.#byId.delete(id);
      return Promise.reject(err);
    }
    const entry = { promise, settled: false, reused: false };
    const done = () => { entry.settled = true; };
    promise.then(done, done);
    this.#byId.delete(id);
    this.#byId.set(id, entry);
    while (this.#byId.size > this.#max) {
      const oldest = this.#byId.keys().next().value;
      if (oldest === undefined) break;
      this.#byId.delete(oldest);
    }
    return promise;
  }
}

// AskUserQuestion from the model: Claude's own menu races the web answer.
export async function raceQuestion<Q extends Question, R>(
  deps: DialogDeps,
  e: { tool_use_id: string; questions: Q[] },
  next: () => Promise<R>,
): Promise<R | { deny: string } | { result: QuestionResult<Q> }> {
  const toolId = e.tool_use_id;
  deps.announce({ type: 'ask', t: deps.now(), toolId, questions: capStrings(e.questions) as unknown[] });
  const web = deps.web.wait(toolId);
  const local = next();
  // A web answer that lands once the terminal has answered finds no waiter,
  // so the web is told `gone` rather than that its answer was used.
  local.then(web.cancel, web.cancel);
  const winner = await Promise.race([
    local.then((r) => ({ by: 'terminal' as const, r }), (err: unknown) => ({ by: 'gone' as const, err })),
    web.promise.then((c) => ({ by: 'web' as const, c })),
  ]);
  web.cancel();
  if (winner.by === 'web') {
    local.catch(() => {});
    deps.settled(toolId, 'web');
    return webAnswer(e.questions, winner.c);
  }
  deps.settled(toolId, winner.by);
  if (winner.by === 'gone') throw winner.err;
  return winner.r;
}

// ExitPlanMode from the main loop: Claude's own "Ready to code?" menu, drawn
// inside tool.call's next, races the web.
//
// WHY NOT HELD IN tool.check ANY MORE. Until CLI 2.1.292 a hook's `allow`
// approved the plan (ADR-0036, measured on 2.1.287). On 2.1.293 it does not:
// "for a tool that requires the person a hook only tightens: its `allow` does
// not dismiss the dialog" (ToolCheckResult.decision), and the native menu came
// up after every approval from the mod's dialog. So an approval is a key in
// the pane, which session-events presses (the hello's `plan-keys` op), and
// here a web `allow` only says the web answered and carries the person's
// words for the plan's tool result. A web `deny` returned from tool.call while
// next is pending takes the native menu down and leaves the session in plan
// mode (probed live on 2.1.293, 2026-10-08), so declining needs no keys.
//
// tool.check runs inside next ("after the tool.call and PreToolUse hooks"), so
// `asked` resolves with the plan when the check asks, which is when the menu
// draws, and only then is the dialog announced. A call whose check never asks
// draws no menu and announces nothing.
export async function racePlan<R>(
  deps: DialogDeps,
  e: { tool_use_id: string; asked: Promise<{ plan: string; planFilePath?: string }> },
  next: () => Promise<R>,
): Promise<R | { deny: string }> {
  const toolId = e.tool_use_id;
  const local = next().then(
    (r) => ({ by: 'terminal' as const, r }),
    (err: unknown) => ({ by: 'gone' as const, err }),
  );
  const first = await Promise.race([local, e.asked.then((input) => ({ by: 'asked' as const, input }))]);
  if (first.by === 'gone') throw first.err;
  if (first.by === 'terminal') return first.r;
  const ev: DialogEvent = { type: 'plan', t: deps.now(), toolId, plan: capStrings(first.input.plan) as string };
  if (first.input.planFilePath) ev.planFilePath = first.input.planFilePath;
  deps.announce(ev);
  let webTaken = false;
  for (;;) {
    const web = deps.web.wait(toolId);
    // A web answer that lands once the menu has gone finds no waiter, so the
    // web is told `gone` rather than that its answer was used.
    local.then(web.cancel);
    const winner = await Promise.race([local, web.promise.then((c) => ({ by: 'web' as const, c }))]);
    web.cancel();
    if (winner.by === 'web') {
      const decision = decisionFromWeb('ExitPlanMode', winner.c.decision, winner.c.reason);
      if (decision.decision === 'deny') {
        deps.settled(toolId, 'web');
        return { deny: decision.reason };
      }
      webTaken = true;
      const words = typeof winner.c.feedback === 'string' ? winner.c.feedback.trim() : '';
      if (words) deps.feedback(toolId, words);
      continue;
    }
    if (winner.by === 'gone') {
      deps.settled(toolId, 'gone');
      throw winner.err;
    }
    deps.settled(toolId, webTaken ? 'web' : 'terminal');
    return winner.r;
  }
}

// The plan a check names, for the plan card. Claude Code 2.1.293 writes some
// ExitPlanMode calls with an empty input, the plan only in its file
// (2026-10-08), and the card then showed "{}". So a plan missing from the
// input is read from the file the input names, or else the one the main
// loop's last plan-mode reminder named (`prompt.attachment`, plan_mode). A
// file that cannot be read leaves the plan empty.
export async function planOf(
  input: unknown,
  reminderFile: string,
  read: (path: string) => Promise<string>,
): Promise<{ plan: string; planFilePath?: string }> {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const named = typeof o.planFilePath === 'string' ? o.planFilePath : '';
  if (typeof o.plan === 'string' && o.plan.trim() !== '') {
    return named ? { plan: o.plan, planFilePath: named } : { plan: o.plan };
  }
  const path = named || reminderFile;
  if (!path) return { plan: '' };
  try {
    return { plan: await read(path), planFilePath: path };
  } catch {
    return { plan: '', planFilePath: path };
  }
}

// The mod's own $.ui.ask dialog reaching tool.call: race it against a
// takedown, so a web answer can take it off the screen.
export async function ownDialog<Q extends Question, R>(
  e: { questions: Q[] },
  takedown: Promise<string>,
  next: () => Promise<R>,
): Promise<R | { result: QuestionResult<Q> }> {
  const local = next();
  const winner = await Promise.race([
    local.then((r) => ({ by: 'terminal' as const, r })),
    takedown.then((label) => ({ by: 'web' as const, label })),
  ]);
  if (winner.by === 'terminal') return winner.r;
  local.catch(() => {});
  const question = e.questions[0]?.question ?? '';
  return { result: { questions: e.questions, answers: { [question]: winner.label }, annotations: {} } };
}

// tool.check resolved to `ask` for a permission prompt: hold it, draw the
// mod's dialog, race the web. The caller runs it through Holds. A plan is
// never held (racePlan).
export async function holdDecision(
  deps: DialogDeps,
  e: { tool: string; input: unknown; tool_use_id: string },
  r: CheckResult,
): Promise<CheckResult> {
  const toolId = e.tool_use_id;
  const ev: DialogEvent = { type: 'permission', t: deps.now(), toolId, tool: e.tool, input: capStrings(e.input) };
  if (r.reason) ev.reason = r.reason;
  const agentId = deps.agentOf(toolId);
  if (agentId !== undefined) ev.agentId = agentId;
  deps.announce(ev);

  const dialog = dialogFor(e.tool, e.input);
  const own = deps.own.claim(dialog.question);
  const web = deps.web.wait(toolId);
  try {
    let local: Promise<string>;
    try {
      local = deps.ask(own.question, { options: [...dialog.options], header: dialog.header });
    } catch (err) {
      local = Promise.reject(err);
    }
    // Kept until the dialog itself settles: a web answer can win before the
    // dialog's own tool.call runs, and that call must still find its takedown.
    const done = () => { own.release(); web.cancel(); };
    local.then(done, done);
    const winner = await Promise.race([
      local.then((label) => ({ by: 'terminal' as const, label }), (err: unknown) => ({ by: 'failed' as const, err })),
      web.promise.then((c) => ({ by: 'web' as const, c })),
    ]);
    if (winner.by === 'web') {
      local.catch(() => {});
      const decision = decisionFromWeb(e.tool, winner.c.decision, winner.c.reason);
      own.takedown(decision.decision === 'allow' ? dialog.options[0] : dialog.options[1]);
      deps.settled(toolId, 'web');
      return decision;
    }
    if (winner.by === 'terminal') {
      deps.settled(toolId, 'terminal');
      return decisionFromLabel(e.tool, winner.label);
    }
    // No dialog could be drawn, it was dismissed, or the turn was aborted
    // (which dismisses it, measured 2026-10-04): Claude draws its own.
    deps.handOver(toolId);
    return r;
  } finally {
    web.cancel();
  }
}
