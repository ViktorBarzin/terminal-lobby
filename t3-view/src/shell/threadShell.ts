/**
 * A directory entry as T3's thread (AppThread) and as a sidebar row
 * (ThreadShell). The row takes its live fields (the active run, a pending
 * request, the last message) from the thread's projection when the thread is
 * open, and from the session list's state otherwise.
 */
import type {
  OrchestrationV2AppThread,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { LOBBY_CLAUDE_MODELS } from "../models.ts";
import { CLAUDE_INSTANCE_ID } from "../serverConfig.ts";
import type { DirectoryEntry } from "./directory.ts";

const utcSeconds = (s: number | undefined) => DateTime.makeUnsafe(Math.max(0, s ?? 0) * 1000);

export function titleOf(entry: DirectoryEntry): string {
  const t = entry.session.title?.trim();
  return t === undefined || t === "" ? entry.name : t;
}

export function appThreadOf(entry: DirectoryEntry): OrchestrationV2AppThread {
  const created = utcSeconds(entry.session.created);
  return {
    createdBy: "user",
    creationSource: "web",
    id: entry.threadId,
    projectId: entry.projectId,
    title: titleOf(entry),
    providerInstanceId: CLAUDE_INSTANCE_ID,
    modelSelection: {
      instanceId: CLAUDE_INSTANCE_ID,
      model: LOBBY_CLAUDE_MODELS[0]?.slug ?? "claude",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: entry.threadId },
    forkedFrom: null,
    createdAt: created,
    updatedAt: utcSeconds(entry.session.lastDrive ?? entry.session.created),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function statusFromLobby(state: string | undefined): OrchestrationV2ThreadShell["status"] {
  if (state === "running") return "running";
  if (state === "awaiting") return "waiting";
  return "idle";
}

const ACTIVE = new Set(["preparing", "starting", "running", "waiting"]);

export function threadShellOf(
  entry: DirectoryEntry,
  projection: OrchestrationV2ThreadProjection | undefined,
): OrchestrationV2ThreadShell {
  const thread = projection?.thread ?? appThreadOf(entry);
  const runs = projection?.runs ?? [];
  const active = runs.findLast((r) => ACTIVE.has(r.status));
  const latest = runs.findLast((r) => r.status !== "queued" && r.status !== "cancelled");
  const pending = projection?.runtimeRequests.find((r) => r.status === "pending");
  const lastMessage = projection?.messages.findLast((m) => m.text.trim() !== "");
  const lastUser = projection?.messages.findLast((m) => m.role === "user" && m.text.trim() !== "");
  const activityStatus =
    active !== undefined &&
    (active.status === "preparing" ||
      active.status === "starting" ||
      active.status === "running" ||
      active.status === "waiting")
      ? active.status
      : null;
  const drive = utcSeconds(entry.session.lastDrive ?? entry.session.created);
  return {
    createdBy: "user",
    creationSource: "web",
    id: entry.threadId,
    projectId: entry.projectId,
    title: titleOf(entry),
    providerInstanceId: CLAUDE_INSTANCE_ID,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: null,
    worktreePath: null,
    lineage: thread.lineage,
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    activityRunStartedAt: active?.startedAt ?? null,
    activityRunStatus: activityStatus,
    status:
      projection === undefined
        ? statusFromLobby(entry.session.state)
        : pending !== undefined
          ? "waiting"
          : (active?.status ?? "idle"),
    pendingRuntimeRequest:
      pending === undefined
        ? null
        : { id: pending.id, kind: pending.kind, createdAt: pending.createdAt },
    latestVisibleMessage:
      lastMessage === undefined
        ? null
        : {
            id: lastMessage.id,
            role: lastMessage.role,
            text: lastMessage.text.slice(0, 400),
            updatedAt: lastMessage.updatedAt,
          },
    latestUserMessageAt: lastUser?.createdAt ?? drive,
    hasActionableProposedPlan: false,
    itemCount: projection?.turnItems.length ?? 0,
    visibleItemCount: projection?.visibleTurnItems.length ?? 0,
    createdAt: thread.createdAt,
    updatedAt: drive,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
}
