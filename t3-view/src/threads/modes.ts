/**
 * Claude Code's permission modes against T3's runtime and interaction modes.
 *
 * T3 has one table for Claude (the design's "Permission modes"): plan is an
 * interaction mode, the rest are runtime modes. The lobby reports the mode
 * by the CLI's own identifiers, and its status line says "manual" where the
 * CLI's settings say "default" (session-events mode.go accepts both).
 * `dontAsk` has no T3 counterpart: it shows as approval-required, and the
 * mapper adds a notice row saying it was set outside T3.
 */
import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

export interface T3Modes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** True for a mode T3 cannot show (dontAsk). */
  readonly outsideT3: boolean;
}

export function modesFromLobby(mode: string, current: T3Modes): T3Modes {
  switch (mode) {
    case "plan":
      return { runtimeMode: current.runtimeMode, interactionMode: "plan", outsideT3: false };
    case "default":
    case "manual":
      return { runtimeMode: "approval-required", interactionMode: "default", outsideT3: false };
    case "acceptEdits":
      return { runtimeMode: "auto-accept-edits", interactionMode: "default", outsideT3: false };
    case "auto":
      return { runtimeMode: "auto", interactionMode: "default", outsideT3: false };
    case "bypassPermissions":
      return { runtimeMode: "full-access", interactionMode: "default", outsideT3: false };
    case "dontAsk":
      return { runtimeMode: "approval-required", interactionMode: "default", outsideT3: true };
    default:
      return current;
  }
}

/** The lobby mode (POST /model {mode}) for a T3 runtime mode. */
export function lobbyModeFor(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "approval-required":
      return "manual";
    case "auto-accept-edits":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "full-access":
      return "bypassPermissions";
  }
}

/** The lobby mode for a T3 interaction mode, given the runtime mode to return to. */
export function lobbyModeForInteraction(
  interactionMode: ProviderInteractionMode,
  runtimeMode: RuntimeMode,
): string {
  return interactionMode === "plan" ? "plan" : lobbyModeFor(runtimeMode);
}
