/**
 * Semantic checks on a thread projection, ported from T3's own testkit
 * (apps/server/src/orchestration-v2/testkit/fixtures/shared.ts at the pin:
 * assertSemanticProjectionIntegrity and assertTurnItemTypes). That module
 * imports T3's server internals and @effect/vitest, so it cannot be imported
 * from here; the rules are copied as they are, in vitest's expect.
 */
import { readFileSync } from "node:fs";

import {
  ProjectId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect } from "vitest";

import { type SseFrame, SseParser } from "../../src/lobby/wire.ts";
import { CLAUDE_INSTANCE_ID } from "../../src/serverConfig.ts";

export function assertSemanticProjectionIntegrity(projection: OrchestrationV2ThreadProjection) {
  for (const run of projection.runs) {
    expect(run.rootNodeId, `run ${run.id} must have a root node`).not.toBeNull();
    expect(
      projection.nodes.some((node) => node.id === run.rootNodeId && node.kind === "root_turn"),
      `run ${run.id} root node must exist`,
    ).toBe(true);
  }
  const rootNodes = projection.nodes.filter((node) => node.kind === "root_turn");
  expect(rootNodes.length).toBeGreaterThanOrEqual(projection.runs.length);
  for (const node of rootNodes) expect(node.countsForRun).toBe(true);
  for (const turn of projection.providerTurns) {
    expect(projection.nodes.some((node) => node.id === turn.nodeId)).toBe(true);
    expect(projection.providerThreads.some((t) => t.id === turn.providerThreadId)).toBe(true);
  }
  const ordinals = projection.turnItems.map((item) => item.ordinal);
  expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
  for (const item of projection.turnItems) {
    if (item.runId !== null) {
      expect(
        projection.runs.some((run) => run.id === item.runId),
        `item ${item.id} run`,
      ).toBe(true);
    }
    if (item.nodeId !== null) {
      expect(
        projection.nodes.some((node) => node.id === item.nodeId),
        `item ${item.id} node`,
      ).toBe(true);
    }
    if (item.providerTurnId !== null) {
      expect(
        projection.providerTurns.some((turn) => turn.id === item.providerTurnId),
        `item ${item.id} provider turn`,
      ).toBe(true);
    }
  }
  for (const message of projection.messages) {
    if (message.runId !== null) {
      expect(projection.runs.some((run) => run.id === message.runId)).toBe(true);
    }
    if (message.nodeId !== null) {
      expect(projection.nodes.some((node) => node.id === message.nodeId)).toBe(true);
    }
  }
  for (const request of projection.runtimeRequests) {
    const node = projection.nodes.find((n) => n.id === request.nodeId);
    expect(node, `runtime request ${request.id} node`).toBeDefined();
    if (
      node !== undefined &&
      (request.kind === "command" || request.kind === "file-read" || request.kind === "file-change")
    ) {
      expect(node.kind).toBe("approval_request");
    }
    if (request.providerTurnId !== null) {
      expect(projection.providerTurns.some((t) => t.id === request.providerTurnId)).toBe(true);
    }
  }
}

export function assertTurnItemTypes(
  projection: OrchestrationV2ThreadProjection,
  expected: ReadonlyArray<OrchestrationV2TurnItem["type"]>,
) {
  const actual = projection.turnItems.map((item) => item.type);
  for (const type of expected) expect(actual).toContain(type);
}

/** The visible rows' types in order, the way the timeline draws them. */
export const visibleTypes = (projection: OrchestrationV2ThreadProjection) =>
  projection.visibleTurnItems.map((row) => row.item.type);

export function readFrames(path: string): SseFrame[] {
  return new SseParser().feed(readFileSync(path, "utf8"));
}

export function fixture(name: string): SseFrame[] {
  return readFrames(new URL(`../fixtures/lobby/${name}`, import.meta.url).pathname);
}

export function testThread(id = "scratch"): OrchestrationV2AppThread {
  const at = DateTime.makeUnsafe(1_791_794_000_000);
  return {
    createdBy: "user",
    creationSource: "web",
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    title: "Scratch",
    providerInstanceId: CLAUDE_INSTANCE_ID,
    modelSelection: { instanceId: CLAUDE_INSTANCE_ID, model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}
