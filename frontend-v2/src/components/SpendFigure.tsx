import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  type Accessor,
  type Component,
} from "solid-js";
import { fetchAgentSpend, sidebarFigure, type AgentSpend } from "../lib/agent-spend";
import type { SessionTool } from "../types/lobby";

/**
 * What the session you are attached to has consumed, in the sidebar footer.
 *
 * The Settings page is where the whole picture lives; this is the one figure
 * that is worth carrying without opening it. It follows the attached session's
 * tool, in that tool's own terms: today's dollars for Claude Code, which
 * computes them, and the tighter of the two limits for Codex, which reports no
 * dollars on a ChatGPT plan. A shell, or nothing attached, draws nothing.
 *
 * No colour and no threshold. A dollar total has no ceiling, so a red figure
 * would be inventing a budget the user never set.
 *
 * Design: docs/plans/2026-09-06-agent-spend-panel-design.md.
 */

/**
 * The floor between two reads. The document moves when a turn completes, which
 * is minutes apart in practice, and this figure is a glance rather than a
 * meter — so it rides the sidebar's own session poll (5s) and skips most of
 * them, instead of opening a second clock of its own that would keep asking
 * while the tab sits in a pocket.
 */
const MIN_READ_MS = 30_000;

export const SpendFigure: Component<{
  /** The attached session's tool, or nothing when no session is attached. */
  tool: Accessor<SessionTool | undefined>;
  /** The sidebar's session-poll counter, which is this figure's cadence too. */
  polls: Accessor<number>;
  /** Open the Agent spend page. */
  onOpen: () => void;
}> = (props) => {
  const [doc, setDoc] = createSignal<AgentSpend | null>(null);
  // Stamped when a read lands, and read by the window filter: a panel left open
  // across a reset boundary must not go on reporting a limit that has since
  // started over.
  const [nowMs, setNowMs] = createSignal(Date.now());

  // One controller PER READ, and the current one kept only so unmounting can
  // cancel it. A single long-lived signal handed to a repeating fetch is a slow
  // leak: the transport merges the caller's signal with a fresh deadline by
  // adding a listener to it, and a listener that is only removed when the abort
  // fires means one retained listener, and one retained merged controller, per
  // read for as long as the tab is open.
  let inFlight: AbortController | null = null;
  onCleanup(() => inFlight?.abort());

  let lastReadAt = 0;
  let reading = false;

  const load = async (tool: SessionTool): Promise<void> => {
    if (reading) return;
    reading = true;
    lastReadAt = Date.now();
    const abort = new AbortController();
    inFlight = abort;
    try {
      // One section, named: the figure reads a single number out of the
      // attached tool's half, and the other half costs the server a rollout
      // walk and two tmux calls to build.
      const next = await fetchAgentSpend("today", abort.signal, tool);
      setDoc(next);
      setNowMs(Date.now());
    } catch {
      // A footer is the wrong place to report a failed read: the figure simply
      // stays as it was, and the Settings page says what went wrong.
    } finally {
      reading = false;
      if (inFlight === abort) inFlight = null;
    }
  };

  createEffect(() => {
    // Two dependencies, both deliberate: the poll tick is the cadence, and the
    // tool changing is what makes the figure worth having at all — attaching a
    // Codex session after a Claude one must not go on showing dollars.
    props.polls();
    const tool = props.tool();
    // A box that has never run an agent asks for nothing. There is no figure
    // for a shell, so there is no reason to have read one.
    if (tool !== "claude" && tool !== "codex") return;
    if (Date.now() - lastReadAt < MIN_READ_MS) return;
    void load(tool);
  });

  const figure = (): string => sidebarFigure(props.tool(), doc(), nowMs());
  const title = (): string =>
    props.tool() === "codex"
      ? "How much of the tighter Codex limit is gone. Opens Agent spend"
      : "What Claude Code has cost today. Opens Agent spend";

  return (
    <Show when={figure()}>
      {(text) => (
        <button
          type="button"
          class="tl-icon-btn tl-foot-spend"
          aria-label={`Agent spend: ${text()}`}
          title={title()}
          onClick={() => props.onOpen()}
        >
          {text()}
        </button>
      )}
    </Show>
  );
};
