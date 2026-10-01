/**
 * The question card's drafts and the held question (ADR-0034).
 *
 * The draft rules are T3 Code's (`apps/web/src/pendingUserInput.ts`), because
 * mirroring T3's card is the point: a custom answer wins over picks, a
 * single-select holds one pick, a multi-select toggles, and nothing is sent
 * until every question has an answer. That last rule matters more here than it
 * looks: Claude accepts a partial answer map and treats the missing questions
 * as skipped (measured on CLI 2.1.283), so a half-filled card must not send.
 */

import { questions, type Question } from "./canonicalize";
import type { Event } from "../types/events";

/** What the reader has chosen for one question so far. */
export interface Draft {
  selected: string[];
  custom: string;
}

/** Pick or unpick an option. A pick clears the custom answer. */
export function toggle(q: Question, d: Draft | undefined, label: string): Draft {
  if (!q.multiSelect) return { selected: [label], custom: "" };
  const was = d?.selected ?? [];
  return {
    selected: was.includes(label) ? was.filter((l) => l !== label) : [...was, label],
    custom: "",
  };
}

/**
 * Set the custom answer, which is what the card's "Type your own answer" field
 * holds. Words in it set the picks aside without dropping them: the answer is
 * the words while there are any, and clearing the field brings the ticks back.
 */
export function setCustom(d: Draft | undefined, custom: string): Draft {
  return { selected: d?.selected ?? [], custom };
}

/** Typed words as they go out: on one line, trimmed. */
function oneLine(words: string): string {
  return words.replace(/\s*\n\s*/g, " ").trim();
}

/** The answer a draft gives, or null while it gives none. */
export function resolveAnswer(q: Question, d: Draft | undefined): string[] | null {
  const custom = oneLine(d?.custom ?? "");
  if (custom) return [custom];
  const picks = (d?.selected ?? []).filter((l) => l.trim() !== "");
  if (picks.length === 0) return null;
  return q.multiSelect ? picks : [picks[0]!];
}

/** Every question's answer keyed by its text, or null while one has none. */
export function buildAnswers(
  qs: readonly Question[],
  drafts: Readonly<Record<string, Draft>>,
): Record<string, string[]> | null {
  const out: Record<string, string[]> = {};
  for (const q of qs) {
    const a = resolveAnswer(q, drafts[q.question]);
    if (!a) return null;
    out[q.question] = a;
  }
  return out;
}

/** A call's question texts joined, which is how a call is named: the hook's
 *  hold carries no tool id. */
const callKey = (qs: readonly Question[]): string => qs.map((q) => q.question).join("\u0000");

/** The calls a `held` body carries, oldest first. The server sends them under
 *  `calls`; a body from before that carries one call under `questions`. */
function callsOf(body: string): Question[][] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return [];
  }
  const list = (raw as { calls?: unknown } | null)?.calls;
  const calls = Array.isArray(list) ? list.map((c) => questions(c)) : [questions(raw)];
  return calls.filter((qs) => qs.length > 0);
}

/**
 * Every call the lobby's hook is holding, oldest first, from the newest `held`
 * event; empty when none is.
 *
 * Several at once is ordinary: Claude Code runs the hook for every
 * AskUserQuestion in one assistant message together, and the terminal shows
 * their menus one after another (measured 2026-10-01, grilling rounds of two
 * and three calls). The card answers the oldest, as the terminal does, and the
 * next takes its place.
 *
 * The server withdraws a hold itself, with a new `held` event. The two rules
 * below cover a client that never saw the withdrawal, a transcript cache from
 * before a service restart among them: no hold outlives its turn, and a call
 * goes once the AskUserQuestion result that answers it is in. A result is
 * placed by the call's question texts. One whose call cannot be read ends a
 * lone hold, as it always did, and leaves several standing, since it cannot
 * say which one it answered and the server's withdrawal follows anyway.
 * Anything else, the call's own record included, leaves the holds standing,
 * because the record often lands while the question is still waiting.
 */
export function heldCallsFromEvents(events: readonly Event[]): Question[][] {
  let calls: Question[][] = [];
  const asked = new Map<string, string | null>();
  for (const e of events) {
    if (e.kind === "meta" && e.meta === "held") {
      calls = e.body ? callsOf(e.body) : [];
      asked.clear();
      continue;
    }
    if (calls.length === 0) continue;
    if (e.kind === "turn_end") calls = [];
    else if (e.kind === "tool_use" && e.tool === "AskUserQuestion" && e.toolId) {
      let key: string | null = null;
      try {
        const qs = questions(JSON.parse(e.body ?? ""));
        if (qs.length > 0) key = callKey(qs);
      } catch {
        // an unreadable record names no call
      }
      asked.set(e.toolId, key);
    } else if (e.kind === "tool_result" && e.toolId && asked.has(e.toolId)) {
      const key = asked.get(e.toolId);
      if (key === null) {
        if (calls.length === 1) calls = [];
      } else {
        calls = calls.filter((qs) => callKey(qs) !== key);
      }
    }
  }
  return calls;
}

/** The oldest call the hook is holding, which is the one the card answers, or
 *  null when none is. */
export function heldFromEvents(events: readonly Event[]): Question[] | null {
  return heldCallsFromEvents(events)[0] ?? null;
}
