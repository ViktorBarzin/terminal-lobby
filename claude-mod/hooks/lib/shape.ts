// Pure shaping: what the mod sends to session-events, and how answers from
// the web become results Claude Code accepts.

import type {
  DeltaEvent, HistoryEvent, ModelEvent, PromptEvent, ResultEvent, RowEvent, RowMessage, TurnEndEvent, TurnStartEvent,
} from './wire.ts';

// Any single string the mod forwards is cut to this many characters. The
// server reads the full value from the transcript by row id when it needs it.
export const TEXT_CAP = 256 * 1024;

const BACKOFF_FIRST_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

// Delay before retry number `attempt` (0-based): 1 s doubling to 30 s, with
// jitter between half and the full step.
export function backoffMs(attempt: number, random: () => number): number {
  const full = Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 16));
  return Math.round(full / 2 + random() * full / 2);
}

export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function transcriptPath(configDir: string, cwd: string, sid: string): string {
  return `${configDir.replace(/\/+$/, '')}/projects/${projectSlug(cwd)}/${sid}.jsonl`;
}

function base64Bytes(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - pad);
}

// Copies `value` with base64 payloads emptied: an image or document block's
// `source.data`, and any `base64` field (a Read tool's image result). The
// holder gains `bytes`, the decoded size.
export function stripMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMedia);
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = stripMedia(v);
  const source = obj.source as Record<string, unknown> | undefined;
  if (source && typeof source === 'object' && source.type === 'base64' && typeof source.data === 'string') {
    out.source = { ...source, data: '' };
    out.bytes = base64Bytes(source.data);
  }
  if (typeof obj.base64 === 'string' && obj.base64.length > 0) {
    out.base64 = '';
    out.bytes = base64Bytes(obj.base64);
  }
  return out;
}

