/**
 * The agent-spend client: what the user's Claude Code and Codex sessions have
 * consumed. Shapes mirror tmux-api/agentspend.go.
 *
 * The two tools are kept apart all the way down rather than flattened into one
 * shape, because they answer different questions. Claude Code computes dollars
 * and the store keeps them; a ChatGPT plan reports no cost anywhere, so Codex
 * is rate-limit windows and tokens. A section is ABSENT, not empty, when the
 * user has never run that tool, which is what lets the page leave a heading out
 * rather than draw one full of zeroes.
 *
 * Design: docs/plans/2026-09-06-agent-spend-panel-design.md.
 */
import { agentSpendUrl } from "./config";
import { fetchWithDeadline } from "./http";
import type { SessionTool } from "../types/lobby";

/** The spans the page offers, in the server's own vocabulary. */
export type SpendPeriod = "today" | "7d" | "month" | "all";

export const SPEND_PERIODS: ReadonlyArray<{ key: SpendPeriod; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "month", label: "This month" },
  { key: "all", label: "All time" },
];

/**
 * What a reading was carrying, split the way Claude Code reports it. `input`
 * already includes the cached tokens; `cacheRead` and `cacheCreation` are the
 * breakdown within it, so summing all four counts the cache twice.
 */
export interface SpendTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** One Claude rate-limit window, under the CLI's own key. */
export interface ClaudeWindow {
  name: string;
  usedPercent: number;
  /** Unix EPOCH SECONDS. Absent when the source named no reset. */
  resetsAtSec?: number;
}

export interface SpendModelRow {
  model: string;
  tokens: SpendTokens;
  costUsd: number;
}

/**
 * One Claude conversation. `costUsd` is the conversation's RUNNING TOTAL rather
 * than its share of the period, so the heading figure above the rows is the
 * number to trust for the period.
 */
export interface ClaudeSpendSession {
  sessionId: string;
  /** The tmux session name, which the page turns into a title when it has one. */
  session: string;
  model?: string;
  tokens: SpendTokens;
  costUsd: number;
  lastSeenSec: number;
}

export interface ClaudeSpend {
  costUsd: number;
  tokens: SpendTokens;
  models: SpendModelRow[];
  /** Present only for a seat whose statusLine carried rate_limits. */
  windows?: ClaudeWindow[];
  sessions: ClaudeSpendSession[];
}

/** One Codex window, already labelled in OpenAI's own words by the server. */
export interface CodexWindow {
  label: string;
  windowMinutes: number;
  usedPercent: number;
  resetsAtSec?: number;
}

/** Balance stays a string: the rollout does not promise it is a number. */
export interface CodexCredits {
  unlimited: boolean;
  balance: string;
}

export interface CodexTokens {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
  reasoningOutput: number;
  total: number;
}

export interface CodexSpendSession {
  sessionId: string;
  session?: string;
  model?: string;
  tokens: CodexTokens;
  contextWindow?: number;
  atSec?: number;
}

export interface CodexSpend {
  plan?: string;
  windows?: CodexWindow[];
  credits?: CodexCredits;
  sessions: CodexSpendSession[];
}

export interface AgentSpend {
  period: string;
  claude?: ClaudeSpend;
  codex?: CodexSpend;
}

/**
 * Read what the tools have consumed over one period.
 *
 * `tool` asks for one section only. The sidebar figure follows the attached
 * session's tool and shows one number, and the two halves cost different things
 * to build — the Codex half walks rollout files and asks tmux for panes — so
 * naming the tool is what keeps a Claude figure from paying for a Codex read on
 * every poll. The Settings page omits it and gets both.
 */
export async function fetchAgentSpend(
  period: SpendPeriod,
  signal?: AbortSignal,
  tool?: SessionTool,
): Promise<AgentSpend> {
  const res = await fetchWithDeadline(agentSpendUrl(period, tool), { signal });
  if (!res.ok) throw new Error(`agent-spend ${res.status}`);
  return (await res.json()) as AgentSpend;
}

/**
 * Claude's window keys in the words a person would use. An unknown key is
 * spelled out rather than hidden: a window the CLI adds later is still worth
 * showing, and the raw key says more than nothing.
 */
const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  spend_limit: "Spend limit",
};

export function claudeWindowLabel(name: string): string {
  return CLAUDE_WINDOW_LABELS[name] ?? name.replace(/_/g, " ");
}

/**
 * Capitalize the first character and leave the rest alone. The server labels a
 * Codex window in Codex's own lowercase words ("weekly limit"), and a row label
 * beside "5-hour limit" reads better with its first letter up. Nothing else
 * moves: a model id is not a sentence.
 */
export function capitalizeFirst(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * Drop the readings whose reset has already passed.
 *
 * The server filters too, and this is not redundant: the panel stays open
 * across a reset boundary, and a window that has since started over would go on
 * reporting a limit the account is no longer anywhere near. A window with no
 * reset at all cannot be judged, so it is kept.
 */
export function liveWindows<T extends { resetsAtSec?: number }>(
  windows: readonly T[] | undefined,
  nowMs: number,
): T[] {
  const nowSec = Math.floor(nowMs / 1000);
  return (windows ?? []).filter((w) => !w.resetsAtSec || w.resetsAtSec > nowSec);
}

/**
 * Money, in the smallest form that does not read as free. A figure under a cent
 * is shown as such rather than rounded to $0.00, which would say a session cost
 * nothing when it cost something.
 */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Tokens, compact, because these are read as a column rather than added up. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * The one figure the sidebar footer has room for, or "" for nothing to show.
 *
 * It follows the ATTACHED session's tool rather than summing the two, because
 * they are not the same kind of number: Claude Code computes dollars and a
 * ChatGPT plan reports none, so the honest figure for a Codex session is how
 * much of a limit is gone. The tighter of the two Codex windows is the one that
 * will stop you first, which is what makes it the one worth a single slot.
 *
 * `doc` is today's document. Anything else — a shell session, no session, a
 * tool the server has never seen report — is "": the footer draws nothing at
 * all rather than a zero, which would claim a measurement nobody took.
 */
export function sidebarFigure(
  tool: SessionTool | undefined,
  doc: AgentSpend | null,
  nowMs: number,
): string {
  if (tool === "claude" && doc?.claude) return formatUsd(doc.claude.costUsd);
  if (tool === "codex" && doc?.codex) {
    const live = liveWindows(doc.codex.windows, nowMs);
    if (live.length === 0) return "";
    const tightest = live.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    return `${Math.round(tightest.usedPercent)}%`;
  }
  return "";
}

/**
 * How long a window has left, in the coarsest unit that still says something.
 * Empty when there is no reset to describe, so the caller renders nothing
 * rather than an empty parenthesis.
 */
export function formatResetsIn(resetsAtSec: number | undefined, nowMs: number): string {
  if (!resetsAtSec) return "";
  const secs = resetsAtSec - Math.floor(nowMs / 1000);
  if (secs <= 0) return "";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `resets in ${Math.max(mins, 1)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest ? `resets in ${hours}h ${rest}m` : `resets in ${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `resets in ${days}d`;
}
