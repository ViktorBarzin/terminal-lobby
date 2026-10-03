// terminal-lobby mod: reports a Claude session to session-events and acts on
// it for the lobby. Wire protocol: docs/adr/0036-claude-speaks-to-the-lobby-through-a-mod.md.
// This file wires Claude Code events to the logic in ./lib; keep logic there.

import type { EngineInterface, Register } from 'claude-code';
import { Link } from './lib/link.ts';
import type { ModEvent } from './lib/queue.ts';
import { Pending } from './lib/pending.ts';
import { SeenCommands } from './lib/seen.ts';
import { TranscriptStamp } from './lib/stamp.ts';
import { Decided } from './lib/decided.ts';
import { OpenDialogs } from './lib/open.ts';
import { SummaryOnce, summaryFrom, summaryRequest } from './lib/summary.ts';
import { steer } from './lib/steer.ts';
import {
  decisionFromLabel, decisionFromWeb, dialogFor, historyEvents, isOwnDialog, shapeResult, shapeRow, transcriptPath, webAnswer,
} from './lib/shape.ts';

const MOD_VERSION = '0.2.0';
// The command ops runCommand runs, named in every hello so session-events
// sends a mod only what it can do (steer arrived in 0.2.0).
const OPS = ['prompt', 'abort', 'answer', 'decide', 'model', 'history', 'steer'];
const DEFAULT_URL = 'http://127.0.0.1:7685';
const DRAIN_MS = 1500;

type Command = { id?: unknown; op?: unknown; [field: string]: unknown };
type Question = { question: string; [k: string]: unknown };
type ToolResult = { result?: unknown; text?: string; isError?: boolean; deny?: string };

// One set per module instance: a hot reload starts over with a fresh session.start.
let link: Link | null = null;
let mainTurn: string | null = null;
let lastModel = '';
let tmuxSession = '';
// Where this session's transcript will be, and whether the last hello named it.
let transcriptFile = async (): Promise<string> => '';
const stamp = new TranscriptStamp();
// Answers already given, for a tool call whose permission is checked again.
const decided = new Decided();
// Web answers for dialogs on screen, keyed by tool_use_id.
const webAnswers = new Pending<Command>();
// The mod's own terminal dialogs ($.ui.ask), keyed by question text. Each
// promise resolves with a label when the web answered first; the dialog is
// then answered with that label, which takes it off the screen.
const ownDialogs = new Map<string, Promise<string>>();
// Commands already run here, so one sent again after a re-hello is only re-acked.
const seenCommands = new SeenCommands();
// Dialogs on screen, sent again after every hello (lib/open.ts).
const openDialogs = new OpenDialogs();
// Whether this conversation still owes its summary (lib/summary.ts).
const summary = new SummaryOnce();

const now = () => Date.now();

function send(ev: Omit<ModEvent, 't'> & { t?: number }): void {
  try {
    link?.send({ t: now(), ...ev } as ModEvent);
  } catch {
    // Reporting never gets in Claude's way.
  }
}

// A dialog opening: reported, and kept until it settles so a later hello
// can report it again.
function announce(ev: Omit<ModEvent, 't'>): void {
  const full = { t: now(), ...ev } as ModEvent;
  openDialogs.add(full);
  try {
    link?.send(full);
  } catch {
    // Reporting never gets in Claude's way.
  }
}

function settled(toolId: string, by: string): void {
  openDialogs.settle(toolId);
  send({ type: 'settled', toolId, by });
}

function ack(id: unknown, ok: boolean, error?: string): void {
  const outcome = error === undefined ? { ok } : { ok, error };
  seenCommands.record(id, outcome);
  send({ type: 'ack', id, ...outcome });
}