// Copies `value` with every string longer than `max` cut, saying how much went.
export function capStrings(value: unknown, max = TEXT_CAP): unknown {
  if (typeof value === 'string') {
    return value.length > max ? `${value.slice(0, max)}\n[... ${value.length - max} more characters]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => capStrings(v, max));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = capStrings(v, max);
  return out;
}

// The most JSON one `history` event carries. A long session's history runs past
// the 4,194,304 characters Claude Code allows a mod's request body (an 11 MB
// transcript did on 2026-10-02), and a refused batch blocks everything queued
// behind it, so history goes out in chunks of this size.
export const HISTORY_CHUNK_CHARS = 800_000;

// How long one string in a history message may stay. The Text view shows 8 KiB
// of a tool result inline, so history carries enough to render and no more.
const HISTORY_STRING_CAP = 32 * 1024;

// A structured tool result bigger than this is dropped from history; its text
// still renders.
const HISTORY_RESULT_CAP = 64 * 1024;

type HistoryMessage = { toolUses?: Array<{ result?: unknown; [k: string]: unknown }>; [k: string]: unknown };

function trimHistoryMessage(m: unknown): unknown {
  const capped = capStrings(stripMedia(m), HISTORY_STRING_CAP) as HistoryMessage;
  if (!Array.isArray(capped?.toolUses)) return capped;
  return {
    ...capped,
    toolUses: capped.toolUses.map((u) =>
      u && u.result !== undefined && JSON.stringify(u.result ?? null).length > HISTORY_RESULT_CAP ? { ...u, result: null } : u),
  };
}

// The `history` events for what $.session.messages() returned: messages in
// order, trimmed, split into chunks under HISTORY_CHUNK_CHARS. Every chunk but
// the last carries `more: true`, and only the last says whether a main-thread
// turn is running, which is what lets the server close the last turn.
export function historyEvents(t: number, messages: unknown, running: boolean, last?: string): HistoryEvent[] {
  const list = Array.isArray(messages) ? messages.map(trimHistoryMessage) : [];
  const chunks: unknown[][] = [];
  let cur: unknown[] = [];
  let chars = 0;
  for (const m of list) {
    const n = JSON.stringify(m).length + 1;
    if (cur.length > 0 && chars + n > HISTORY_CHUNK_CHARS) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(m);
    chars += n;
  }
  chunks.push(cur);
  return chunks.map((c, i) =>
    i < chunks.length - 1
      ? { type: 'history', t, messages: c, running, more: true }
      : { type: 'history', t, messages: c, running, ...(last ? { last } : {}) });
}

type AppendIn = { door: string; origin: unknown; uuid: string; agentId?: string };
type StoredRow = {
  uuid: string;
  message: { type: string; name?: string; role?: string; isMeta?: boolean; content: unknown };
};

// The `row` event for a row as session.append stored it.
export function shapeRow(e: AppendIn, stored: StoredRow, t: number): RowEvent {
  const m = stored.message;
  const message: RowMessage = { type: m.type, content: null };
  if (m.name !== undefined) message.name = m.name;
  if (m.role !== undefined) message.role = m.role;
  if (m.isMeta !== undefined) message.isMeta = m.isMeta;
  message.content = capStrings(stripMedia(m.content));
  const ev: RowEvent = { type: 'row', t, uuid: stored.uuid || e.uuid, door: e.door, origin: e.origin, message };
  if (e.agentId !== undefined) ev.agentId = e.agentId;
  return ev;
}

type ToolIn = { tool: string; tool_use_id: string; agentId?: string };
type ToolOut = { result?: unknown; text?: string; isError?: boolean; deny?: string; ref?: number; isReadOnly?: boolean };

// The `result` event for a finished tool call. A denial reads as an error
// whose text is the reason.
export function shapeResult(e: ToolIn, r: ToolOut, t: number): ResultEvent {
  const ev: ResultEvent = { type: 'result', t, toolId: e.tool_use_id, tool: e.tool, result: null };
  if (e.agentId !== undefined) ev.agentId = e.agentId;
  if (typeof r.deny === 'string') {
    ev.text = capStrings(r.deny) as string;
    ev.isError = true;
    return ev;
  }
  ev.result = capStrings(stripMedia(r.result ?? null));
  if (r.text !== undefined) ev.text = capStrings(r.text) as string;
  if (r.isError) ev.isError = true;
  return ev;
}

// The `turn_start` event for a main-thread turn.start (the only loop that
// raises one, measured 2026-10-04).
export function shapeTurnStart(e: { turnId: string; text: string }, t: number): TurnStartEvent {
  return { type: 'turn_start', t, turnId: e.turnId, text: capStrings(e.text) as string };
}

type TurnEndIn = { turnId: string; agentId?: string; isAborted: boolean; answer: string; usage?: unknown; durationMs: number };

// The `turn_end` event for a turn.complete, main or subagent.
export function shapeTurnEnd(e: TurnEndIn, t: number): TurnEndEvent {
  const ev: TurnEndEvent = {
    type: 'turn_end', t, turnId: e.turnId, aborted: e.isAborted, answer: capStrings(e.answer) as string, durationMs: e.durationMs,
  };
  if (e.agentId !== undefined) ev.agentId = e.agentId;
  if (e.usage !== undefined) ev.usage = e.usage;
  return ev;
}

// The `delta` event for one streamed text or thinking chunk of a turn.step.
export function shapeDelta(
  e: { turnId: string; index: number; agentId?: string },
  chunk: { index: number; kind: 'text' | 'thinking'; text: string },
  t: number,
): DeltaEvent {
  const ev: DeltaEvent = { type: 'delta', t, turnId: e.turnId, step: e.index, index: chunk.index, kind: chunk.kind, text: chunk.text };
  if (e.agentId !== undefined) ev.agentId = e.agentId;
  return ev;
}

// The `model` event. An effort the engine gives as a number goes as its digits:
// the server reads a string.
export function shapeModel(model: string, effort: string | number | undefined, t: number): ModelEvent {
  return effort === undefined ? { type: 'model', t, model } : { type: 'model', t, model, effort: String(effort) };
}

// The `prompt` event for a prompt as it entered.
export function shapePrompt(text: string, origin: unknown, t: number): PromptEvent {
  return { type: 'prompt', t, text: capStrings(text) as string, origin };
}

type Question = { question: string };

export type QuestionResult<Q extends Question = Question> = { questions: Q[]; answers: Record<string, string>; annotations: Record<string, unknown> };

// The AskUserQuestion result for an answer given on the web. The server sends
// answers keyed by the exact question text, a multi-select already joined as
// "A, B"; they pass through as given (a list is joined the same way).
export function webAnswerResult<Q extends Question>(questions: Q[], answers: unknown, annotations: unknown): QuestionResult<Q> {
  const given = (answers && typeof answers === 'object' ? answers : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [question, a] of Object.entries(given)) {
    if (Array.isArray(a)) out[question] = a.map(String).join(', ');
    else if (typeof a === 'string') out[question] = a;
  }
  const notes = (annotations && typeof annotations === 'object' ? annotations : {}) as Record<string, unknown>;
  return { questions, answers: out, annotations: notes };
}

// What tool.call returns for an `answer` command: the card's "Chat about
// this" (`chat`, the server's full message text) denies the call with that
// text verbatim; otherwise the answers become the result.
export function webAnswer<Q extends Question>(
  questions: Q[],
  c: { [field: string]: unknown },
): { deny: string } | { result: QuestionResult<Q> } {
  if (typeof c.chat === 'string') return { deny: c.chat };
  return { result: webAnswerResult(questions, c.answers, c.annotations) };
}

export const PLAN_APPROVE = 'Approve plan';
export const PLAN_KEEP = 'Keep planning';
export const PERMISSION_ALLOW = 'Allow';
export const PERMISSION_DENY = 'Deny';

const SUMMARY_CAP = 240;
const PLAN_SHOWN_CAP = 4000;

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

// One line saying what a tool call will do, for the terminal dialog.
export function summarizeInput(tool: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'path', 'query']) {
    if (typeof i[key] === 'string' && i[key]) return clip(i[key] as string, SUMMARY_CAP);
  }
  let json = '';
  try {
    json = JSON.stringify(input) ?? '';
  } catch {
    json = String(input);
  }
  return clip(json, SUMMARY_CAP) || tool;
}

// The terminal dialog the mod draws while a plan or a permission is held.
export function dialogFor(tool: string, input: unknown): { question: string; header: string; options: [string, string] } {
  if (tool === 'ExitPlanMode') {
    const plan = String((input as { plan?: unknown } | null)?.plan ?? '').trim();
    const shown = plan.length > PLAN_SHOWN_CAP
      ? `${plan.slice(0, PLAN_SHOWN_CAP)}\n[... the rest of the plan: /plan to read it all]`
      : plan;
    const question = shown ? `${shown}\n\nClaude has finished planning. Approve the plan?` : 'Claude has finished planning. Approve the plan?';
    return { question, header: 'Plan', options: [PLAN_APPROVE, PLAN_KEEP] };
  }
  return {
    question: `Allow ${tool}: ${summarizeInput(tool, input)}?`,
    header: 'Permission',
    options: [PERMISSION_ALLOW, PERMISSION_DENY],
  };
}

const OWN_DIALOGS: Record<string, readonly [string, string]> = {
  Plan: [PLAN_APPROVE, PLAN_KEEP],
  Permission: [PERMISSION_ALLOW, PERMISSION_DENY],
};

// True when an AskUserQuestion is one of the mod's own dialogs ($.ui.ask
// raises it as a tool.call, id `toolu_plugin_…`): one question with the mod's
// header and exactly its two options. Judged from the dialog alone, so any
// loaded copy of the mod recognises it, not only the one that drew it.
export function isOwnDialog(questions: readonly unknown[]): boolean {
  if (questions.length !== 1) return false;
  const q = questions[0] as { header?: unknown; options?: unknown } | null;
  const expected = typeof q?.header === 'string' ? OWN_DIALOGS[q.header] : undefined;
  if (!expected || !Array.isArray(q?.options) || q.options.length !== expected.length) return false;
  return q.options.every((o, i) => (o as { label?: unknown } | null)?.label === expected[i]);
}

export type Decision ={ decision: 'allow' } | { decision: 'deny'; reason: string };

// Words a person sent back on the plan dialog, framed as theirs. Claude sees a
// denial as "Permission to use ExitPlanMode denied by plugins ...: <reason>",
// and with the bare words as the reason it re-submitted the same plan and
// once called them injected (measured live on 2026-10-02).
function planFeedback(words: string): string {
  return `The user reviewed the plan and wants changes before you start: ${words}\n`
    + 'These are their words from the plan dialog. Revise the plan to address them, then present it again with ExitPlanMode.';
}

// What the model reads with an approved plan's tool result when the person
// approved it from the web with words of their own (wire contract v3, item 8).
// It lands in the same turn, before Claude starts on the plan; a follow-up
// prompt arrived only after the whole plan had been carried out (D-F2).
export function planApprovalContext(words: string): string {
  return `The user approved the plan with these words from the plan dialog: ${words}\n`
    + 'Take them into account as you carry out the plan.';
}

// What the person picked in the terminal dialog, as a tool.check result. Text
// typed under "Other" denies and passes the text to the model as the reason.
export function decisionFromLabel(tool: string, label: string): Decision {
  if (label === PLAN_APPROVE || label === PERMISSION_ALLOW) return { decision: 'allow' };
  if (label === PLAN_KEEP) return { decision: 'deny', reason: 'The user wants to keep planning. Do not start on the plan yet.' };
  if (label === PERMISSION_DENY) return { decision: 'deny', reason: `The user denied this ${tool} call.` };
  return { decision: 'deny', reason: tool === 'ExitPlanMode' ? planFeedback(label) : label };
}

// A `decide` command from the web, as a tool.check result.
export function decisionFromWeb(tool: string, decision: unknown, reason: unknown): Decision {
  if (decision === 'allow') return { decision: 'allow' };
  const text = typeof reason === 'string' && reason.trim() ? reason.trim() : '';
  if (text) return { decision: 'deny', reason: tool === 'ExitPlanMode' ? planFeedback(text) : text };
  return decisionFromLabel(tool, tool === 'ExitPlanMode' ? PLAN_KEEP : PERMISSION_DENY);
}
