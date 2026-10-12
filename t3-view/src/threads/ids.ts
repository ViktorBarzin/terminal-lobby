/**
 * The T3 ids the sidecar mints for a lobby session's entities.
 *
 * Every id is derived from something the lobby already names, so a rebuild
 * of the same log (a reconnect, a sidecar restart) produces the same ids:
 * the thread key, the log's epoch, the run's ordinal, the lobby event id, or
 * Claude's own tool_use id. Ids only have to be unique within one thread, and
 * T3 treats them as opaque strings.
 */
import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

export const runId = (thread: ThreadId, epoch: string, ordinal: number): RunId =>
  RunId.make(`run:${thread}:${epoch}:${ordinal}`);
export const attemptId = (run: RunId): RunAttemptId => RunAttemptId.make(`${run}:attempt:1`);
export const rootNodeId = (run: RunId): NodeId => NodeId.make(`${run}:root`);
export const providerTurnId = (run: RunId): ProviderTurnId => ProviderTurnId.make(`${run}:turn`);
export const providerThreadId = (thread: ThreadId): ProviderThreadId =>
  ProviderThreadId.make(`provider-thread:${thread}`);

/** A turn item for one stored lobby event. */
export const eventItemId = (thread: ThreadId, epoch: string, eventId: number): TurnItemId =>
  TurnItemId.make(`item:${thread}:${epoch}:${eventId}`);
/** A turn item for one tool call, keyed by Claude's tool_use id. */
export const toolItemId = (thread: ThreadId, toolId: string): TurnItemId =>
  TurnItemId.make(`item:${thread}:tool:${toolId}`);
/** A turn item the sidecar synthesised (a stream block, a notice). */
export const syntheticItemId = (thread: ThreadId, epoch: string, n: number): TurnItemId =>
  TurnItemId.make(`item:${thread}:${epoch}:s${n}`);

export const eventMessageId = (thread: ThreadId, epoch: string, eventId: number): MessageId =>
  MessageId.make(`message:${thread}:${epoch}:${eventId}`);
export const syntheticMessageId = (thread: ThreadId, epoch: string, n: number): MessageId =>
  MessageId.make(`message:${thread}:${epoch}:s${n}`);

const REQUEST_PREFIX = "request:";
export const requestId = (toolId: string): RuntimeRequestId =>
  RuntimeRequestId.make(`${REQUEST_PREFIX}${toolId}`);
/** The tool_use id a runtime request answers, or undefined for an id this sidecar did not mint. */
export function toolIdOfRequest(id: string): string | undefined {
  return id.startsWith(REQUEST_PREFIX) && id.length > REQUEST_PREFIX.length
    ? id.slice(REQUEST_PREFIX.length)
    : undefined;
}
export const requestNodeId = (toolId: string): NodeId => NodeId.make(`node:request:${toolId}`);
export const planId = (toolId: string): PlanId => PlanId.make(`plan:${toolId}`);

export const domainEventId = (thread: ThreadId, n: string): EventId =>
  EventId.make(`event:${thread}:${n}`);
