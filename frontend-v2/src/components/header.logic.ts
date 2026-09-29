import type { BackgroundWork, ClaudeState, SessionTool } from "../types/lobby";
import { backgroundLabel } from "./lobby.logic";

/**
 * The dot in front of the session bar's subtitle. `working` pulses; the rest
 * are still (sidebar.css, `.tl-bar-state`).
 */
export type HeaderDot = "idle" | "working" | "waiting" | "watching" | "suspended";

/**
 * The line under the session bar's title: "code · working", "code · waiting
 * for you · 2 agents". The T3 pass moved the session's live state out of the
 * status line and into two places, the running work group at the end of the
 * conversation and this subtitle (docs/plans/2026-09-27-text-view-t3-pass.md).
 *
 * From the session list rather than from the transcript, because the bar heads
 * the Terminal view too, where the transcript stream is not open.
 */
export interface HeaderSubtitle {
  dot: HeaderDot;
  text: string;
}

const WORDS: Record<ClaudeState, [HeaderDot, string]> = {
  running: ["working", "working"],
  awaiting: ["waiting", "waiting for you"],
  done: ["idle", "idle"],
  suspended: ["suspended", "suspended"],
};

export function headerSubtitle(input: {
  /** The session's project name; "" or absent for an ungrouped one. */
  project?: string;
  /** The hook-stamped state; "" or absent when no Claude reported one. */
  state?: ClaudeState | "";
  /** This device is only watching: it cannot send or answer, whatever the
   *  session is doing, so that is the thing to say. */
  watching: boolean;
  background?: BackgroundWork;
  tool?: SessionTool;
  /** What the open Text view's conversation says the session is doing. It
   *  moves with the transcript, where `state` waits for the session list's
   *  next poll, so it wins while there is one. Not over a suspended session,
   *  and for a session no Claude reported on only when it says the session
   *  waits on the reader (the folder-trust dialog). */
  live?: "running" | "awaiting" | "done";
}): HeaderSubtitle {
  // Waiting on the reader is said even before a state is stamped: a fresh
  // Claude on its folder-trust dialog has stamped none.
  const state =
    input.live && input.state !== "suspended" && (input.state || input.live === "awaiting")
      ? input.live
      : input.state;
  const [dot, word]: [HeaderDot, string] = input.watching
    ? ["watching", "watching"]
    : state
      ? WORDS[state]
      : ["idle", input.tool === "shell" ? "shell" : "idle"];
  // A suspended session has no process, so nothing it launched is running.
  const owed = input.state === "suspended" ? "" : backgroundLabel(input.background);
  return { dot, text: [input.project, word, owed].filter(Boolean).join(" · ") };
}
