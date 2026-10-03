import { createEffect, createMemo, For, onCleanup, onMount, Show, type Component } from "solid-js";
import type { AgentInfo, WorkflowInfo } from "../types/events";
import { unreadSteers, withSteers, type PendingSteer } from "./steer.logic";
import { createAgentStream } from "../store/agent-stream";
import type { NotifyKind } from "../store/session";
import { deriveRows } from "./timeline.logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { agentHue, drillHead, elapsedOf, formatElapsed } from "./agents.logic";

const TICK_MS = 1000;

/**
 * The drill-in: one agent's own transcript, `agent-<id>.jsonl`, shown in the
 * session's place when its entry in the agent panel is tapped (design step 6,
 * docs/plans/2026-09-12-agent-workflow-visualisation-design.md).
 *
 * It is the session timeline's own rendering, so the agent's thinking, its
 * tool calls and their payloads open exactly as a session's do. One thing
 * differs: nothing folds. An agent is one long turn, and putting it behind
 * "Worked for 4m" would hide the work the reader opened it to see. The
 * composer below it messages the agent while one is open (steer.logic); what
 * was sent waits here as a dimmed bubble until the agent reads it.
 *
 * The header names the agent in the words its panel entry used, so the two
 * read as one thing, and it carries the way back. The elapsed digits are
 * written straight into their node once a second, as the panel's are.
 */
export const AgentTranscript: Component<{
  session: string;
  /** The agent's id, from its file name `agent-<id>.jsonl`. */
  agent: string;
  /** The newest the panel has said about it. Absent only for an agent the
   *  panel never listed, which then shows its id. */
  info: AgentInfo | undefined;
  /** The run a workflow member belongs to. */
  run: WorkflowInfo | undefined;
  /** Server clock minus this device's, from the agents frame. */
  skew: number;
  /** The session's stream is parked while nobody reads it; this one follows. */
  parked: boolean;
  onBack: () => void;
  onOpenPreview?: (path: string) => void;
  me?: string;
  notify?: (message: string, kind: NotifyKind) => void;
  /** Its timeline's pin and its way to the end, for the view's "Latest" band
   *  (MessagesTimeline `onAtEnd`, `registerToEnd`). */
  onAtEnd?: (atEnd: boolean) => void;
  registerToEnd?: (toEnd: () => void) => void;
  /** Messages sent to this agent that its transcript may not show yet. */
  steers?: readonly PendingSteer[];
  /** One of those has shown up in the transcript. */
  onSteerRead?: (id: number) => void;
}> = (props) => {
  const stream = createAgentStream(props.session, props.agent, {
    notify: props.notify,
  });
  createEffect(() => (props.parked ? stream.park() : stream.unpark()));
  // Which of the messages sent to this agent its transcript does not show yet.
  // `seen` outlives each derivation on purpose: it is what tells a repeated
  // message from the one before it (unreadSteers).
  const seen = new Map<number, number>();
  const unread = createMemo(() => unreadSteers(stream.events, props.steers ?? [], seen));
  createEffect(() => {
    const waiting = new Set(unread().map((p) => p.id));
    for (const p of props.steers ?? []) if (!waiting.has(p.id)) props.onSteerRead?.(p.id);
  });
  const events = createMemo(() => withSteers(stream.events, unread()));
  const rows = createMemo(() => deriveRows(events(), { fold: false, group: false }));
  const head = createMemo(() => (props.info ? drillHead(props.info, props.run) : undefined));
  const title = () => head()?.title ?? props.agent;

  let elapsed!: HTMLSpanElement;
  const writeElapsed = (): void => {
    const a = props.info;
    const h = head();
    const t =
      a && h
        ? formatElapsed(
            elapsedOf({ startedAt: a.startedAt, endedAt: h.endedAt }, Date.now() + props.skew),
          )
        : "";
    if (elapsed.textContent !== t) elapsed.textContent = t;
  };
  createEffect(writeElapsed);
  onMount(() => {
    const id = setInterval(writeElapsed, TICK_MS);
    onCleanup(() => clearInterval(id));
  });

  // The reader tapped to get here, so the way back is where the keyboard is.
  let back!: HTMLButtonElement;
  onMount(() => back.focus({ preventScroll: true }));

  return (
    <section class="tl-drill" aria-label={`Agent transcript: ${title()}`}>
      <header class="tl-drill-head">
        <div class="tl-drill-inner">
          <button type="button" class="tl-drill-back" ref={back} onClick={() => props.onBack()}>
            <span aria-hidden="true">←</span> Back to session
          </button>
          <div class="tl-drill-id" style={{ "--spine": agentHue(props.info ?? { color: "" }) }}>
            <div class="tl-drill-kind">
              <span class="tl-drill-kind-name">{head()?.kind ?? "Agent"}</span>
              <For each={head()?.tags ?? []}>{(t) => <span class="tl-drill-tag">{t}</span>}</For>
            </div>
            <div class="tl-drill-title">{title()}</div>
            <div class="tl-drill-meta">
              {/* Read inside the JSX, not in a template string: a Show's
                  child runs once, so a string built there would keep the
                  figures the drill-in opened with. */}
              <Show when={head()?.figures}>{(f) => <>{f()} · </>}</Show>
              <span class="tl-drill-elapsed" ref={elapsed} />
              <Show when={head()?.ending}>{(e) => <> · {e()}</>}</Show>
            </div>
          </div>
        </div>
      </header>
      <Show
        when={stream.status() !== "no-transcript"}
        fallback={
          // A 404: the agent has written nothing yet, or this session does not
          // list it. The stream asks again on its slow timer, and the
          // transcript takes this line's place the moment there is one.
          <div class="tl-drill-missing" role="status">
            No transcript to show for this agent yet.
          </div>
        }
      >
        <MessagesTimeline
          // The find-in-session jump stays with the session's own timeline.
          owns={false}
          label={`Agent transcript: ${title()}`}
          start="Start of this agent's transcript"
          events={events()}
          rows={rows()}
          opening={stream.opening()}
          hasEarlier={stream.hasEarlier()}
          onLoadEarlier={async () => {
            await stream.loadEarlier();
          }}
          onLoadFull={stream.fullResult}
          onOpenPreview={props.onOpenPreview}
          me={props.me}
          // No composer under it and no work groups in an agent's transcript,
          // so the timeline draws the working row itself.
          workingRow
          onAtEnd={props.onAtEnd}
          registerToEnd={props.registerToEnd}
        />
      </Show>
    </section>
  );
};
