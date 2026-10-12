/**
 * One lobby session's event stream as T3 orchestration v2 domain events.
 *
 * The lobby streams what Claude Code wrote (sessionio's normalized events)
 * and a few frames about the session; T3 expects a projection of runs,
 * attempts, nodes, provider turns, messages and turn items. This class keeps
 * just enough state to turn the first into the second, one lobby event at a
 * time, and returns the domain events each one implies. The caller applies
 * them to a projection with T3's own reducer (client-runtime
 * applyOrchestrationV2ProjectionEvent), so what the browser builds from the
 * events and what a snapshot carries are computed the same way.
 *
 * How a lobby stream maps onto runs (measured on scratch sessions, 2026-10-12):
 *
 * - A run opens with a main-thread `user` event when no run is open, and
 *   closes with `turn_end`. sessionio gives every `user` event a new turnId,
 *   including a prompt the mod delivered into a running turn at a tool
 *   boundary (a steer), and the turn it interrupted gets no turn_end. So a
 *   `user` event while a run is open is a steer inside that run, not a run.
 * - A run can open without a prompt: a background agent finishing wakes
 *   Claude, which answers with no `user` event, and a bounded backfill can
 *   start mid-turn. Content with no open run opens a run whose user message
 *   carries no turn item.
 * - `meta queued` puts a prompt on the queue (Claude's own, or one
 *   session-events holds behind the turn); `dequeued` takes the head,
 *   `unqueued` takes one back (edited, cancelled, or delivered as a steer),
 *   `queue-cleared` drops them all. A queued prompt is a queued run until its
 *   `user` event starts it.
 * - A T3 Stop holds the queue (holdQueue): the lobby hands the held prompts
 *   back, and their runs stay queued with queueHeld until queue.resume sends
 *   them again, so the `unqueued` that hand-back emits leaves them alone.
 * - `meta held` and `meta asking` carry the dialogs the mod holds: a
 *   question card, and a permission prompt or plan approval. Each becomes a
 *   runtime request with its node and turn item, keyed by the tool call's id.
 *
 * Ids come from ids.ts and are derived from the log, so a rebuild of the same
 * log produces the same projection.
 */