// Asks for a one-line summary of the conversation's first prompt and sends it
// for the session's title. Claude Code writes its own only for a typed prompt.
async function sendSummary($: EngineInterface, text: string): Promise<void> {
  try {
    const r = await $.model.complete(summaryRequest(text));
    const title = r.isAnswered ? summaryFrom(r.text) : '';
    if (title) send({ type: 'summary', text: title });
  } catch {
    // An untitled session keeps its prompt line in the lobby, as before.
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function tmuxSessionName($: EngineInterface, pane: string): Promise<string> {
  try {
    const r = await $.process.run(['tmux', 'display-message', '-p', '-t', pane, '#S'], { timeoutMs: 3000 });
    return r.exitCode === 0 ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

// Where this conversation's transcript is, '' until Claude has written one.
// Claude files a conversation under the folder it STARTED in, which the mod
// cannot always know: a mod that loads into a running Claude (the managed
// settings changing under it) starts wherever that Claude has cd'd to. So the
// guess from the start folder is tried first and the projects folder searched
// for the conversation's id after it. The answer is kept once found.
let foundTranscript = '';
async function findTranscript($: EngineInterface, configDir: string, startCwd: string, sid: string): Promise<string> {
  if (foundTranscript.endsWith(`/${sid}.jsonl`)) return foundTranscript;
  const guess = transcriptPath(configDir, startCwd, sid);
  if (await $.fs.exists(guess)) return (foundTranscript = guess);
  try {
    const root = `${configDir}/projects`;
    for (const d of await $.fs.list(root)) {
      if (d.kind !== 'dir') continue;
      const p = `${root}/${d.name}/${sid}.jsonl`;
      if (await $.fs.exists(p)) return (foundTranscript = p);
    }
  } catch {
    // An unreadable projects folder names nothing.
  }
  return '';
}

async function startLink($: EngineInterface, startCwd: string, pane: string): Promise<void> {
  const base = ((await $.env.get('TL_MOD_URL')) || DEFAULT_URL).replace(/\/+$/, '');
  const home = (await $.env.get('HOME')) || '';
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`;
  tmuxSession = await tmuxSessionName($, pane);
  transcriptFile = async () => transcriptPath(configDir, startCwd, await $.session.id());

  const call = async (method: string, path: string, body?: unknown) => {
    const init: { method: string; headers?: Record<string, string>; body?: string } = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const r = await $.http.fetch(base + path, init);
    let parsed: unknown = null;
    if (r.text) {
      try { parsed = JSON.parse(r.text); } catch { parsed = null; }
    }
    return { status: r.status, body: parsed };
  };

  link = new Link({
    post: (path, body) => call('POST', path, body),
    get: (path) => call('GET', path),
    now,
    after: (ms, fn) => { $.clock.after(ms, fn); },
    sleep: (ms) => $.clock.sleep(ms),
    random: Math.random,
    hello: async () => {
      const sid = await $.session.id();
      tmuxSession = (await tmuxSessionName($, pane)) || tmuxSession;
      const hello: Record<string, unknown> = {
        sid,
        pane,
        tmux: (await $.env.get('TMUX')) || '',
        session: tmuxSession,
        cwd: await $.session.cwd(),
      };
      const transcript = await findTranscript($, configDir, startCwd, sid);
      const named = transcript !== '';
      if (named) hello.transcript = transcript;
      stamp.hello(named);
      hello.model = await $.session.model();
      hello.version = (await $.session.version()).version;
      hello.mod = MOD_VERSION;
      hello.ops = OPS;
      return hello;
    },
    history: () => historyFields($),
    open: () => openDialogs.list(),
    onCommand: (c) => { void runCommand($, c as Command); },
  });
  $.clock.after(1, () => link?.start());
}

// The `history` event's fields: what the session holds, and whether a
// main-thread turn is running (the server closes the last turn when not).
async function historyFields($: EngineInterface): Promise<{ messages: unknown; running: boolean }> {
  return { messages: await $.session.messages(), running: mainTurn !== null };
}

async function runCommand($: EngineInterface, c: Command): Promise<void> {
  const repeated = seenCommands.repeat(c);
  if (repeated) {
    send({ type: 'ack', id: c.id, ...repeated });
    return;
  }
  let ok = true;
  let error: string | undefined;
  try {
    switch (c.op) {
      case 'prompt': {
        // The first prompt of a fresh conversation is the one to title it by;
        // a resumed one already has a title. Never in the prompt's way.
        const owesSummary = summary.claim() && (await $.session.turns().catch(() => -1)) === 0;
        // submit resolves only when the prompt's turn starts, minutes later if
        // Claude is busy: ack now, and ack again with ok:false if it fails.
        const submitted = $.prompt.submit({ text: String(c.text ?? ''), asUser: true });
        ack(c.id, true);
        submitted.then(
          (r) => {
            if (r.drop !== undefined) {
              ack(c.id, false, `dropped: ${r.drop}`);
              return;
            }
            // The mod's own prompt.submit hook does not see a prompt it submitted.
            send({ type: 'prompt', text: r.text, origin: r.origin ?? { kind: 'plugin', name: 'terminal-lobby', asUser: true } });
            if (owesSummary) void sendSummary($, r.text);
          },
          (err: unknown) => ack(c.id, false, errorText(err)),
        );
        return;
      }
      case 'abort':
        if (mainTurn === null) { ok = false; error = 'idle'; break; }
        await $.turn.abort({ turnId: mainTurn });
        break;
      case 'answer':
      case 'decide':
        if (!webAnswers.resolve(String(c.toolId ?? ''), c)) { ok = false; error = 'gone'; }
        break;
      case 'model': {
        // /model may stop on Claude's own "Switch model?" confirm (a cached
        // conversation); declining it answers "Kept model as ...".
        const wanted = String(c.model ?? '');
        const before = await $.session.model();
        const r = await $.command.run({ command: 'model', args: wanted });
        const after = await $.session.model();
        if (r.exitCode || (after === before && !after.includes(wanted))) {
          ok = false;
          error = r.text || `model stayed ${after}`;
          break;
        }
        if (c.effort) {
          const e = await $.command.run({ command: 'effort', args: String(c.effort) });
          if (e.exitCode) { ok = false; error = e.text || `effort exited ${e.exitCode}`; }
        }
        break;
      }
      case 'steer': {
        // A message the person typed to a subagent open in the Text view.
        const r = await steer(
          { list: () => $.agent.list(), send: (args) => $.session.send(args) },
          String(c.agentId ?? ''),
          String(c.text ?? ''),
        );
        if (!r.ok) { ok = false; error = r.error; }
        break;
      }
      case 'history': {
        const h = await historyFields($);
        for (const ev of historyEvents(await $.clock.now(), h.messages, h.running)) send(ev);
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
  ack(c.id, ok, error);
}

// AskUserQuestion from the model: Claude's own dialog races the web answer.
async function raceQuestion(
  e: { tool_use_id: string; questions: readonly Question[] },
  next: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const toolId = e.tool_use_id;
  announce({ type: 'ask', toolId, questions: e.questions });
  try {
    const web = webAnswers.wait(toolId);
    const local = next();
    const winner = await Promise.race([
      local.then((r) => ({ by: 'terminal' as const, r }), (err: unknown) => ({ by: 'gone' as const, err })),
      web.promise.then((c) => ({ by: 'web' as const, c })),
    ]);
    web.cancel();
    if (winner.by === 'web') {
      local.catch(() => {});
      settled(toolId, 'web');
      return webAnswer(e.questions, winner.c);
    }
    settled(toolId, winner.by);
    if (winner.by === 'gone') throw winner.err;
    return winner.r;
  } finally {
    openDialogs.settle(toolId);
  }
}

// The mod's own $.ui.ask dialog reaching tool.call: race it against a
// takedown, so a web answer can take it off the screen.
async function ownDialog(
  e: { questions: readonly Question[] },
  takedown: Promise<string>,
  next: () => Promise<ToolResult>,
): Promise<ToolResult> {
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

type CheckResult = { decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string };

// tool.check resolved to `ask`: hold it, draw the mod's dialog, race the web.
async function holdDecision($: EngineInterface, e: { tool: string; input: unknown; tool_use_id?: string }, r: CheckResult): Promise<CheckResult> {
  const toolId = e.tool_use_id || `check-${now()}`;
  const input = (e.input && typeof e.input === 'object' ? e.input : {}) as Record<string, unknown>;
  if (e.tool === 'ExitPlanMode') {
    const ev: Omit<ModEvent, 't'> = { type: 'plan', toolId, plan: String(input.plan ?? '') };
    if (typeof input.planFilePath === 'string') ev.planFilePath = input.planFilePath;
    announce(ev);
  } else {
    const ev: Omit<ModEvent, 't'> = { type: 'permission', toolId, tool: e.tool, input: e.input };
    if (r.reason) ev.reason = r.reason;
    announce(ev);
  }

  const dialog = dialogFor(e.tool, e.input);
  let question = dialog.question;
  for (let n = 2; ownDialogs.has(question); n++) question = `${dialog.question} (${n})`;
  let takedown!: (label: string) => void;
  const takenDown = new Promise<string>((resolve) => { takedown = resolve; });
  ownDialogs.set(question, takenDown);
  const web = webAnswers.wait(toolId);
  try {
    const local = $.ui.ask(question, { options: dialog.options, header: dialog.header });
    const winner = await Promise.race([
      local.then((label) => ({ by: 'terminal' as const, label }), (err: unknown) => ({ by: 'failed' as const, err })),
      web.promise.then((c) => ({ by: 'web' as const, c })),
    ]);
    if (winner.by === 'web') {
      local.catch(() => {});
      const decision = decisionFromWeb(e.tool, winner.c.decision, winner.c.reason);
      takedown(decision.decision === 'allow' ? dialog.options[0] : dialog.options[1]);
      settled(toolId, 'web');
      decided.remember(e.tool_use_id ?? '', decision);
      return decision;
    }
    if (winner.by === 'terminal') {
      settled(toolId, 'terminal');
      const decision = decisionFromLabel(e.tool, winner.label);
      decided.remember(e.tool_use_id ?? '', decision);
      return decision;
    }
    // No dialog could be drawn (or it was dismissed): Claude draws its own.
    settled(toolId, 'gone');
    return r;
  } finally {
    web.cancel();
    ownDialogs.delete(question);
    openDialogs.settle(toolId);
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e);
    try {
      if (!e.isInteractive || link) return r;
      const pane = await $.env.get('TMUX_PANE');
      if (!pane) return r;
      await startLink($, e.cwd, pane);
    } catch {
      // A mod that cannot start stays quiet; Claude runs as usual.
    }
    return r;
  });

  on('session.end', async ($, e, next) => {
    if (link) {
      try {
        send({ type: 'bye', reason: e.reason });
        await link.drain(DRAIN_MS);
        // A /clear ends this conversation but not the process: say hello
        // again for the new one.
        if (e.reason === 'clear') {
          summary.reset();
          link.rehello();
        }
        else link.stop();
      } catch {
        // Ignored: the session ends either way.
      }
    }
    return next(e);
  });

  on('prompt.submit', ($, e, next) => {
    if (link) send({ type: 'prompt', text: e.text, origin: e.origin });
    return next(e);
  });

  on('session.append', async ($, e, next) => {
    const r = await next(e);
    if (link && r.message) {
      try { send(shapeRow(e, r, now())); } catch { /* never block a row */ }
      // The first stored row is what creates the transcript: say hello again
      // so session-events can stamp it while this first turn still runs.
      if (stamp.pending) {
        try {
          if (stamp.appeared(await $.fs.exists(await transcriptFile()))) link.rehello();
        } catch { /* reporting only */ }
      }
    }
    return r;
  });

  on('turn.start', async ($, e, next) => {
    if (link) {
      try {
        const agentId = (e as { agentId?: string }).agentId;
        if (agentId === undefined) mainTurn = e.turnId;
        const ev: Omit<ModEvent, 't'> = { type: 'turn_start', turnId: e.turnId, text: e.text };
        if (agentId !== undefined) ev.agentId = agentId;
        send(ev);
        // A subagent starting is when the lobby can first message it, and the
        // engine's list is what says so; otherwise it is sent only as turns end.
        if (agentId !== undefined) send({ type: 'agents', agents: await $.agent.list() });
        if (agentId === undefined) {
          const pane = await $.env.get('TMUX_PANE');
          const name = pane ? await tmuxSessionName($, pane) : '';
          if (name && name !== tmuxSession) {
            tmuxSession = name;
            link.rehello();
          }
        }
      } catch { /* reporting only */ }
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    if (link) {
      try {
        if (e.agentId === undefined && mainTurn === e.turnId) mainTurn = null;
        const ev: Omit<ModEvent, 't'> = { type: 'turn_end', turnId: e.turnId, aborted: e.isAborted, answer: e.answer };
        if (e.agentId !== undefined) ev.agentId = e.agentId;
        if (e.usage !== undefined) ev.usage = e.usage;
        ev.durationMs = e.durationMs;
        send(ev);
        send({ type: 'agents', agents: await $.agent.list() });
      } catch { /* reporting only */ }
    }
    return r;
  });

  on('turn.step', async function* ($, e, next) {
    const live = link !== null;
    if (live && e.agentId === undefined) {
      const key = `${e.model}|${e.effort ?? ''}`;
      if (key !== lastModel) {
        lastModel = key;
        send(e.effort === undefined ? { type: 'model', model: e.model } : { type: 'model', model: e.model, effort: e.effort });
      }
    }
    const stream = next(e);
    for (;;) {
      const { value, done } = await stream.next();
      if (done) return value;
      if (live && (value.kind === 'text' || value.kind === 'thinking') && value.text) {
        const ev: Omit<ModEvent, 't'> = { type: 'delta', turnId: e.turnId, step: e.index, index: value.index, kind: value.kind, text: value.text };
        if (e.agentId !== undefined) ev.agentId = e.agentId;
        send(ev);
      }
      yield value;
    }
  });

  on('tool.call', async ($, e, next) => {
    if (!link) return next(e);
    if (e.tool === 'AskUserQuestion') {
      const questions = (Array.isArray(e.questions) ? e.questions : []) as Question[];
      // A mod dialog ($.ui.ask) is never reported: no ask, settled or result.
      // The copy that drew it can take it down; any other copy lets it be.
      const takenDown = ownDialogs.get(questions[0]?.question ?? '');
      if (takenDown) return ownDialog({ questions }, takenDown, () => next(e) as Promise<ToolResult>) as never;
      if (isOwnDialog(questions)) return next(e);
      if (e.agentId === undefined) {
        const r = await raceQuestion({ tool_use_id: e.tool_use_id, questions }, () => next(e) as Promise<ToolResult>);
        send(shapeResult(e, r, now()));
        return r as never;
      }
    }
    const r = await next(e);
    send(shapeResult(e, r as ToolResult, now()));
    return r;
  });

  on('tool.check', async ($, e, next) => {
    const r = await next(e);
    // AskUserQuestion's own menu is its permission prompt: let Claude draw it
    // (tool.call races it against the web). The mod's $.ui.ask comes here too.
    if (!link || r.decision !== 'ask' || e.tool === 'AskUserQuestion') return r;
    const prior = decided.recall(e.tool_use_id ?? '');
    if (prior) return prior;
    try {
      return await holdDecision($, e, r);
    } catch {
      return r;
    }
  });
};
