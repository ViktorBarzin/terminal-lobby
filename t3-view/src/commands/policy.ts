/**
 * Which way a T3 message goes into a lobby session, and how T3's answers
 * become the lobby's.
 *
 * resolveDispatchMode is T3's own rule (apps/server/src/orchestration-v2/
 * CommandPolicy.ts resolveMessageDispatchIntent at the pin): an explicit
 * deliveryIntent overrides the requested mode; with no active run anything
 * starts; "auto" queues behind a run still starting and otherwise follows the
 * provider's capabilities. A lobby session is always Claude Code, whose T3
 * adapter steers an active run, so "auto" steers.
 */
import type {
  OrchestrationV2Command,
  OrchestrationV2Run,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";

import type { HeldQuestion } from "../threads/mapper.ts";

export type DispatchMode = Extract<
  OrchestrationV2Command,
  { type: "message.dispatch" }
>["dispatchMode"];

const ACTIVE = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export function resolveDispatchMode(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status">>,
  requested: DispatchMode,
  deliveryIntent: "auto" | "steer" | "restart" | undefined,
): DispatchMode {
  if (deliveryIntent === undefined) return requested;
  const active = runs.findLast((run) => ACTIVE.has(run.status));
  if (active === undefined) return { type: "start_immediately" };
  if (deliveryIntent === "steer") return { type: "steer_active", targetRunId: active.id };
  if (deliveryIntent === "restart") return { type: "restart_active", targetRunId: active.id };
  if (active.status === "preparing" || active.status === "starting") {
    return { type: "queue_after_active" };
  }
  return { type: "steer_active", targetRunId: active.id };
}

/** promptonce.go accepts 1-64 of [A-Za-z0-9_-] as a prompt id. */
export function promptIdOf(commandId: string): string | undefined {
  const id = commandId.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return id === "" ? undefined : id;
}

/** T3's approval decision as the lobby's answer body for a permission prompt or a plan. */
export function approvalAnswer(
  kind: "permission" | "plan",
  toolId: string,
  decision: ProviderApprovalDecision,
): Readonly<Record<string, unknown>> {
  const accept =
    decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";
  if (kind === "plan") {
    return {
      toolId,
      plan: accept ? { option: 1, label: "Approve plan" } : { option: 2, label: "Keep planning" },
    };
  }
  return { toolId, permission: { option: accept ? 1 : 2 } };
}

function picks(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(picks);
  if (typeof value === "object" && value !== null) {
    // A custom answer can arrive as { label } or { text } from newer clients.
    const o = value as Record<string, unknown>;
    return picks(o.label ?? o.text ?? o.value ?? o.answer);
  }
  return [];
}

/**
 * T3's answers (keyed by the question ids the mapper gave: the question text)
 * as the lobby's AnswerRequest.answers, or undefined when a question has none.
 */
export function questionAnswers(
  questions: ReadonlyArray<HeldQuestion>,
  answers: ProviderUserInputAnswers,
): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const q of questions) {
    const got = picks(answers[q.question.trim()] ?? answers[q.question]);
    if (got.length === 0) return undefined;
    out[q.question] = got;
  }
  return out;
}