import {
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type OrchestrationV2UserMessageInputIntent,
  type ProviderRequestKind,
  type RunId,
  type ThreadId,
  type TurnItemId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { LobbyEvent, ModelState, SessionState } from "../lobby/wire.ts";
import { CLAUDE_INSTANCE_ID } from "../serverConfig.ts";
import * as Ids from "./ids.ts";
import { lobbyModeFor, modesFromLobby, type T3Modes } from "./modes.ts";
import { classifyTool, type ItemBase, parseToolInput, toolItem } from "./tools.ts";

export type DomainEvent = OrchestrationV2DomainEvent;

/** How the mapper learns which T3 message a prompt was sent as (pending.ts). */
export interface MessageCorrelation {
  /** Takes the oldest dispatch whose text this prompt is, if any. */
  readonly take: (text: string) => MessageId | undefined;
}

export interface MapperOptions {
  readonly threadId: ThreadId;
  /** Unique per process and thread, so domain event ids never repeat across restarts. */
  readonly eventPrefix: string;
  readonly now: () => number;
  readonly messages: MessageCorrelation;
}

interface RunRecord {
  run: OrchestrationV2Run;
  /** The prompt as the queue named it, for matching its `user` event. */
  text: string;
  /** The lobby turn ids this run's events carried (a steer starts a new one). */
  readonly turnIds: Set<string>;
  /** A T3 edit is replacing this queued prompt's text with this one. */
  editTo: string | undefined;
  readonly messageId: MessageId;
  /** Items handed out so far; an item's ordinal is run.ordinal * 1e6 + n. */
  items: number;
  hasOutput: boolean;
  interrupted: boolean;
  /** A T3 Stop asked for this run to end: the turn_end that follows is an interrupt. */
  stopRequested: boolean;
  /** Queued while another run was open (T3's queued_turn). */
  readonly queuedBehind: boolean;
  /**
   * A Stop held this queued run: "held" while only the sidecar has its text,
   * "resending" once queue.resume (or a steer) sent it to the lobby again, so
   * the lobby's own queued or user event takes it over.
   */
  hold: "held" | "resending" | undefined;
}

interface ToolRecord {
  readonly tool: string;
  readonly input: unknown;
  readonly base: ItemBase;
  done: boolean;
}

interface StreamSlot {
  readonly itemId: TurnItemId;
  readonly stream: "text" | "thinking";
  readonly block: number;
  readonly ordinal: number;
  readonly runId: RunId;
  readonly startedAt: number;
  text: string;
  /**
   * Drawn as completed at its turn's end, and kept for the stored block that
   * replaces it: the mod's turn_end can land before Claude's stored text.
   */
  settled?: true;
}

export type DialogKind = "ask" | "permission" | "plan";

/** A dialog the mod holds, as the commands need it. */
export interface OpenDialog {
  readonly kind: DialogKind;
  readonly toolId: string;
  readonly runId: RunId | null;
  /** For an ask: the questions as Claude asked them. */
  readonly questions: ReadonlyArray<HeldQuestion>;
  /** For a plan: the approve row Claude drew, when the reading names one. */
  readonly planOptions: ReadonlyArray<{ readonly number: number; readonly label: string }>;
  readonly itemIds: ReadonlyArray<TurnItemId>;
  readonly createdAt: number;
}

export interface HeldQuestion {
  readonly question: string;
  readonly header?: string;
  readonly multiSelect?: boolean;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
}

const ITEMS_PER_RUN = 1_000_000;
const DONT_ASK_NOTICE = "No ask, set outside T3";

const utc = (ms: number) => DateTime.makeUnsafe(ms);
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const trimmed = (s: string): string => s.trim();

/**
 * The keystrokes the lobby types for a model or effort change (as the Solid
 * view's isPickerCommand). Claude Code records each as a turn of its own,
 * whose receipt row says what changed.
 */
function isPickerCommand(text: string): boolean {
  return /^\/(model|effort)$/.test(text.trim());
}

function samePrompt(a: string, b: string): boolean {
  const x = trimmed(a);
  const y = trimmed(b);
  if (x === y) return true;
  // A long paste can come back capped (a steer row's copy); a prefix of 64+
  // characters is the same prompt.
  return x.length >= 64 && y.length >= 64 && (x.startsWith(y) || y.startsWith(x));
}

const isTaskNotification = (text: string): boolean =>
  trimmed(text).startsWith("<task-notification>");

function nonEmpty(value: string | undefined, fallback: string): string {
  const t = value?.trim();
  return t === undefined || t === "" ? fallback : t;
}

export class ThreadMapper {
  readonly #o: MapperOptions;
  #thread: OrchestrationV2AppThread;
  #modes: T3Modes;
  #epoch = "e0";
  #out: DomainEvent[] = [];
  #at = 0;
  #eventCount = 0;
  #synthetic = 0;
  #nextOrdinal = 1;
  readonly #runs = new Map<RunId, RunRecord>();
  #open: RunRecord | undefined;
  #last: RunRecord | undefined;
  #queue: RunRecord[] = [];
  /** Recently taken off the queue, so the steer that delivers one reuses its message. */
  #unqueued: Array<{ text: string; messageId: MessageId }> = [];
  readonly #tools = new Map<string, ToolRecord>();
  #streams: StreamSlot[] = [];
  readonly #dialogs = new Map<string, OpenDialog>();
  #wakeSummary: string | undefined;
  #pendingNotice: string | undefined;
  /** Turns that are a picker command's: their receipt is a notice, not a run. */
  readonly #pickerTurns = new Set<string>();

  constructor(options: MapperOptions, thread: OrchestrationV2AppThread) {
    this.#o = options;
    this.#thread = thread;
    this.#modes = {
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      outsideT3: false,
    };
  }

  get thread(): OrchestrationV2AppThread {
    return this.#thread;
  }

  /** The epoch ids are minted under; set before the first event of a log. */
  setEpoch(epoch: string): void {
    this.#epoch = epoch.replaceAll(/[^A-Za-z0-9]/g, "").slice(0, 16) || "e0";
  }

  get activeRun(): OrchestrationV2Run | undefined {
    return this.#open?.run;
  }

  /** Queued runs, oldest first. */
  get queuedRuns(): ReadonlyArray<{ readonly run: OrchestrationV2Run; readonly text: string }> {
    return this.#queue.map((r) => ({ run: r.run, text: r.text }));
  }

  /** Every run, oldest first. */
  get runs(): ReadonlyArray<OrchestrationV2Run> {
    return [...this.#runs.values()].map((r) => r.run);
  }

  dialog(toolId: string): OpenDialog | undefined {
    return this.#dialogs.get(toolId);
  }

  get openDialogs(): ReadonlyArray<OpenDialog> {
    return [...this.#dialogs.values()];
  }

  // ---- inputs -------------------------------------------------------------

  /** Thread fields the shell owns (title, project); emits metadata-updated when they move. */
  updateThread(
    patch: Partial<Pick<OrchestrationV2AppThread, "title" | "projectId" | "updatedAt">>,
  ): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      const next = { ...this.#thread, ...patch };
      if (next.title === this.#thread.title && next.projectId === this.#thread.projectId) return;
      this.#thread = next;
      this.#emit("thread.metadata-updated", this.#thread);
    });
  }

  /** The `state` frame: mode and model now. The queue is reconciled at `ready`. */
  applyState(state: SessionState): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      if (state.mode !== undefined) this.#setMode(state.mode);
      if (state.model !== undefined) this.#setModel(state.model);
    });
  }

  /**
   * After the opening exchange: make the queued runs match the queue
   * session-events reports, which a bounded backfill may not account for.
   */
  reconcileQueue(queue: ReadonlyArray<string>): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      const want = queue.filter((t) => !isTaskNotification(t));
      const keep: RunRecord[] = [];
      const unmatched = [...want];
      for (const rec of this.#queue) {
        const i = unmatched.findIndex((t) => samePrompt(t, rec.text));
        if (i === -1 && rec.hold === "held") {
          // A Stop took it back from the lobby: it waits here for queue.resume.
          keep.push(rec);
        } else if (i === -1) {
          this.#cancelQueued(rec);
        } else {
          unmatched.splice(i, 1);
          keep.push(rec);
        }
      }
      this.#queue = keep;
      for (const text of unmatched) this.#enqueue(text);
      this.#renumberQueue();
    });
  }

  applyEvents(events: ReadonlyArray<LobbyEvent>): DomainEvent[] {
    const out: DomainEvent[] = [];
    for (const e of events) out.push(...this.applyEvent(e));
    return out;
  }

  applyEvent(e: LobbyEvent): DomainEvent[] {
    return this.#batch(e.at ?? this.#o.now(), () => this.#apply(e));
  }

  /**
   * A T3 Stop: shows the interrupt request on the active run, and makes the
   * turn_end that follows an interrupt. A Claude with the lobby's mod is
   * stopped inside the process and its turn ends cleanly, with no
   * "[Request interrupted by user]" row to say so.
   */
  interruptRequested(): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      const rec = this.#open;
      if (rec === undefined) return;
      rec.stopRequested = true;
      this.#item(rec, {
        type: "run_interrupt_request",
        message: "Interrupt requested",
        status: "completed",
        title: "Interrupt requested",
      });
    });
  }

  /**
   * A T3 edit of a queued prompt is about to take its old text off the queue
   * and queue the new one: the run stays, under the new text, so the browser's
   * queued row is edited rather than replaced. False when the run is not
   * queued.
   */
  expectEdit(runId: RunId, text: string): boolean {
    const rec = this.#queue.find((r) => r.run.id === runId);
    if (rec === undefined) return false;
    rec.editTo = text;
    return true;
  }

  /** The edit did not go through: the old text stays queued. */
  editFailed(runId: RunId): void {
    const rec = this.#queue.find((r) => r.run.id === runId);
    if (rec !== undefined) rec.editTo = undefined;
  }

  /** The lobby refused the Stop: the run carries on, and its end is not an interrupt. */
  interruptRefused(): void {
    if (this.#open !== undefined) this.#open.stopRequested = false;
  }

  /**
   * A Stop that holds the queue (T3's Stop button): every queued run waits
   * for queue.resume, as T3's own server marks them (holdStoppedThread).
   */
  holdQueue(): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      for (const rec of this.#queue) {
        if (rec.run.status !== "queued" || rec.hold !== undefined) continue;
        rec.hold = "held";
        this.#setRun(rec, { queueHeld: true });
      }
    });
  }

  /**
   * The prompts the lobby handed back on that Stop. One no queued run shows
   * (the mod had taken it to steer with) becomes a held run of its own, so
   * nothing the person queued disappears.
   */
  holdReturned(texts: ReadonlyArray<string>): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      const shown = this.#queue.filter((r) => r.hold === "held");
      for (const text of texts) {
        if (isTaskNotification(text)) continue;
        const i = shown.findIndex((r) => samePrompt(r.text, text));
        if (i >= 0) {
          shown.splice(i, 1);
          continue;
        }
        const messageId =
          this.#o.messages.take(text) ??
          this.#takeUnqueued(text) ??
          Ids.syntheticMessageId(this.#o.threadId, this.#epoch, ++this.#synthetic);
        const rec = this.#newRecord(text, messageId, "queued");
        rec.hold = "held";
        rec.run = { ...rec.run, queueHeld: true };
        this.#queue.push(rec);
        this.#emit("run.created", rec.run, rec.run.id);
        this.#emit("node.updated", this.#rootNode(rec, "pending"), rec.run.id);
        this.#message(rec, messageId, "user", text, null);
      }
      this.#renumberQueue();
    });
  }

  /** The lobby refused the Stop: its queue still holds the prompts, so nothing waits here. */
  releaseHold(): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      for (const rec of this.#queue) {
        if (rec.hold !== "held") continue;
        rec.hold = undefined;
        this.#setRun(rec, { queueHeld: false });
      }
    });
  }

  /** Whether a queued run is held by a Stop, so only the sidecar has its text. */
  isHeld(runId: RunId): boolean {
    return this.#queue.some((r) => r.run.id === runId && r.hold === "held");
  }

  /** The held runs, oldest first, as queue.resume sends them. */
  get heldRuns(): ReadonlyArray<{
    readonly runId: RunId;
    readonly messageId: MessageId;
    readonly text: string;
  }> {
    return this.#queue
      .filter((r) => r.hold === "held")
      .map((r) => ({ runId: r.run.id, messageId: r.messageId, text: r.text }));
  }

  /** queue.resume (or a steer) is sending these held runs to the lobby again. */
  resumeHeld(runIds: ReadonlyArray<RunId>): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      for (const rec of this.#queue) {
        if (rec.hold !== "held" || !runIds.includes(rec.run.id)) continue;
        rec.hold = "resending";
        this.#setRun(rec, { queueHeld: false });
      }
    });
  }

  /** A resend that failed: those runs are held again. */
  reholdHeld(runIds: ReadonlyArray<RunId>): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      for (const rec of this.#queue) {
        if (rec.hold !== "resending" || !runIds.includes(rec.run.id)) continue;
        rec.hold = "held";
        this.#setRun(rec, { queueHeld: true });
      }
    });
  }

  /** queued-run.cancel of a held run: only the sidecar has it, so it goes here. */
  cancelHeld(runId: RunId): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      const i = this.#queue.findIndex((r) => r.run.id === runId && r.hold === "held");
      if (i === -1) return;
      const [rec] = this.#queue.splice(i, 1);
      if (rec !== undefined) this.#cancelQueued(rec);
      this.#renumberQueue();
    });
  }

  /** queued-run.edit of a held run: retexted where it waits. */
  retextHeld(runId: RunId, text: string): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      const rec = this.#queue.find((r) => r.run.id === runId && r.hold === "held");
      if (rec === undefined) return;
      rec.text = text;
      this.#message(rec, rec.messageId, "user", text, null);
    });
  }

  /** A mode the lobby confirmed it set (POST /model {mode}), ahead of the transcript saying so. */
  confirmMode(mode: string): DomainEvent[] {
    return this.#batch(this.#o.now(), () => this.#setMode(mode));
  }

  /** A model the lobby confirmed it set (POST /model), ahead of the transcript saying so. */
  confirmModel(model: ModelState): DomainEvent[] {
    return this.#batch(this.#o.now(), () => this.#setModel(model));
  }

  /**
   * T3's thread.visit: the newest moment the viewer saw the thread, kept as
   * the maximum so a late or replayed visit cannot move it back.
   */
  visited(visitedAtMs: number): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      const before = this.#thread.lastVisitedAt;
      if (before !== null && DateTime.toEpochMillis(before) >= visitedAtMs) return;
      this.#thread = { ...this.#thread, lastVisitedAt: utc(visitedAtMs) };
      this.#emit("thread.visited", this.#thread);
    });
  }

  /** A notice row about something the sidecar did or could not do (a refused model change). */
  notice(message: string): DomainEvent[] {
    return this.#batch(this.#o.now(), () => this.#notice(message));
  }

  /** The session has no stream yet (nomod.go): one notice, outside any run. */
  noStream(message: string): DomainEvent[] {
    return this.#batch(this.#o.now(), () => {
      this.#pendingNotice = message;
      this.#flushNotice();
    });
  }

  // ---- the event switch ---------------------------------------------------

  #apply(e: LobbyEvent): void {
    // A subagent's work stays in its own transcript (the agent panel is not
    // part of the first cut); its tool calls never touch the main thread.
    if (e.sidechain === true || e.agentId !== undefined) return;
    this.#dispatch(e);
    if (e.turnId !== undefined && e.kind !== "turn_end") this.#open?.turnIds.add(e.turnId);
  }

  #dispatch(e: LobbyEvent): void {
    switch (e.kind) {
      case "user":
        return this.#user(e);
      case "text":
      case "thinking":
        return this.#reply(e);
      case "delta":
        return this.#delta(e);
      case "tool_use":
        return this.#toolUse(e);
      case "tool_result":
        return this.#toolResult(e);
      case "turn_end":
        return this.#turnEnd(e);
      case "state":
        return this.#stateRow(e);
      case "error":
        return this.#notice(e.body ?? "");
      case "meta":
        return this.#meta(e);
      default:
        return;
    }
  }

  #meta(e: LobbyEvent): void {
    const body = e.body ?? "";
    switch (e.meta) {
      case "permission-mode":
        return this.#setMode(body);
      case "model":
        if (e.model !== undefined) this.#setModel(e.model);
        return;
      case "queued":
        if (isTaskNotification(body)) {
          this.#wakeSummary = summaryOf(body);
          return;
        }
        this.#enqueue(body);
        this.#renumberQueue();
        return;
      case "dequeued":
        return this.#dequeue();
      case "unqueued":
        return this.#unqueue(body);
      case "queue-cleared":
        for (const rec of this.#queue) if (rec.hold !== "held") this.#cancelQueued(rec);
        this.#queue = this.#queue.filter((r) => r.hold === "held");
        return;
      case "held":
        return this.#held(body, e.id);
      case "asking":
        return this.#asking(body, e.id);
      case "compact": {
        const rec = this.#open;
        if (rec === undefined) return;
        this.#item(rec, {
          type: "compaction",
          driver: CLAUDE_DRIVER,
          status: "completed",
          title: "Context compacted",
        });
        return;
      }
      case "hook-error":
        return this.#notice(body);
      default:
        return;
    }
  }

  // ---- runs ---------------------------------------------------------------

  #newRecord(text: string, messageId: MessageId, status: OrchestrationV2Run["status"]): RunRecord {
    const ordinal = this.#nextOrdinal++;
    const id = Ids.runId(this.#o.threadId, this.#epoch, ordinal);
    const rec: RunRecord = {
      run: {
        id,
        threadId: this.#o.threadId,
        ordinal,
        providerInstanceId: CLAUDE_INSTANCE_ID,
        modelSelection: this.#thread.modelSelection,
        providerThreadId: Ids.providerThreadId(this.#o.threadId),
        userMessageId: messageId,
        rootNodeId: Ids.rootNodeId(id),
        activeAttemptId: null,
        status,
        requestedAt: utc(this.#at),
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
      text,
      messageId,
      items: 0,
      hasOutput: false,
      interrupted: false,
      stopRequested: false,
      editTo: undefined,
      turnIds: new Set(),
      queuedBehind: this.#open !== undefined,
      hold: undefined,
    };
    this.#runs.set(id, rec);
    return rec;
  }

  #enqueue(text: string): void {
    // A held run the lobby queues again (queue.resume, or a Stop it put back):
    // the same run, no longer held.
    const resumed = this.#queue.find((r) => r.hold !== undefined && samePrompt(r.text, text));
    if (resumed !== undefined) {
      resumed.hold = undefined;
      this.#o.messages.take(text);
      if (resumed.run.queueHeld === true) this.#setRun(resumed, { queueHeld: false });
      return;
    }
    // The new text of a queued prompt T3 is editing: the same run, retexted.
    const edited = this.#queue.find((r) => r.editTo !== undefined && samePrompt(r.editTo, text));
    if (edited !== undefined) {
      edited.editTo = undefined;
      edited.text = text;
      this.#o.messages.take(text);
      this.#message(edited, edited.messageId, "user", text, null);
      return;
    }
    const messageId =
      this.#o.messages.take(text) ??
      Ids.syntheticMessageId(this.#o.threadId, this.#epoch, ++this.#synthetic);
    const rec = this.#newRecord(text, messageId, this.#open === undefined ? "starting" : "queued");
    this.#queue.push(rec);
    this.#emit("run.created", rec.run, rec.run.id);
    this.#emit("node.updated", this.#rootNode(rec, "pending"), rec.run.id);
    this.#message(rec, messageId, "user", text, null);
  }

  #renumberQueue(): void {
    let position = 0;
    for (const rec of this.#queue) {
      const queued = rec.run.status === "queued";
      const want = queued ? ++position : null;
      if ((rec.run.queuePosition ?? null) === want) continue;
      this.#setRun(rec, { queuePosition: want });
    }
  }

  #dequeue(): void {
    const rec = this.#queue.find(
      (r) => (r.run.status === "queued" || r.run.status === "starting") && r.hold !== "held",
    );
    if (rec === undefined || rec.run.status === "starting") return;
    this.#setRun(rec, { status: "starting", queuePosition: null });
    this.#renumberQueue();
  }

  #unqueue(text: string): void {
    const i = this.#queue.findIndex((r) => samePrompt(r.text, text));
    if (i === -1) return;
    // Taken off to be replaced by its edit (queued-run.edit): it stays.
    if (this.#queue[i]?.editTo !== undefined) return;
    // Handed back on a Stop that holds the queue: it waits for queue.resume.
    if (this.#queue[i]?.hold === "held") return;
    const [rec] = this.#queue.splice(i, 1);
    if (rec === undefined) return;
    this.#cancelQueued(rec);
    this.#unqueued.push({ text: rec.text, messageId: rec.messageId });
    if (this.#unqueued.length > 20) this.#unqueued.shift();
    this.#renumberQueue();
  }

  #cancelQueued(rec: RunRecord): void {
    this.#setRun(rec, { status: "cancelled", queuePosition: null, completedAt: utc(this.#at) });
    this.#emit("node.updated", this.#rootNode(rec, "cancelled"), rec.run.id);
  }

  #takeUnqueued(text: string): MessageId | undefined {
    const i = this.#unqueued.findIndex((u) => samePrompt(u.text, text));
    if (i === -1) return undefined;
    const [hit] = this.#unqueued.splice(i, 1);
    return hit?.messageId;
  }

  /** Starts a run: a queued one this prompt matches, or a new one. */
  #start(text: string | undefined): RunRecord {
    const queued = text === undefined ? -1 : this.#queue.findIndex((r) => samePrompt(r.text, text));
    let rec: RunRecord;
    if (queued >= 0) {
      rec = this.#queue.splice(queued, 1)[0] as RunRecord;
      if (rec.hold !== undefined && text !== undefined) this.#o.messages.take(text);
      rec.hold = undefined;
    } else {
      const messageId =
        (text === undefined
          ? undefined
          : (this.#o.messages.take(text) ?? this.#takeUnqueued(text))) ??
        Ids.syntheticMessageId(this.#o.threadId, this.#epoch, ++this.#synthetic);
      rec = this.#newRecord(text ?? "", messageId, "starting");
      this.#emit("run.created", rec.run, rec.run.id);
    }
    this.#ensureProviderThread("active");
    const attempt = Ids.attemptId(rec.run.id);
    this.#setRun(rec, {
      status: "running",
      queuePosition: null,
      startedAt: utc(this.#at),
      activeAttemptId: attempt,
      ...(rec.run.queueHeld === undefined ? {} : { queueHeld: false }),
    });
    this.#emit("run-attempt.created", this.#attempt(rec, "running"), rec.run.id);
    this.#emit("node.updated", this.#rootNode(rec, "running"), rec.run.id);
    this.#emit("provider-turn.updated", this.#providerTurn(rec, "running"), rec.run.id);
    // A stored block reaches only the open run or the last one (#ensureOpen),
    // so a settled slot of an earlier run has nothing left to wait for.
    this.#streams = this.#streams.filter((s) => !s.settled);
    this.#open = rec;
    this.#last = rec;
    this.#renumberQueue();
    this.#flushNotice();
    return rec;
  }

  /**
   * The open run, opening one for content that arrives with none (a wake, a
   * mid-turn window). A row of a turn that has already ended goes to that
   * turn's run instead: the mod's turn_end can land before Claude's stored
   * reply (measured 2026-10-12: turn_end id 9, its text id 10).
   */
  #ensureOpen(e?: LobbyEvent): RunRecord {
    if (this.#open !== undefined) return this.#open;
    const last = this.#last;
    if (e?.turnId !== undefined && last !== undefined && last.turnIds.has(e.turnId)) return last;
    const rec = this.#start(undefined);
    this.#message(rec, rec.messageId, "user", "", null);
    if (this.#wakeSummary !== undefined) {
      this.#item(rec, {
        type: "notification",
        source: { kind: "background_task" },
        outcome: "completed",
        summary: this.#wakeSummary,
        status: "completed",
        title: null,
      });
      this.#wakeSummary = undefined;
    }
    return rec;
  }

  #user(e: LobbyEvent): void {
    const text = e.body ?? "";
    if (e.turnId !== undefined && isPickerCommand(text)) {
      this.#pickerTurns.add(e.turnId);
      return;
    }
    const open = this.#open;
    if (open !== undefined) {
      // A prompt delivered into the running turn. A queued run it matches was
      // delivered this way, and gives the steer its message.
      const queued = this.#queue.findIndex((r) => samePrompt(r.text, text));
      let messageId: MessageId | undefined;
      if (queued >= 0) {
        const [rec] = this.#queue.splice(queued, 1);
        if (rec !== undefined) {
          this.#cancelQueued(rec);
          messageId = rec.messageId;
        }
        this.#renumberQueue();
      }
      messageId ??=
        this.#o.messages.take(text) ??
        this.#takeUnqueued(text) ??
        Ids.eventMessageId(this.#o.threadId, this.#epoch, e.id);
      this.#userItem(open, e, messageId, open.hasOutput ? "steer" : "turn_start");
      return;
    }
    const rec = this.#start(text);
    this.#userItem(rec, e, rec.messageId, rec.queuedBehind ? "queued_turn" : "turn_start");
  }

  #userItem(
    rec: RunRecord,
    e: LobbyEvent,
    messageId: MessageId,
    intent: OrchestrationV2UserMessageInputIntent,
  ): void {
    const text = e.body ?? "";
    this.#message(rec, messageId, "user", text, Ids.rootNodeId(rec.run.id));
    this.#item(
      rec,
      {
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        messageId,
        inputIntent: intent,
        text,
        attachments: [],
        status: "completed",
        title: null,
      },
      Ids.eventItemId(this.#o.threadId, this.#epoch, e.id),
    );
  }

  #turnEnd(e: LobbyEvent): void {
    const rec = this.#open;
    if (rec === undefined) return;
    this.#closeStreams(rec);
    for (const tool of this.#tools.values()) {
      if (!tool.done && tool.base.runId === rec.run.id) tool.done = true;
    }
    for (const dialog of [...this.#dialogs.values()]) {
      if (dialog.runId === rec.run.id) this.#resolveDialog(dialog, "expired");
    }
    if (rec.stopRequested && !rec.interrupted) {
      rec.interrupted = true;
      this.#item(rec, {
        type: "run_interrupt_result",
        message: "Interrupted",
        status: "interrupted",
        title: "Interrupted",
      });
    }
    const status = rec.interrupted ? "interrupted" : "completed";
    this.#emit("provider-turn.updated", this.#providerTurn(rec, status, e.usage), rec.run.id);
    this.#emit("run-attempt.updated", this.#attempt(rec, status), rec.run.id);
    this.#emit("node.updated", this.#rootNode(rec, status), rec.run.id);
    this.#setRun(rec, { status, completedAt: utc(this.#at) });
    this.#open = undefined;
    this.#ensureProviderThread("idle");
    // A prompt queued behind this turn is next, not waiting on it any more.
    this.#renumberQueue();
  }

  #stateRow(e: LobbyEvent): void {
    const body = e.body ?? "";
    if (e.turnId !== undefined && this.#pickerTurns.has(e.turnId)) {
      this.#notice(body);
      return;
    }
    if (body.startsWith("[Request interrupted by user")) {
      const rec = this.#open;
      if (rec === undefined) return;
      rec.interrupted = true;
      this.#item(rec, {
        type: "run_interrupt_result",
        message: body,
        status: "interrupted",
        title: "Interrupted",
      });
      return;
    }
    // A harness row with no turn open is a background job reporting in, and
    // Claude answers it next: it opens that run, as its notification. The
    // queued <task-notification> before it already named it, and the row
    // repeats that summary, so it is shown once.
    if (this.#open === undefined && body !== "") {
      this.#wakeSummary ??= body;
      this.#ensureOpen();
      return;
    }
    this.#notice(body);
  }

  #notice(message: string): void {
    if (message.trim() === "") return;
    const rec = this.#open ?? this.#last;
    if (rec === undefined) {
      this.#pendingNotice = message;
      return;
    }
    this.#item(rec, { type: "system_notice", message, status: "completed", title: null });
  }

  #flushNotice(): void {
    const message = this.#pendingNotice;
    const rec = this.#open ?? this.#last;
    if (message === undefined || rec === undefined) return;
    this.#pendingNotice = undefined;
    this.#item(rec, { type: "system_notice", message, status: "completed", title: null });
  }

  // ---- replies and tools --------------------------------------------------

  #reply(e: LobbyEvent): void {
    const rec = this.#ensureOpen(e);
    const stream = e.kind === "thinking" ? "thinking" : "text";
    rec.hasOutput = true;
    // The stored block supersedes the oldest block streamed for it, and
    // keeps that block's item id so the row the browser is drawing stays.
    const at = this.#streams.findIndex((s) => s.stream === stream && s.runId === rec.run.id);
    const slot = at >= 0 ? this.#streams.splice(at, 1)[0] : undefined;
    const itemId = slot?.itemId ?? Ids.eventItemId(this.#o.threadId, this.#epoch, e.id);
    const text = e.body ?? "";
    const fields =
      stream === "text"
        ? ({
            type: "assistant_message",
            messageId: Ids.eventMessageId(this.#o.threadId, this.#epoch, e.id),
            text,
            streaming: false,
            status: "completed",
            title: null,
          } as const)
        : ({
            type: "reasoning",
            text,
            streaming: false,
            status: "completed",
            title: "Thinking",
          } as const);
    if (stream === "text") {
      this.#message(
        rec,
        fields.type === "assistant_message" ? fields.messageId : rec.messageId,
        "assistant",
        text,
        Ids.rootNodeId(rec.run.id),
      );
    }
    this.#item(rec, fields, itemId, slot === undefined ? undefined : slot.ordinal, slot?.startedAt);
  }

  #delta(e: LobbyEvent): void {
    const body = e.body ?? "";
    if (body === "") return;
    const stream = e.stream === "thinking" ? "thinking" : e.stream === "text" ? "text" : undefined;
    if (stream === undefined) return;
    const rec = this.#ensureOpen(e);
    rec.hasOutput = true;
    const block = e.block ?? 0;
    let slot = this.#streams.find(
      (s) => s.runId === rec.run.id && s.stream === stream && s.block === block && !s.settled,
    );
    if (slot === undefined) {
      slot = {
        itemId: Ids.syntheticItemId(this.#o.threadId, this.#epoch, ++this.#synthetic),
        stream,
        block,
        ordinal: rec.run.ordinal * ITEMS_PER_RUN + ++rec.items,
        runId: rec.run.id,
        startedAt: this.#at,
        text: "",
      };
      this.#streams.push(slot);
    }
    slot.text += body;
    this.#emitStream(rec, slot, true);
  }

  #emitStream(rec: RunRecord, slot: StreamSlot, streaming: boolean): void {
    const fields =
      slot.stream === "text"
        ? ({
            type: "assistant_message",
            messageId: Ids.syntheticMessageId(this.#o.threadId, this.#epoch, slot.ordinal),
            text: slot.text,
            streaming,
            status: streaming ? "running" : "completed",
            title: null,
          } as const)
        : ({
            type: "reasoning",
            text: slot.text,
            streaming,
            status: streaming ? "running" : "completed",
            title: "Thinking",
          } as const);
    this.#item(rec, fields, slot.itemId, slot.ordinal, slot.startedAt);
  }

  /**
   * Draws the run's open streams as completed, at its end or at the end of a
   * step. The slots stay until the stored block for each arrives (#reply), so
   * that block keeps the streamed row's id and place instead of drawing the
   * reply a second time.
   */
  #closeStreams(rec: RunRecord): void {
    for (const slot of this.#streams) {
      if (slot.runId !== rec.run.id || slot.settled) continue;
      slot.settled = true;
      this.#emitStream(rec, slot, false);
    }
  }

  #toolUse(e: LobbyEvent): void {
    const rec = this.#ensureOpen(e);
    rec.hasOutput = true;
    // A tool call ends its step. The mod's step index does not reach the
    // sidecar, and the next step numbers its blocks from 0 again, so its
    // deltas would otherwise land in this step's rows. Thinking is never
    // stored (normalize.go drops empty thinking blocks), so nothing else
    // would ever close it before turn_end.
    this.#closeStreams(rec);
    const tool = e.tool ?? "";
    const toolId = e.toolId ?? `event-${e.id}`;
    const input = parseToolInput(e.body);
    const ordinal = rec.run.ordinal * ITEMS_PER_RUN + ++rec.items;
    const base = this.#itemBase(rec, Ids.toolItemId(this.#o.threadId, toolId), ordinal, this.#at);
    const record: ToolRecord = { tool, input, base, done: false };
    this.#tools.set(toolId, record);
    this.#emitItem(toolItem(base, tool, input, undefined));
  }

  #toolResult(e: LobbyEvent): void {
    const record = e.toolId === undefined ? undefined : this.#tools.get(e.toolId);
    if (record === undefined) return;
    record.done = true;
    const base = { ...record.base, completedAt: utc(this.#at), updatedAt: utc(this.#at) };
    this.#emitItem(
      toolItem(base, record.tool, record.input, {
        body: e.body ?? "",
        isError: e.isError === true,
        result: e.result,
      }),
    );
    // An approved plan takes the session out of plan mode, and no transcript
    // row says so until the next prompt: the CLI writes the mode only at a
    // turn's start. Left alone, the composer keeps showing Plan. The runtime
    // mode is the one the plan was entered from; the next turn's reading
    // corrects it when the approval picked another (auto, say).
    if (
      record.tool === "ExitPlanMode" &&
      e.isError !== true &&
      this.#modes.interactionMode === "plan"
    ) {
      this.#setMode(lobbyModeFor(this.#modes.runtimeMode));
    }
  }

  /** The newest running call of a tool, for a dialog that does not name its call. */
  #latestOpenTool(match: (tool: string) => boolean): string | undefined {
    let found: string | undefined;
    for (const [toolId, record] of this.#tools) {
      if (!record.done && match(record.tool)) found = toolId;
    }
    return found;
  }

  // ---- dialogs ------------------------------------------------------------

  #held(body: string, eventId: number): void {
    const open = [...this.#dialogs.values()].filter((d) => d.kind === "ask");
    if (body.trim() === "") {
      for (const d of open) this.#resolveDialog(d, "resolved");
      return;
    }
    const parsed = parseHeld(body);
    if (parsed === undefined) return;
    const seen = new Set<string>();
    for (const [index, call] of parsed.calls.entries()) {
      const toolId =
        call.toolId ??
        (index === 0 ? parsed.toolId : undefined) ??
        this.#latestOpenTool((t) => t === "AskUserQuestion" && !this.#dialogs.has(t)) ??
        `ask-${eventId}-${index}`;
      seen.add(toolId);
      if (this.#dialogs.has(toolId)) continue;
      this.#openAsk(toolId, call.questions);
    }
    // A server that names its calls says which one ended; one that does not
    // sends "" when the last one goes.
    if (parsed.calls.every((c) => c.toolId !== undefined)) {
      for (const d of open) if (!seen.has(d.toolId)) this.#resolveDialog(d, "resolved");
    }
  }

  #openAsk(toolId: string, questions: ReadonlyArray<HeldQuestion>): void {
    const rec = this.#open ?? this.#last;
    const requestId = Ids.requestId(toolId);
    const nodeId = Ids.requestNodeId(toolId);
    const runId = rec?.run.id ?? null;
    this.#emit(
      "node.updated",
      this.#requestNode(rec, nodeId, "user_input_request", "waiting"),
      runId ?? undefined,
    );
    this.#emit(
      "runtime-request.updated",
      this.#runtimeRequest(rec, requestId, nodeId, "user_input", "pending"),
      runId ?? undefined,
    );
    const itemIds: TurnItemId[] = [];
    if (rec !== undefined) {
      itemIds.push(
        this.#item(
          rec,
          {
            type: "user_input_request",
            requestId,
            questions: questions.map(toT3Question),
            status: "waiting",
            title: null,
          },
          Ids.syntheticItemId(this.#o.threadId, this.#epoch, ++this.#synthetic),
          undefined,
          undefined,
          nodeId,
        ),
      );
    }
    this.#dialogs.set(toolId, {
      kind: "ask",
      toolId,
      runId,
      questions,
      planOptions: [],
      itemIds,
      createdAt: this.#at,
    });
  }

  #asking(body: string, eventId: number): void {
    const open = [...this.#dialogs.values()].filter((d) => d.kind !== "ask");
    if (body.trim() === "") {
      for (const d of open) this.#resolveDialog(d, "resolved");
      return;
    }
    const reading = parseReading(body);
    if (reading === undefined || (reading.kind !== "permission" && reading.kind !== "plan")) return;
    const toolId =
      reading.toolId ??
      (reading.kind === "plan"
        ? this.#latestOpenTool((t) => t === "ExitPlanMode")
        : this.#latestOpenTool((t) => t !== "AskUserQuestion" && t !== "ExitPlanMode")) ??
      `${reading.kind}-${eventId}`;
    for (const d of open) if (d.toolId !== toolId) this.#resolveDialog(d, "resolved");
    const existing = this.#dialogs.get(toolId);
    if (existing !== undefined) {
      // Claude's own plan menu was read off the pane after the synthetic row.
      if (existing.kind === "plan") {
        this.#dialogs.set(toolId, { ...existing, planOptions: reading.options });
      }
      return;
    }
    const rec = this.#open ?? this.#last;
    const runId = rec?.run.id ?? null;
    const requestId = Ids.requestId(toolId);
    const nodeId = Ids.requestNodeId(toolId);
    const tool = reading.tool ?? this.#tools.get(toolId)?.tool ?? "";
    const requestKind: ProviderRequestKind =
      reading.kind === "plan" ? "permission" : classifyTool(tool).requestKind;
    this.#emit(
      "node.updated",
      this.#requestNode(rec, nodeId, "approval_request", "waiting"),
      runId ?? undefined,
    );
    this.#emit(
      "runtime-request.updated",
      this.#runtimeRequest(rec, requestId, nodeId, requestKind, "pending"),
      runId ?? undefined,
    );
    const itemIds: TurnItemId[] = [];
    if (rec !== undefined && reading.kind === "plan") {
      const plan: OrchestrationV2PlanArtifact = {
        id: Ids.planId(toolId),
        threadId: this.#o.threadId,
        runId,
        nodeId,
        status: "active",
        kind: "proposed_plan",
        markdown: reading.plan ?? "",
      };
      this.#emit("plan.updated", plan, runId ?? undefined);
      itemIds.push(
        this.#item(
          rec,
          {
            type: "proposed_plan",
            planId: plan.id,
            markdown: plan.markdown,
            streaming: false,
            status: "completed",
            title: null,
          },
          Ids.syntheticItemId(this.#o.threadId, this.#epoch, ++this.#synthetic),
          undefined,
          undefined,
          nodeId,
        ),
      );
    }
    if (rec !== undefined) {
      const prompt =
        reading.kind === "plan"
          ? "Approve this plan?"
          : [reading.title, ...(reading.detail ?? [])]
              .filter((l) => l !== undefined && l !== "")
              .join("\n");
      itemIds.push(
        this.#item(
          rec,
          {
            type: "approval_request",
            requestId,
            requestKind,
            ...(prompt === "" ? {} : { prompt }),
            status: "waiting",
            title: reading.title ?? null,
          },
          Ids.syntheticItemId(this.#o.threadId, this.#epoch, ++this.#synthetic),
          undefined,
          undefined,
          nodeId,
        ),
      );
    }
    this.#dialogs.set(toolId, {
      kind: reading.kind,
      toolId,
      runId,
      questions: [],
      planOptions: reading.options,
      itemIds,
      createdAt: this.#at,
    });
  }

  #resolveDialog(dialog: OpenDialog, status: "resolved" | "expired"): void {
    this.#dialogs.delete(dialog.toolId);
    const rec = dialog.runId === null ? undefined : this.#runs.get(dialog.runId);
    const requestId = Ids.requestId(dialog.toolId);
    const nodeId = Ids.requestNodeId(dialog.toolId);
    const runId = dialog.runId ?? undefined;
    const kind: OrchestrationV2RuntimeRequest["kind"] =
      dialog.kind === "ask"
        ? "user_input"
        : dialog.kind === "plan"
          ? "permission"
          : classifyTool(this.#tools.get(dialog.toolId)?.tool ?? "").requestKind;
    this.#emit(
      "runtime-request.updated",
      {
        ...this.#runtimeRequest(rec, requestId, nodeId, kind, status),
        createdAt: utc(dialog.createdAt),
        resolvedAt: utc(this.#at),
      },
      runId,
    );
    this.#emit(
      "node.updated",
      this.#requestNode(
        rec,
        nodeId,
        dialog.kind === "ask" ? "user_input_request" : "approval_request",
        "completed",
      ),
      runId,
    );
    if (dialog.kind === "plan") {
      this.#emit(
        "plan.updated",
        {
          id: Ids.planId(dialog.toolId),
          threadId: this.#o.threadId,
          runId: dialog.runId,
          nodeId,
          status: "completed",
          kind: "proposed_plan",
          markdown: "",
          detailInTurnItem: true,
        },
        runId,
      );
    }
    for (const itemId of dialog.itemIds) {
      const item = this.#items.get(itemId);
      if (
        item === undefined ||
        (item.type !== "user_input_request" && item.type !== "approval_request")
      )
        continue;
      this.#emitItem({
        ...item,
        status: "completed",
        completedAt: utc(this.#at),
        updatedAt: utc(this.#at),
      });
    }
  }

  // ---- modes --------------------------------------------------------------

  #setMode(mode: string): void {
    const next = modesFromLobby(mode, this.#modes);
    const enteringOutside = next.outsideT3 && !this.#modes.outsideT3;
    this.#modes = next;
    if (next.runtimeMode !== this.#thread.runtimeMode) {
      this.#thread = { ...this.#thread, runtimeMode: next.runtimeMode };
      this.#emit("thread.runtime-mode-updated", this.#thread);
    }
    if (next.interactionMode !== this.#thread.interactionMode) {
      this.#thread = { ...this.#thread, interactionMode: next.interactionMode };
      this.#emit("thread.interaction-mode-updated", this.#thread);
    }
    if (enteringOutside) {
      this.#pendingNotice = DONT_ASK_NOTICE;
      this.#flushNotice();
    }
  }

  #setModel(model: ModelState): void {
    if (model.model === undefined) return;
    const current = this.#thread.modelSelection;
    // A reading that names no effort keeps the one in force, unless the model
    // moved: efforts are per model, and Haiku has none.
    const effort = model.effort ?? (model.model === current.model ? effortOf(current) : undefined);
    const next = {
      instanceId: CLAUDE_INSTANCE_ID,
      model: model.model,
      ...(effort === undefined ? {} : { options: [{ id: "effort", value: effort }] }),
    };
    if (next.model === current.model && effort === effortOf(current)) return;
    this.#thread = { ...this.#thread, modelSelection: next };
    this.#emit("thread.model-selection-updated", this.#thread);
  }

  // ---- entity builders ----------------------------------------------------

  readonly #items = new Map<TurnItemId, OrchestrationV2TurnItem>();

  #itemBase(
    rec: RunRecord,
    id: TurnItemId,
    ordinal: number,
    startedAt: number,
    nodeId = Ids.rootNodeId(rec.run.id),
  ): ItemBase {
    return {
      id,
      threadId: this.#o.threadId,
      runId: rec.run.id,
      nodeId,
      providerThreadId: Ids.providerThreadId(this.#o.threadId),
      providerTurnId: Ids.providerTurnId(rec.run.id),
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "running",
      title: null,
      startedAt: utc(startedAt),
      completedAt: null,
      updatedAt: utc(this.#at),
    };
  }

  /** Emits one turn item in a run; returns its id. */
  #item(
    rec: RunRecord,
    fields: DistributiveOmit<OrchestrationV2TurnItem, keyof ItemBase> & {
      readonly status: OrchestrationV2TurnItem["status"];
      readonly title: string | null;
    },
    id: TurnItemId = Ids.syntheticItemId(this.#o.threadId, this.#epoch, ++this.#synthetic),
    ordinal: number = rec.run.ordinal * ITEMS_PER_RUN + ++rec.items,
    startedAt: number = this.#at,
    nodeId?: OrchestrationV2ExecutionNode["id"],
  ): TurnItemId {
    const base = this.#itemBase(rec, id, ordinal, startedAt, nodeId);
    const done =
      fields.status !== "running" && fields.status !== "waiting" && fields.status !== "pending";
    this.#emitItem({
      ...base,
      ...fields,
      completedAt: done ? utc(this.#at) : null,
    } as OrchestrationV2TurnItem);
    return id;
  }

  #emitItem(item: OrchestrationV2TurnItem): void {
    this.#items.set(item.id, item);
    this.#emit("turn-item.updated", item, item.runId ?? undefined);
  }

  #message(
    rec: RunRecord,
    id: MessageId,
    role: "user" | "assistant",
    text: string,
    nodeId: OrchestrationV2ExecutionNode["id"] | null,
  ): void {
    this.#emit(
      "message.updated",
      {
        createdBy: role === "user" ? "user" : "agent",
        creationSource: role === "user" ? "web" : "provider",
        id,
        threadId: this.#o.threadId,
        runId: rec.run.id,
        nodeId,
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt: utc(this.#at),
        updatedAt: utc(this.#at),
      },
      rec.run.id,
    );
  }

  #setRun(rec: RunRecord, patch: Partial<OrchestrationV2Run>): void {
    rec.run = { ...rec.run, ...patch };
    this.#emit("run.updated", rec.run, rec.run.id);
  }

  #attempt(rec: RunRecord, status: OrchestrationV2RunAttempt["status"]): OrchestrationV2RunAttempt {
    const done = status !== "running" && status !== "pending";
    return {
      id: Ids.attemptId(rec.run.id),
      runId: rec.run.id,
      attemptOrdinal: 1,
      rootNodeId: Ids.rootNodeId(rec.run.id),
      providerInstanceId: CLAUDE_INSTANCE_ID,
      providerThreadId: Ids.providerThreadId(this.#o.threadId),
      providerTurnId: Ids.providerTurnId(rec.run.id),
      reason: "initial",
      status,
      startedAt: rec.run.startedAt,
      completedAt: done ? utc(this.#at) : null,
    };
  }

  #rootNode(
    rec: RunRecord,
    status: OrchestrationV2ExecutionNode["status"],
  ): OrchestrationV2ExecutionNode {
    const root = Ids.rootNodeId(rec.run.id);
    const done =
      status === "completed" ||
      status === "interrupted" ||
      status === "cancelled" ||
      status === "failed";
    return {
      id: root,
      threadId: this.#o.threadId,
      runId: rec.run.id,
      parentNodeId: null,
      rootNodeId: root,
      kind: "root_turn",
      status,
      countsForRun: true,
      providerThreadId: Ids.providerThreadId(this.#o.threadId),
      providerTurnId: rec.run.startedAt === null ? null : Ids.providerTurnId(rec.run.id),
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: rec.run.startedAt,
      completedAt: done ? utc(this.#at) : null,
    };
  }

  #providerTurn(
    rec: RunRecord,
    status: "running" | "completed" | "interrupted",
    usage?: Readonly<Record<string, unknown>>,
  ) {
    const tokens = usage === undefined ? undefined : tokenUsage(usage, this.#at);
    return {
      id: Ids.providerTurnId(rec.run.id),
      providerThreadId: Ids.providerThreadId(this.#o.threadId),
      nodeId: Ids.rootNodeId(rec.run.id),
      runAttemptId: Ids.attemptId(rec.run.id),
      nativeTurnRef: null,
      ordinal: rec.run.ordinal,
      status,
      startedAt: rec.run.startedAt,
      completedAt: status === "running" ? null : utc(this.#at),
      ...(tokens === undefined ? {} : { tokenUsage: tokens }),
    };
  }

  #requestNode(
    rec: RunRecord | undefined,
    id: OrchestrationV2ExecutionNode["id"],
    kind: "approval_request" | "user_input_request",
    status: OrchestrationV2ExecutionNode["status"],
  ): OrchestrationV2ExecutionNode {
    const root = rec === undefined ? id : Ids.rootNodeId(rec.run.id);
    return {
      id,
      threadId: this.#o.threadId,
      runId: rec?.run.id ?? null,
      parentNodeId: rec === undefined ? null : root,
      rootNodeId: root,
      kind,
      status,
      countsForRun: false,
      providerThreadId: Ids.providerThreadId(this.#o.threadId),
      providerTurnId: rec === undefined ? null : Ids.providerTurnId(rec.run.id),
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: utc(this.#at),
      completedAt: status === "completed" ? utc(this.#at) : null,
    };
  }

  #runtimeRequest(
    rec: RunRecord | undefined,
    id: OrchestrationV2RuntimeRequest["id"],
    nodeId: OrchestrationV2ExecutionNode["id"],
    kind: OrchestrationV2RuntimeRequest["kind"],
    status: OrchestrationV2RuntimeRequest["status"],
  ): OrchestrationV2RuntimeRequest {
    return {
      id,
      nodeId,
      providerTurnId: rec === undefined ? null : Ids.providerTurnId(rec.run.id),
      nativeRequestRef: null,
      kind,
      status,
      // The mod holds the dialog in the running Claude, so an answer lands
      // now: T3's "live". ("message" would make T3 answer a question by
      // sending a new prompt, and draw an approval as unanswerable.)
      responseCapability: {
        type: "live",
        providerSessionId: Ids.providerSessionId(this.#o.threadId),
      },
      createdAt: utc(this.#at),
      resolvedAt: status === "pending" ? null : utc(this.#at),
    };
  }

  #ensureProviderThread(status: "idle" | "active"): void {
    const thread: OrchestrationV2ProviderThread = {
      id: Ids.providerThreadId(this.#o.threadId),
      driver: CLAUDE_DRIVER,
      providerInstanceId: CLAUDE_INSTANCE_ID,
      providerSessionId: null,
      appThreadId: this.#o.threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status,
      firstRunOrdinal: 1,
      lastRunOrdinal: Math.max(1, this.#nextOrdinal - 1),
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      contextUsage: null,
      nativeMetadata: null,
      goal: null,
      createdAt: this.#thread.createdAt,
      updatedAt: utc(this.#at),
    };
    this.#emit("provider-thread.updated", thread);
  }

  // ---- emission -----------------------------------------------------------

  #batch(at: number, body: () => void): DomainEvent[] {
    this.#at = at;
    this.#out = [];
    body();
    const out = this.#out;
    this.#out = [];
    return out;
  }

  #emit<T extends DomainEvent["type"]>(type: T, payload: PayloadOf<T>, runId?: RunId): void {
    const event = {
      id: Ids.domainEventId(this.#o.threadId, `${this.#o.eventPrefix}:${++this.#eventCount}`),
      threadId: this.#o.threadId,
      ...(runId === undefined ? {} : { runId }),
      providerInstanceId: CLAUDE_INSTANCE_ID,
      occurredAt: utc(this.#at),
      type,
      payload,
    } as DomainEvent;
    this.#out.push(event);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The payload of the domain event (or events, for a member listing several types) of type T. */
type PayloadOf<T extends DomainEvent["type"]> = DomainEvent extends infer E
  ? E extends { readonly type: infer U; readonly payload: infer P }
    ? T extends U
      ? P
      : never
    : never
  : never;

function effortOf(selection: OrchestrationV2AppThread["modelSelection"]): string | undefined {
  const options = selection.options;
  if (!Array.isArray(options)) return undefined;
  for (const option of options as ReadonlyArray<{ id: string; value: unknown }>) {
    if (option.id === "effort" && typeof option.value === "string") return option.value;
  }
  return undefined;
}

/** A turn_end's `usage` as T3's provider-turn token usage. */
function tokenUsage(usage: Readonly<Record<string, unknown>>, atMs: number) {
  const n = (k: string) =>
    typeof usage[k] === "number" && Number.isInteger(usage[k]) && (usage[k] as number) >= 0
      ? (usage[k] as number)
      : 0;
  const inputTokens = n("input_tokens") + n("cache_creation_input_tokens");
  const cachedInputTokens = n("cache_read_input_tokens");
  const outputTokens = n("output_tokens");
  return {
    usedTokens: inputTokens + cachedInputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    updatedAt: new Date(atMs).toISOString(),
  };
}

function summaryOf(notification: string): string {
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(notification);
  return nonEmpty(m?.[1], "Background task finished");
}

function toT3Question(q: HeldQuestion): OrchestrationV2UserInputQuestion {
  const question = nonEmpty(q.question, "Question");
  return {
    id: question,
    header: nonEmpty(q.header, "Question"),
    question,
    options: q.options
      .filter((o) => o.label.trim() !== "")
      .map((o) => ({ label: o.label.trim(), description: nonEmpty(o.description, o.label) })),
    ...(q.multiSelect === true ? { multiSelect: true } : {}),
    allowCustomAnswer: true,
  };
}

interface HeldBody {
  readonly toolId?: string;
  readonly calls: ReadonlyArray<{
    readonly toolId?: string;
    readonly questions: ReadonlyArray<HeldQuestion>;
  }>;
}

function questionsOf(value: unknown): HeldQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: HeldQuestion[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const q = raw as Record<string, unknown>;
    if (typeof q.question !== "string") continue;
    const options = Array.isArray(q.options)
      ? q.options.flatMap((o) => {
          if (typeof o !== "object" || o === null) return [];
          const { label, description } = o as Record<string, unknown>;
          return typeof label === "string"
            ? [{ label, ...(typeof description === "string" ? { description } : {}) }]
            : [];
        })
      : [];
    out.push({
      question: q.question,
      ...(typeof q.header === "string" ? { header: q.header } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out;
}

/** session-events' held body: {questions, calls: [{questions, toolId?}], toolId?}. */
export function parseHeld(body: string): HeldBody | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const toolId = typeof o.toolId === "string" && o.toolId !== "" ? o.toolId : undefined;
  const calls = Array.isArray(o.calls)
    ? o.calls.flatMap((c) => {
        if (typeof c !== "object" || c === null) return [];
        const call = c as Record<string, unknown>;
        const id = typeof call.toolId === "string" && call.toolId !== "" ? call.toolId : undefined;
        return [
          { ...(id === undefined ? {} : { toolId: id }), questions: questionsOf(call.questions) },
        ];
      })
    : [{ questions: questionsOf(o.questions) }];
  return { ...(toolId === undefined ? {} : { toolId }), calls };
}

interface Reading {
  readonly kind: string;
  readonly toolId?: string;
  readonly tool?: string;
  readonly title?: string;
  readonly detail?: ReadonlyArray<string>;
  readonly plan?: string;
  readonly options: ReadonlyArray<{ readonly number: number; readonly label: string }>;
}

/** session-events' asking body: a sessionio.Dialog, plus toolId and tool. */
export function parseReading(body: string): Reading | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" && o[k] !== "" ? (o[k] as string) : undefined);
  const options = Array.isArray(o.options)
    ? o.options.flatMap((x) => {
        if (typeof x !== "object" || x === null) return [];
        const { number, label } = x as Record<string, unknown>;
        return typeof number === "number" && typeof label === "string" ? [{ number, label }] : [];
      })
    : [];
  const detail = Array.isArray(o.detail)
    ? o.detail.filter((d): d is string => typeof d === "string")
    : undefined;
  const out: { -readonly [K in keyof Reading]: Reading[K] } = { kind: s("kind") ?? "", options };
  const toolId = s("toolId");
  if (toolId !== undefined) out.toolId = toolId;
  const tool = s("tool");
  if (tool !== undefined) out.tool = tool;
  const title = s("title");
  if (title !== undefined) out.title = title;
  if (detail !== undefined) out.detail = detail;
  const plan = s("plan");
  if (plan !== undefined) out.plan = plan;
  return out;
}
