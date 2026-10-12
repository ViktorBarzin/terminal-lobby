/**
 * The shell: the projects and threads the sidebar lists.
 *
 * Stage 2 has no lobby data yet, so the shell is one project and no threads.
 * The project matters: with no projects at all the web client's first-run gate
 * decides the workspace is fresh and shows the welcome wizard
 * (apps/web/src/onboarding/firstRun.logic.ts). Stage 3 replaces this source
 * with the user's lobby projects (tmux-api /projects) and Claude sessions.
 */
import { type OrchestrationV2ShellSnapshot, ProjectId } from "@t3tools/contracts";

export const SHELL_SCHEMA_VERSION = 2;

export interface ShellContext {
  readonly osUser: string;
  readonly snapshotSequence: number;
  readonly startedAt: string;
}

export function placeholderShell(context: ShellContext): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: SHELL_SCHEMA_VERSION,
    snapshotSequence: context.snapshotSequence,
    threads: [],
    archivedThreads: [],
    projects: [
      {
        id: ProjectId.make("lobby-home"),
        title: "Lobby",
        workspaceRoot: `/home/${context.osUser}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: context.startedAt,
        updatedAt: context.startedAt,
      },
    ],
  };
}
