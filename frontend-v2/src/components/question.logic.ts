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

/** Set the custom answer. Words in it set the picks aside; a blank one keeps them. */
export function setCustom(d: Draft | undefined, custom: string): Draft {
  return { selected: custom.trim() ? [] : (d?.selected ?? []), custom };
}

/** The answer a draft gives, or null while it gives none. */
export function resolveAnswer(q: Question, d: Draft | undefined): string[] | null {
  const custom = d?.custom.trim() ?? "";
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

/**
 * The question the lobby's hook is holding, from the newest `held` event, or
 * null when none is.
 *
 * The server withdraws a hold itself, with an empty `held` event. The two
 * rules below cover a client that never saw the withdrawal, a transcript cache
 * from before a service restart among them: a hold cannot outlive its turn, or
 * the AskUserQuestion result that answers it. Anything else, the call's own
 * record included, leaves it standing, because the record often lands while
 * the question is still waiting.
 */
export function heldFromEvents(events: readonly Event[]): Question[] | null {
  let body = "";
  const asked = new Set<string>();
  for (const e of events) {
    if (e.kind === "meta" && e.meta === "held") {
      body = e.body ?? "";
      asked.clear();
      continue;
    }
    if (!body) continue;
    if (e.kind === "turn_end") body = "";
    else if (e.kind === "tool_use" && e.tool === "AskUserQuestion" && e.toolId) asked.add(e.toolId);
    else if (e.kind === "tool_result" && e.toolId && asked.has(e.toolId)) body = "";
  }
  if (!body) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const qs = questions(raw);
  return qs.length > 0 ? qs : null;
}
