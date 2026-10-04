// The mod's types contract (plugin.json `types`): what it keeps in $.state,
// which the host holds for the session. A hot reload of the module keeps it
// where module variables are lost (measured on 2.1.289, 2026-10-04), so a
// turn in flight, the dialogs on screen and the workflow runs going survive
// a reload. The dialog shapes are the wire's own (lib/wire.ts builds on them).

// An AskUserQuestion on screen, as the `ask` event reported it.
export type TerminalLobbyAsk = { type: 'ask'; t: number; toolId: string; questions: unknown[] };

// A plan approval held in tool.check, as the `plan` event reported it.
export type TerminalLobbyPlan = { type: 'plan'; t: number; toolId: string; plan: string; planFilePath?: string };

// A permission prompt held in tool.check, as the `permission` event reported it.
export type TerminalLobbyPermission = {
  type: 'permission';
  t: number;
  toolId: string;
  tool: string;
  input: unknown;
  reason?: string;
  agentId?: string;
};

export type TerminalLobbyDialog = TerminalLobbyAsk | TerminalLobbyPlan | TerminalLobbyPermission;

// A workflow run the Workflow tool launched and no task notification has ended
// yet. `launchedAt` (ms) bounds how long it can be kept (lib/level.ts).
export type TerminalLobbyWorkflow = { id: string; name?: string; description?: string; launchedAt?: number };

// A text the mod saw and when (ms), as the level carries it.
export type TerminalLobbyText = { t: number; text: string };

export type TerminalLobbyLevel = {
  // The main loop's turn in flight, null between turns.
  mainTurn: string | null;
  // Dialogs open now, oldest first.
  dialogs: TerminalLobbyDialog[];
  // Those of them Claude drew itself after the mod's own dialog failed.
  native: string[];
  workflows: TerminalLobbyWorkflow[];
  // The last main-thread answer, and the newest PushNotification's message.
  reply?: TerminalLobbyText;
  notice?: TerminalLobbyText;
};

declare module 'claude-code' {
  interface PluginState {
    'terminal-lobby': { level: TerminalLobbyLevel };
  }
}
