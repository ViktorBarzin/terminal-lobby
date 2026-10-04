// terminal-lobby mod: reports a Claude session to session-events and acts on
// it for the lobby. Wire protocol: docs/adr/0036-claude-speaks-to-the-lobby-through-a-mod.md.
// This file wires Claude Code events to the logic in ./lib; keep logic there.

import type { EngineInterface, Register } from 'claude-code';
import type { TerminalLobbyLevel } from './state.d.ts';
import { Link } from './lib/link.ts';
import { Pending } from './lib/pending.ts';
import { SeenCommands } from './lib/seen.ts';
import { TranscriptStamp } from './lib/stamp.ts';
import { SummaryOnce, summaryFrom, summaryRequest } from './lib/summary.ts';
import { steer } from './lib/steer.ts';
import { Level } from './lib/level.ts';
import {
  type CheckResult, type Command, type DialogDeps, Holds, OwnDialogs, holdDecision, ownDialog, raceQuestion,
} from './lib/dialogs.ts';
import { type CommandDeps, OPS, runCommand } from './lib/commands.ts';
import { endSession } from './lib/lifecycle.ts';
import { portOf, trustedListener } from './lib/listener.ts';
import { type EventBody, type LevelEvent, type ModEvent, MOD_VERSION, toAgents } from './lib/wire.ts';
import {
  isOwnDialog, planApprovalContext, shapeDelta, shapeModel, shapePrompt, shapeResult, shapeRow, shapeTurnEnd,
  shapeTurnStart, transcriptPath,
} from './lib/shape.ts';

const DEFAULT_URL = 'http://127.0.0.1:7685';
const DRAIN_MS = 1500;
// The level goes out on every edge, and this often besides while the link is
// up, so a server that missed an edge is corrected within this long.
const LEVEL_EVERY_MS = 30_000;
// Random per module load: a server that sees it change resets what it folded
// for this conversation and asks for a whole snapshot.
const INSTANCE = crypto.randomUUID();
// What survives a hot reload (hooks/state.d.ts).
const LEVEL_STATE = { plugin: 'terminal-lobby', key: 'level' } as const;

// One set per module instance: a hot reload starts over with a fresh
// session.start, and what must survive it is in `level`, saved to $.state.
let link: Link | null = null;
let lastModel = '';
let tmuxSession = '';
// The conversation a /clear or a resume just ended: no hello may name it.
let endedSid = '';
// Where this session's transcript will be, and whether the last hello named it.
let transcriptFile = async (): Promise<string> => '';
const stamp = new TranscriptStamp();
// Writes what `level` saves into $.state, in order; set once the link starts.
let persist: (saved: TerminalLobbyLevel) => void = () => {};
// Resolves once every write asked of $.state so far has landed. The turn hooks
// await it: the engine reloads a mod at a turn's end, and a reload that
// cancelled a pending write would restore the turn as still running.
let saving: Promise<void> = Promise.resolve();
const level = new Level((saved) => persist(saved));
// Bumped when a conversation ends, so work it started (its summary) is not
// reported as the next one's.
let conversation = 0;
// Sends a level now; set once the link starts.
let sendLevel: () => void = () => {};
// Web answers for dialogs on screen, keyed by tool_use_id.
const webAnswers = new Pending<Command>();
const own = new OwnDialogs();
const holds = new Holds<CheckResult>();
// Words sent with a plan approval from the web, by the plan's tool_use_id.
const planFeedback = new Map<string, string>();
// Commands already run here, so one sent again after a re-hello is only re-acked.
const seenCommands = new SeenCommands();
// Whether this conversation still owes its summary (lib/summary.ts).
const summary = new SummaryOnce();
let dialogDeps: DialogDeps | null = null;
let commandDeps: CommandDeps | null = null;

const now = () => Date.now();

// Stamps an event with the time now, unless it carries its own: a level's
// reply and notice repeat the t of the turn_end and row that carried them, and
// the server writes again only when that t moves (session-events modstate.go).
function send(ev: EventBody | ModEvent): void {
  try {
    link?.send({ t: now(), ...ev });
  } catch {
    // Reporting never gets in Claude's way.
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function levelEvent($: EngineInterface): Promise<LevelEvent> {
  const listed = toAgents(await $.agent.list());
  level.listed(listed.map((a) => a.id));
  return level.level(level.agents(listed), now());
}

// Asks for a one-line summary of the conversation's first prompt and sends it
// for the session's title. Claude Code writes its own only for a typed prompt.
async function sendSummary($: EngineInterface, text: string): Promise<void> {
  const asked = conversation;
  try {
    const r = await $.model.complete(summaryRequest(text));
    const title = r.isAnswered ? summaryFrom(r.text) : '';
    if (title && asked === conversation) send({ type: 'summary', text: title });
  } catch {
    // An untitled session keeps its prompt line in the lobby, as before.
  }
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
  const override = await $.env.get('TL_MOD_URL');
  const base = (override || DEFAULT_URL).replace(/\/+$/, '');
  const home = (await $.env.get('HOME')) || '';
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`;
  tmuxSession = await tmuxSessionName($, pane);
  transcriptFile = async () => transcriptPath(configDir, startCwd, await $.session.id());

  persist = (saved) => {
    saving = saving.then(() => $.state.set(LEVEL_STATE, saved)).then(() => {}, () => {});
  };
  level.restore((await $.state.get(LEVEL_STATE)).value, now());
  sendLevel = () => {
    levelEvent($).then((ev) => link?.send(ev), () => {});
  };

  dialogDeps = {
    announce: (ev) => {
      level.open(ev);
      link?.send(ev);
    },
    settled: (toolId, by) => {
      level.settle(toolId);
      send({ type: 'settled', toolId, by });
      sendLevel();
    },
    handOver: (toolId) => { level.handOver(toolId); },
    web: webAnswers,
    own,
    ask: (question, options) => $.ui.ask(question, options),
    now,
    agentOf: (toolId) => level.agentOf(toolId),
    feedback: (toolId, words) => { planFeedback.set(toolId, words); },
  };
  commandDeps = {
    send,
    seen: seenCommands,
    commandNames: async () => (await $.command.list()).map((x) => x.name),
    runSlash: (call) => $.command.run(call),
    submit: (text) => $.prompt.submit({ text, asUser: true }),
    turns: () => $.session.turns(),
    summary,
    summarize: (text) => { void sendSummary($, text); },
    mainTurn: () => level.mainTurn,
    abort: (turnId) => $.turn.abort({ turnId }),
    answer: (toolId, c) => webAnswers.resolve(toolId, c),
    steer: (agentId, text) => steer({ list: () => $.agent.list(), send: (args) => $.session.send(args) }, agentId, text),
  };

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
    // A server address the person set by hand is theirs to choose; the
    // default port is trusted only while root holds it (lib/listener.ts).
    trusted: override ? undefined : () => trustedListener((path) => $.fs.read(path), portOf(base)),
    hello: async () => {
      const sid = await $.session.id();
      if (sid === endedSid) throw new Error('the session still names the conversation that ended');
      tmuxSession = (await tmuxSessionName($, pane)) || tmuxSession;
      const transcript = await findTranscript($, configDir, startCwd, sid);
      stamp.hello(transcript !== '');
      return {
        sid,
        pane,
        tmux: (await $.env.get('TMUX')) || '',
        session: tmuxSession,
        cwd: await $.session.cwd(),
        ...(transcript ? { transcript } : {}),
        model: await $.session.model(),
        version: (await $.session.version()).version,
        mod: MOD_VERSION,
        instance: INSTANCE,
        ops: OPS,
      };
    },
    // The `history` event's fields: what the session holds, and whether a
    // main-thread turn is running (the server closes the last turn when not).
    history: async () => ({ messages: await $.session.messages(), running: level.mainTurn !== null }),
    open: () => level.dialogs(),
    level: () => levelEvent($),
    onCommand: (c) => { if (commandDeps) void runCommand(commandDeps, c as Command); },
  });
  $.clock.after(1, () => link?.start());
  $.clock.every(LEVEL_EVERY_MS, () => {
    level.expire(now());
    sendLevel();
  });
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
    const l = link;
    if (!l) return next(e);
    return endSession({
      bye: (reason, sid) => send({ type: 'bye', reason, sid }),
      drain: () => l.drain(DRAIN_MS),
      forget: () => {
        conversation++;
        l.forgetConversation();
        level.reset();
        summary.reset();
        planFeedback.clear();
        lastModel = '';
      },
      rehello: (sid) => {
        endedSid = sid;
        l.rehello();
      },
      stop: () => l.stop(),
    }, e, () => next(e));
  });

  on('prompt.submit', ($, e, next) => {
    if (link) {
      send(shapePrompt(e.text, e.origin, now()));
      if (level.promptSubmitted(e.turnId, e.text)) sendLevel();
    }
    return next(e);
  });

  on('session.append', async ($, e, next) => {
    const r = await next(e);
    if (link && r.message) {
      try {
        const t = now();
        level.rowSeen(e.agentId, r.message.content, t);
        send(shapeRow(e, r, t));
      } catch { /* never block a row */ }
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

  // Raised for the main loop only (measured 2026-10-04): a subagent's loop
  // starts with a turn.step that carries its agentId.
  on('turn.start', async ($, e, next) => {
    if (link) {
      try {
        level.turnStarted(e.turnId);
        send(shapeTurnStart(e, now()));
        sendLevel();
        await saving;
        const pane = await $.env.get('TMUX_PANE');
        const name = pane ? await tmuxSessionName($, pane) : '';
        if (name && name !== tmuxSession) {
          tmuxSession = name;
          link.rehello();
        }
      } catch { /* reporting only */ }
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    if (link) {
      try {
        const t = now();
        level.answered(e.agentId, e.answer, t);
        level.turnEnded(e.turnId, e.agentId);
        if (e.agentId === undefined) planFeedback.clear();
        send(shapeTurnEnd(e, t));
        sendLevel();
        await saving;
      } catch { /* reporting only */ }
    }
    return r;
  });

  // /compact runs no turn of the main loop (measured 2026-10-04), so without
  // this the session read done for the half minute Claude was busy (L-F10).
  // A precompute installs nothing and can run while the session waits.
  on('session.compact', async ($, e, next) => {
    if (!link || e.agentId !== undefined || e.trigger === 'precompute') return next(e);
    level.compacting(true);
    sendLevel();
    try {
      return await next(e);
    } finally {
      level.compacting(false);
      sendLevel();
    }
  });

  on('turn.step', async function* ($, e, next) {
    const live = link !== null;
    if (live) {
      if (level.stepped(e.turnId, e.agentId, now())) sendLevel();
      if (e.agentId === undefined) {
        const key = `${e.model}|${e.effort ?? ''}`;
        if (key !== lastModel) {
          lastModel = key;
          send(shapeModel(e.model, e.effort, now()));
        }
      }
    }
    const stream = next(e);
    for (;;) {
      const { value, done } = await stream.next();
      if (done) return value;
      if (live && (value.kind === 'text' || value.kind === 'thinking') && value.text) {
        send(shapeDelta(e, { index: value.index, kind: value.kind, text: value.text }, now()));
      }
      yield value;
    }
  });

  on('tool.call', async ($, e, next) => {
    if (!link) return next(e);
    if (e.tool === 'AskUserQuestion') {
      const questions = e.questions;
      // A mod dialog ($.ui.ask) is never reported: no ask, settled or result.
      // The copy that drew it can take it down; any other copy lets it be.
      const takenDown = own.get(questions[0]?.question ?? '');
      if (takenDown) return ownDialog({ questions }, takenDown, () => next(e));
      if (isOwnDialog(questions)) return next(e);
    }
    if (level.toolStarted(e.tool_use_id, e.agentId)) sendLevel();
    try {
      if (e.tool === 'AskUserQuestion' && e.agentId === undefined && dialogDeps) {
        try {
          const r = await raceQuestion(dialogDeps, { tool_use_id: e.tool_use_id, questions: e.questions }, () => next(e));
          send(shapeResult(e, r, now()));
          return r;
        } catch (err) {
          send(shapeResult(e, { isError: true, text: errorText(err) }, now()));
          throw err;
        }
      }
      const r = await next(e);
      send(shapeResult(e, r, now()));
      // A background agent is listed as soon as its Agent call returns.
      if (e.tool === 'Agent') sendLevel();
      if (e.tool === 'Workflow' && level.workflowLaunched(r.result, now())) sendLevel();
      const words = planFeedback.get(e.tool_use_id);
      if (e.tool === 'ExitPlanMode' && words !== undefined && r.deny === undefined) {
        planFeedback.delete(e.tool_use_id);
        return { ...r, context: [...(r.context ?? []), planApprovalContext(words)] };
      }
      return r;
    } finally {
      if (level.toolEnded(e.tool_use_id)) sendLevel();
    }
  });

  on('tool.check', async ($, e, next) => {
    const r = await next(e);
    // AskUserQuestion's own menu is its permission prompt: let Claude draw it
    // (tool.call races it against the web). The mod's $.ui.ask comes here too.
    if (!link || !dialogDeps || r.decision !== 'ask' || e.tool === 'AskUserQuestion') return r;
    // A check with no tool call behind it is another plugin's query: never
    // held, never shown to anyone (D-F6).
    const toolId = e.tool_use_id;
    if (!toolId) return r;
    const deps = dialogDeps;
    try {
      return await holds.run(toolId, () => holdDecision(deps, { tool: e.tool, input: e.input, tool_use_id: toolId }, r));
    } catch {
      return r;
    }
  });
};
