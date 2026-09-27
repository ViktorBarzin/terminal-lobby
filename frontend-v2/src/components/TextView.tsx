import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  useContext,
  type Component,
} from "solid-js";
import type {
  AgentInfo,
  Event,
  PermissionDecision,
  SessionState,
  WorkflowInfo,
} from "../types/events";
import {
  askingFromPane,
  permissionFromPane,
  currentMode,
  currentModel,
  deriveRows,
  liveRowOf,
  pendingQuestion,
  promptHistory,
  queuedPrompts,
  withoutQueued,
  withPendingPrompts,
  planFromPane,
  type PendingPermission,
  type PlanReading,
  type PlanRow,
  type PlanTransient,
  type TimelineRow,
  type WorkingRow,
} from "./timeline.logic";
import { modeFromPane, type PendingPrompt, type SlashCommand } from "../logic/compose.logic";
import type { Catalogue } from "../store/catalogue";
import { contextState } from "./context.logic";
import {
  sameDrawnQuestion,
  type AnswerRequest,
  type AnswerResponse,
  type DialogOptionView,
  type DialogQuestionView,
  type DialogView,
  type PlanAnswer,
  type PlanOptionView,
  type QuestionDialogView,
} from "../lib/answer-api";
import type { Question } from "./canonicalize";
import { QuestionCard, type TypedAnswer } from "./QuestionCard";
import { PlanCard } from "./PlanCard";
import { PermissionCard } from "./PermissionCard";
import {
  clearsContext,
  decidePlanDock,
  feedbackClearsContext,
  planDockFacts,
  planFeedback,
  planReadingKey,
  planReplyNotice,
  type PlanDock,
  type PlanNotice,
  type PlanSending,
} from "./plan.logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { backgroundLabel } from "./lobby.logic";
import type { BackgroundWork, SessionTool } from "../types/lobby";
import { AgentPanel } from "./AgentPanel";
import { AgentTranscript } from "./AgentTranscript";
import { panelPresent, type AgentSnapshot } from "./agents.logic";
import { TileFocusContext } from "../lib/ownwhile";
import { isEditingTarget } from "../keybindings/editing";
import { installTextZoom, loadTextSize, saveTextSize, scaleFor } from "../mobile/textzoom";
import { Composer, type ComposerSinks } from "./Composer";
import type { DraftAttachment } from "../store/drafts";
import {
  isCurrentModel,
  type ModelField,
  type ModelHarness,
  type ModelState,
  type PiOffer,
} from "../lib/models";
import type { SetModelResult } from "../lib/model-api";
import type { SetModeReply, SetModeResult } from "../lib/mode-api";
import { isDangerMode, modeTitle, type ModeId } from "../logic/modes";

/**
 * A model reading, as one comparable string.
 *
 * The applied reading holds only until the TRANSCRIPT moves, and this is how it
 * notices: the reading is stored alongside the transcript's value at the moment
 * it was taken, and it simply stops matching when a turn writes a new one. The
 * same trick the mode dial uses for its pane reading, and it needs no
 * bookkeeping to expire.
 */
const modelKey = (m: ModelState | undefined): string => `${m?.model ?? ""}/${m?.effort ?? ""}`;

/**
 * When to look at the pane after asking it to change, in ms. The CLI's status
 * line repainted 40ms after the keystroke when this was measured (2026-08-17);
 * the first delay is that with room to spare, the second is the retry.
 *
 * This is Shift+Tab's own read-back, and the last one left in this file. A
 * pick from the mode dial's list does not wait on the pane from here: the
 * server walks and reads in one local sequence and replies with the mode it
 * read (lib/mode-api.ts), and answering a dialog works the same way
 * (sessionio/answerdrive.go).
 */
const PANE_READ_DELAYS_MS = [150, 600];

/**
 * Why the mode cannot change while a dialog is on the pane.
 *
 * Shift+Tab is the only way the CLI changes mode, and inside a dialog it is a
 * key the dialog reads. On the plan approval's feedback row it APPROVES the
 * plan with whatever was typed (measured on CLI 2.1.281, memory #13896). What
 * it does in a question or a permission dialog was not measured, so those hold
 * the dial too, as a precaution (spec section 5.5).
 */
const MODE_HELD_BY_DIALOG =
  "Answer Claude first: a mode change now would type into the open dialog";
/** The same hold for the model dial: `/model` is typed into the pane too, and
 *  the server already refuses it while a question is up. */
const MODEL_HELD_BY_DIALOG =
  "Answer Claude first: a model change now would type into the open dialog";

/**
 * How long this client's applied plan answer stands in for the transcript's
 * record of it, in ms (docs/plans/2026-09-24-text-composer-redesign.md, the
 * reply table). The result is normally written within a second or two; a clear
 * context switches the stream to the new conversation in about 6 s. Past this
 * the answer is taken not to have landed, and the row and the dock go back to
 * what the transcript and the pane say.
 */
const PLAN_SETTLE_MS = 20_000;

/** Every plan row in a fold of the transcript, folded away or not. */
function findPlanRow(rows: TimelineRow[], toolId: string): PlanRow | undefined {
  for (const r of rows) {
    for (const leaf of r.kind === "turn-fold" ? r.hidden : [r]) {
      if (leaf.kind === "plan" && leaf.toolId === toolId) return leaf;
    }
  }
  return undefined;
}

/**
 * What a refused mode pick says, and how loudly.
 *
 * The dial already shows the mode the reply read, so these say why it is not
 * the one picked. `unsafe-path` comes in two shapes: refused before a single
 * press (the pane is still on the start), or stopped mid-walk because a mode
 * that asks nothing showed while Claude worked, in which case the session IS
 * in that mode now and the reader has to hear it as an error. Walks to Auto
 * will be refused often: sessions here start with
 * --dangerously-skip-permissions, which puts Bypass between Plan and Auto on
 * the cycle (memory #13911).
 */
function refusal(
  target: ModeId,
  was: string,
  reply: SetModeReply,
): { text: string; tone: "warning" | "error" } {
  const to = modeTitle(target);
  const now = modeTitle(reply.mode || was);
  switch (reply.reason) {
    case "unavailable":
      return {
        text: `${to} is not offered in this session, so it stayed on ${now}.`,
        tone: "warning",
      };
    case "unsafe-path":
      if (reply.mode && reply.mode !== was && isDangerMode(reply.mode)) {
        return {
          text: `Stopped on ${now} on the way to ${to}, because Claude is working. The session is on ${now} now.`,
          tone: "error",
        };
      }
      return {
        text:
          `Reaching ${to} from ${modeTitle(was)} passes through Bypass while Claude is working. ` +
          "Stop Claude first, or pick it when the turn ends.",
        tone: "warning",
      };
    case "dialog-open":
      return { text: `${MODE_HELD_BY_DIALOG}.`, tone: "warning" };
    // The server's other three (sessionio setmode.go). Each gets a sentence
    // rather than the bare word, since a toast is read by someone who has
    // never seen the driver.
    case "unverified":
      return {
        text: `Shift+Tab went in and the status line did not move, so nothing more was pressed. The session is on ${now}.`,
        tone: "warning",
      };
    case "unreadable":
      return {
        text: "The pane shows no permission mode to start from, so nothing was pressed.",
        tone: "warning",
      };
    case "refused":
      return {
        text: "tmux would not take the key, so the mode did not change.",
        tone: "error",
      };
    default:
      return {
        text: `The mode did not change: ${reply.reason || "no reason given"}.`,
        tone: "error",
      };
  }
}

/**
 * The narrowest text view the agent panel keeps its margin in, in px. The
 * prototype's breakpoint: a 260px rail beside what is left still reads as a
 * column, and below it the panel folds into a strip above the transcript.
 */
const RAIL_MIN_PX = 900;

/**
 * Text mode — the PRIMARY view. Structured transcript render (MessagesTimeline)
 * above a composer with the docked permission panel.
 *
 * It also owns the upward half of ADR-0010: a blocking prompt is mirrored from
 * the transcript (a question) or from the pane (a permission dialog), and the
 * answer goes back into the same pty. A permission decision and Shift+Tab go
 * as keys from here. A QUESTION does not, since 2026-09-10: each choice is
 * one request to the server, which types beside the parser and replies with a
 * reading of the screen that resulted (docs/plans/2026-09-10-text-mode-
 * answers-dialogs-design.md). A pick from the mode dial's list works the same
 * way since 2026-09-24: one request, and the server walks the keys and reads
 * the pane itself (lib/mode-api.ts).
 */
export const TextView: Component<{
  events: Event[];
  /** What the SESSION still owes, from the session list rather than the
   *  transcript. The transcript cannot answer this: it closes the turn when the
   *  main thread stops talking, and says nothing about the background agent
   *  that is still running. */
  background?: () => BackgroundWork | undefined;
  /** The session's agents and workflow runs, from the stream's `agents` frame.
   *  Absent, or null, against a server that predates it: no panel. */
  agents?: () => AgentSnapshot | null;
  /** Which command the session runs, from the session list. The agent panel
   *  shows only while the session's claude is there to run its agents. */
  tool?: () => SessionTool | undefined;
  pending: PendingPermission[];
  /** resolves false when the session refused the prompt (the composer keeps it). */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onResolve: (reqId: string, decision: PermissionDecision) => void;
  /** Mobile: forward composed bytes to the live pty (bracketed paste + submit). */
  sendToTerminal?: (bytes: string) => void;
  /** open a file path in the preview overlay (transcript Read/Edit/Write rows). */
  onOpenPreview?: (path: string) => void;
  /** type keys into the session's pane: Shift+Tab in the message field. */
  onKeys?: (keys: string[]) => Promise<boolean>;
  /** put the session in a permission mode picked from the mode dial's list;
   *  the server walks Shift+Tab to it and replies with the mode it read. */
  onSetMode?: (mode: ModeId) => Promise<SetModeResult>;
  /** read what the session's pane currently shows — the live permission mode. */
  onPane?: () => Promise<{ pane: string; state: string } | null>;
  /**
   * Put ONE request to the session's dialog — a choice, a step back, a submit,
   * or raw keys — and read back what the pane shows afterwards
   * (lib/answer-api). Absent means this view cannot answer, and no card docks.
   *
   * Null resolves only when the CALL failed. A refusal is an ordinary reply
   * carrying the current reading, which is what lets the card re-render
   * against the screen instead of latching.
   */
  onAnswer?: (req: AnswerRequest) => Promise<AnswerResponse | null>;
  /** surface a request that never reached the session to the app's toast stack. */
  notify?: (message: string, kind: "info" | "error" | "warning" | "success") => void;
  /** the session's own skills / custom commands, for the `/` menu. */
  onCommands?: () => Promise<Catalogue>;
  /** prompts sent from here the transcript has not shown yet. */
  pendingPrompts?: () => PendingPrompt[];
  /** The rows for `events`, when the owner has already derived them — the
   *  session view needs the same fold to know whether a turn is running, and
   *  one derivation costs ~10ms on a large window. Absent, they are derived
   *  here, so this is a shortcut and never a second source of truth. */
  rows?: () => TimelineRow[];
  /** the opening window is still arriving. */
  opening?: boolean;
  /** FALSE while the lobby is keeping this session mounted without showing it:
   *  a hidden view answers for nothing global. */
  onScreen?: boolean;
  /** FALSE while the session's Terminal is the view on screen in its place.
   *  Coming back from it re-reads the mode, which a Shift+Tab there moves. */
  textShown?: boolean;
  /** The session's stream is parked while nobody reads it. An agent's
   *  transcript open in the drill-in parks with it. */
  parked?: boolean;
  /** fetch a capped tool result in full. */
  onLoadFull?: (toolId: string) => Promise<string | null>;
  /** take one step further back through the transcript. */
  onLoadEarlier?: () => Promise<void>;
  hasEarlier?: boolean;
  /** the reader reached the bottom of the transcript, or left it — the store
   *  trims its window only while pinned. Forwarded from MessagesTimeline,
   *  which is what knows. */
  onPinned?: (pinned: boolean) => void;
  /** what the store currently holds for that pin, so the timeline can tell when
   *  it has been moved from the other end (loadEarlier unpins directly). */
  pinned?: boolean;
  /** what the held window cannot carry: the mode, the newest /context reading,
   *  the queue and the composer's history, folded over the whole session. */
  sessionState?: SessionState | null;
  /** list a directory for `@` completion. */
  onListDir?: (dir: string) => Promise<string[]>;
  /** the session, so the composer can key its unsent draft. */
  session?: string;
  /** which CLI the session runs, from the session list's own `tool`. Absent
   *  for a plain shell, which has no model to pick. */
  harness?: ModelHarness | null;
  /** put the session on a model or an effort level, and say what happened. */
  onSetModel?: (choice: { model: string; effort: string }) => Promise<SetModelResult>;
  /** what a pi session stamped about itself (the session list's `piModel` and
   *  `piThinking`). Read when the transcript names no model, which for a pi
   *  session is always: the lobby reads no pi transcript. */
  stampedModel?: ModelState;
  /** pi's rows for the chip: the models pi lists and the levels the session's
   *  model supports. Absent for every other harness. */
  modelOffer?: PiOffer;
  /** the effective OS user — decides which store paths render as attachments. */
  me?: string;
  /** upload files and return the ones that became attachable. */
  onAttach?: (files: File[]) => Promise<DraftAttachment[]>;
  /** watching: the controls that type, and attaching, are inert. */
  inertReason?: string;
  /** stop watching and drive the session from this device: the thin line's
   *  Take control, the same toggle as the header's Watch button. */
  onTakeControl?: () => void;
  /** receive the composer's sinks, for gestures that land outside it. */
  register?: (api: ComposerSinks) => void;
  /** show the Terminal view — where a question the pane can only half show has
   *  to be answered until the transcript catches up. */
  onOpenTerminal?: () => void;
}> = (props) => {
  const queued = createMemo(() => queuedPrompts(props.events, props.sessionState));
  // What the transcript says, plus what it has not caught up with. A prompt
  // Claude has already queued is left out: the timeline draws it as a ghost
  // bubble at its end, and one message should show once (withoutQueued).
  const sent = createMemo(() => withoutQueued(props.pendingPrompts?.() ?? [], queued()));
  const shown = createMemo(() => withPendingPrompts(props.events, sent()));
  /** The transcript folded, once. */
  const baseRows = createMemo(() => props.rows?.() ?? deriveRows(props.events));
  /** What the timeline draws. `withPendingPrompts` returns `events` itself when
   *  nothing is in flight, so the common case reuses the fold above rather than
   *  repeating it; an unsent prompt is rare and short-lived. */
  const shownRows = createMemo(() => (sent().length === 0 ? baseRows() : deriveRows(shown())));
  /**
   * The open turn's live row, off the rows the timeline draws: with a prompt
   * pending that is the pending turn, whose row reads "Working" with no tool,
   * which is what the timeline showed in that moment before the row moved onto
   * the composer's thin line (2026-09-24). A slash command pending on its own
   * is the exception (liveRowOf): it may never be recorded, so the row is the
   * transcript's until it is.
   */
  const live = createMemo(() => liveRowOf(shownRows(), baseRows(), sent()));
  const history = createMemo(() => promptHistory(props.events, props.sessionState));
  const [modeBusy, setModeBusy] = createSignal(false);

  /**
   * The permission mode in force.
   *
   * Two sources, because neither alone is right. The transcript records the mode
   * at every turn, which is what an arriving session has to go on — but the CLI
   * does NOT write a record when the mode CHANGES. Measured 2026-08-17: pressing
   * the chip moved a session from bypass to auto in 40ms and its transcript
   * still said bypass twenty minutes later. A chip fed only by the transcript
   * therefore never shows what pressing it just did, which is what Viktor
   * reported.
   *
   * So the pane is read at the moments the answer can have changed without a
   * turn behind it: when this view opens, and right after Shift+Tab. A pick
   * from the dial's list comes back with a reading of its own, the mode the
   * server's walk ended on, and is stored the same way. A pane reading holds
   * until the transcript reports a mode of its own, at which point the
   * transcript is the fresher of the two and takes over.
   */
  const transcriptMode = createMemo(() => currentMode(props.events, props.sessionState));
  // A pane reading, plus the transcript value it was taken against. It stops
  // counting the moment the transcript moves, with no bookkeeping: the reading
  // simply no longer matches what it was taken against.
  const [paneRead, setPaneRead] = createSignal({ mode: "", against: "" });
  const mode = createMemo(() => {
    const t = transcriptMode();
    const p = paneRead();
    return (p.against === t ? p.mode : "") || t;
  });

  /**
   * Re-read the pane, twice when the first read still shows what was there
   * before. The status line repaints ~40ms after the keystroke (measured), so
   * one read is normally enough; the second covers a pane that was mid-repaint
   * at that instant rather than leaving the dial showing the old mode.
   */
  const readMode = async (was: string): Promise<void> => {
    for (const wait of PANE_READ_DELAYS_MS) {
      await new Promise((r) => setTimeout(r, wait));
      const seen = modeFromPane((await props.onPane?.())?.pane ?? "");
      if (!seen) continue;
      setPaneRead({ mode: seen, against: transcriptMode() });
      if (seen !== was) return;
    }
  };
  /**
   * Mount-time work waits until this view is actually looked at.
   *
   * Both views stay mounted — the swap must not drop the terminal's WebSocket or
   * this transcript's scroll position — so `onMount` fires even when the
   * TERMINAL is what is on screen. Two round trips (/pane, and /commands below)
   * were therefore spent on every terminal open by a view nobody was reading,
   * which on a 300 ms link is most of a second before the terminal's own
   * requests get a turn. A one-way latch: once shown, it never withholds again,
   * so switching back and forth costs nothing extra.
   */
  const [everShown, setEverShown] = createSignal(false);
  createEffect(() => {
    if (props.onScreen !== false) setEverShown(true);
  });
  /**
   * The pane is also read at the moments the mode can have moved without this
   * view asking, which the transcript will not report until the next prompt.
   * Each time the view comes back on screen, from the Terminal or from another
   * session: a Shift+Tab typed in the Terminal changes it there. And whenever a turn starts or ends: approving a plan
   * switches mode mid-turn, as can a key pressed on another device. Measured
   * 2026-09-26: after "Yes, manually approve edits" the dial read "Plan" at
   * idle until a reload, and a Terminal Shift+Tab left it stale on return.
   */
  const onScreen = (): boolean => props.onScreen !== false && props.textShown !== false;
  // Not while a pick from the dial is walking: its reply is the reading that
  // counts, and a read taken mid-walk could land after it.
  const rereadMode = (): void => {
    if (!untrack(modeBusy)) void readMode("");
  };
  createEffect(() => {
    if (onScreen()) rereadMode();
  });
  const turnOpen = createMemo(() => live() !== undefined);
  // And when the transcript's own mode moves. That is usually a new turn's
  // record, which the pane agrees with; but on opening it can be the window
  // arriving after the first read, carrying an old record that would
  // otherwise replace a fresher reading of the pane. Seen on the emulator on
  // 2026-09-27: "Manual" on the dial over a pane in Plan.
  createEffect(
    on(
      transcriptMode,
      () => {
        if (untrack(onScreen)) rereadMode();
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      turnOpen,
      () => {
        if (untrack(onScreen)) rereadMode();
      },
      { defer: true },
    ),
  );

  /**
   * The question the session is blocked on, if any.
   *
   * Derived from the transcript, which records the questions, their options and
   * their descriptions — so only the SELECTION is ever inferred, which is the
   * low-risk half of ADR-0010. The card is dismissed the moment the transcript
   * shows a result — whether it was answered from here or from the Terminal —
   * and equally the moment anything else happens after the question, since
   * Claude Code takes a dialog down when something claims the turn and leaves
   * that call unresolved for good (timeline.logic `markSuperseded`).
   */
  const recorded = createMemo(() => pendingQuestion(baseRows()));
  /**
   * What the PANE says, for the window where the record has not been written.
   *
   * Claude Code writes the AskUserQuestion record when it gets round to it:
   * measured 2026-08-28 over five consecutive calls in one session, two landed
   * within 3-8 s of the dialog appearing and two were not written until the
   * question was ANSWERED — 112 s later in one case. Through that window the
   * transcript says only "working" while the terminal sits blocked, so the
   * server reads the pane and reports what it finds (session-events
   * registry.watchPanes).
   */
  const fromPane = createMemo(() => askingFromPane(props.events));
  /** The tool permission prompt on the pane, answered by its own card. */
  const permission = createMemo(() => permissionFromPane(props.events));
  /** Press a permission row's number. */
  const pickPermission = async (n: number): Promise<boolean> => {
    const ok = (await props.onKeys?.([String(n)])) ?? false;
    if (!ok) props.notify?.("Couldn't answer Claude's prompt. Answer it in the Terminal.", "error");
    return ok;
  };
  /**
   * The watcher's current reading, as one comparable string.
   *
   * It answers one question only: has the watcher said anything NEW since a
   * reply was stored. The watcher appends a reading when the reading CHANGES,
   * so the content of the last one it reported is the whole of its identity —
   * there is no sequence number on the wire to use instead, and the event id
   * moves for reasons that have nothing to do with the dialog.
   *
   * THE TICKS ARE PART OF IT, and so is the free-text row. A multi-select
   * toggle leaves the question on screen, so after its first tick a reading
   * with one more box ticked has the same count, the same tally, the same
   * question and the same labels. Without the boxes in the key that reading
   * was no news, and a toggle whose reply could not read the screen kept its
   * capture up for the rest of the question (found in review, 2026-09-24).
   * Until the toggle change every multi-select click left the question, so
   * the next reading always differed somewhere else.
   */
  const paneKey = createMemo(() => {
    const p = fromPane();
    if (!p) return "";
    const q = p.questions[0];
    return JSON.stringify([
      p.count,
      p.answered,
      q?.header ?? "",
      q?.question ?? "",
      q?.options.map((o) => [o.label, o.checked === true]) ?? [],
      q?.typed ?? "",
      q?.typedChecked === true,
    ]);
  });
  /** The transcript wins wherever it has the call, for CONTENT: it carries
   *  every question of a multi-question call, the descriptions and the
   *  multi-select flags exactly as the tool was called, and the pane only what
   *  is drawn on it. What it no longer supplies is POSITION — which question of
   *  the call is on screen — because it does not know: the record is written
   *  once, and the reader is somewhere in the dialog by now. That comes from
   *  `view()` below, and ultimately from the pane. */
  const blocking = createMemo(() => recorded() ?? fromPane());
  const asked = createMemo(() => blocking()?.questions ?? []);
  /**
   * WHAT is being asked, as the call's CONTENT rather than the transcript's
   * tool id.
   *
   * A stored reply is stamped with it (`replied` below), so no reading
   * outlives the call it describes, and an empty one means nothing is asking.
   * Content is what lets a reply survive the HANDOVER. The same question
   * arrives first from the pane and then from the transcript, and the pane's
   * reading has no tool id at all. It does not key the card, because it
   * changes within a call (`callSerial` below).
   */
  const asking = createMemo(() =>
    asked()
      .map((q) => `${q.header}|${q.question}|${q.options.map((o) => o.label).join(",")}`)
      .join("~"),
  );
  /**
   * WHICH RECORD is being answered: the key of the transcript's question row,
   * or "" while only the pane describes the call.
   *
   * Content keys the card, for the handover above. It cannot tell a call
   * from the next one asking the same thing, and the record can, so every
   * stored reply carries both (`replied` below).
   */
  const callKey = createMemo(() => recorded()?.key ?? "");
  /**
   * WHICH CALL the card belongs to, as a count that moves only when a
   * different call takes over: something starts asking after nothing was, or
   * the record being answered gives way to another one. This, and not the
   * content above, keys the card.
   *
   * The card holds state that belongs to the call: the multi-select clicks
   * waiting behind a toggle in flight, the toggle itself, the half-typed
   * free-text words. Content changes WITHIN a call, and keying the card on it
   * built a new card at each change and dropped all of that. It changes at the
   * handover, because the pane's reading carries only the drawn question, and
   * with no header on a multi-question call, while the record carries every
   * question with its header. And it changes each time the watcher first
   * reports the next question of a call the record has not reached. The review
   * of 2026-09-24 found a click waiting when the record landed never sent, and
   * the new card, with no toggle of its own to wait on, working its first
   * click out against the record and unticking what the reply it was queued
   * behind had just ticked.
   *
   * What still separates two calls is the moment between them when nothing is
   * asking. A call's result, or anything else that happens in the session,
   * withdraws both the record's question and the watcher's reading. Two calls
   * whose records follow each other with no such moment are told apart by the
   * record. The same moment can fall inside a call the record has not reached,
   * when the watcher reads the pane mid-repaint and withdraws its reading until
   * the next tick, and the card built after it starts empty; `put` storing its
   * reply and ending the request together is what keeps that card's first
   * click honest. Within a call, the card's state is stamped with the question
   * it belongs to (QuestionCard), so nothing made for one question is spent on
   * another.
   */
  const callSerial = createMemo<{ n: number; asking: boolean; record: string }>(
    (was) => {
      const asks = asking() !== "";
      const record = asks ? callKey() : "";
      const another = asks && (!was.asking || (was.record !== "" && record !== was.record));
      return { n: another ? was.n + 1 : was.n, asking: asks, record };
    },
    { n: 0, asking: false, record: "" },
  );
  const [answering, setAnswering] = createSignal(false);

  /**
   * The newest reading the server sent back, and what was being asked when
   * it was sent.
   *
   * The same pairing the mode and model dials above use: a reading is stored
   * with the value it was taken against and stops counting the moment that
   * value moves, so nothing has to expire it. Here the value is `asking()`, so
   * a reply arriving after the session has moved to another call renders on
   * nothing. Content moves within a call too, and the exception below, for a
   * reply sent before the call had a record, is how a reply survives that.
   *
   * CONTENT IS NOT ENOUGH ON ITS OWN, so `call` stamps the record as well: the
   * key of the transcript's question row the reply was sent for, "" while
   * only the pane described the call. Two calls asking the same thing have
   * the same content key, and seen live on 2026-09-23 (CLI 2.1.280) the fifth
   * call of a session repeated the fourth and docked no card for over a
   * minute. The fourth call's last reply was its Submit's, `done` with no
   * dialog, and it still matched: the new call's record had withdrawn the
   * watcher's reading, so the watcher was back to saying nothing, as it had
   * been when that reply was stored. The new card drew that reply, a dialog
   * that had gone, and stayed empty until a reload.
   */
  const [replied, setReplied] = createSignal<{
    at: string;
    pane: string;
    call: string;
    resp: AnswerResponse;
  } | null>(null);
  const reading = createMemo((): AnswerResponse | null => {
    const r = replied();
    if (!r) return null;
    // A reply CARRYING NO DIALOG is a failure to read the screen, not a
    // reading of it, and it expires against the watcher.
    //
    // The driver polls for 600ms (answerVerify) and then answers with whatever
    // it has, so a capture taken mid-repaint comes back as a pane and no
    // dialog. That is the freshest thing there is at the time and the card
    // shows it — the design's "a screen we cannot read". But `replied` is
    // written in one place and never cleared, so preferring it for the life of
    // the call left the card sitting on a half-drawn capture while a perfectly
    // readable dialog was on the pane, with the Terminal the only way out.
    // Comparing the watcher's reading against the one current when the reply
    // landed is what ends it: a reading the watcher has ALREADY reported is
    // not new and cannot displace a capture taken milliseconds ago, and the
    // next tick that says something different does.
    //
    // A reply that DID read the screen keeps its precedence outright, for the
    // reason the comment below gives: it was captured milliseconds after the
    // keys went in and the watcher ticks every 2s.
    if (!r.resp.dialog && paneKey() !== r.pane) return null;
    if (r.at === asking() && r.call === callKey()) return r.resp;
    // A reply sent for one record is over once another record is asking, or
    // none is, whatever the two asked.
    if (r.call !== "") return null;
    // The HANDOVER is the exception, for a reply sent before the call had a
    // record. The same dialog arrives first from the pane and then from the
    // transcript, which changes both keys without changing what is on screen.
    // The pane's reading has no per-question header and the record does. A
    // reading whose drawn question is one of the call's own still describes
    // the call, so it survives that; anything else is a reading of a call
    // nobody is being asked any more.
    const q = r.resp.dialog?.questions?.[0];
    return q && placeQuestion(q, asked()) ? r.resp : null;
  });

  /**
   * WHAT THE CARD DRAWS: the question the pane is showing, with the call's own
   * content filled in.
   *
   * Two sources, and each supplies only what it actually knows.
   *
   * POSITION is the pane's wherever the pane has spoken. The reply wins
   * outright once there is one, including when it carries no dialog at all —
   * a screen the parser could not read, or a dialog that has gone — because
   * it was captured milliseconds after the keys went in, while the pane
   * watcher ticks every 2s (session-events registry PaneWatchInterval).
   * Preferring the older of the two is how a card ends up showing a question
   * that has already been answered. The one bound on that is in `reading()`
   * above: a reply that read NOTHING steps aside for a watcher reading taken
   * after it, so an unreadable capture cannot stand for the whole call.
   *
   * The TRANSCRIPT is the floor, and it has to be one. A watcher reading is
   * withdrawn the moment anything else happens in the session (timeline.logic
   * askingFromPane), the AskUserQuestion record IS something happening, and
   * the watcher only appends when the reading CHANGES — so between the record
   * landing and the reader's next answer there can be no pane reading at all,
   * indefinitely. With nothing to draw the card would render nothing and no
   * request could be made to get a reading, which is a dead end rather than a
   * delay. So the call's own questions stand in, at the first one, which is
   * what the CLI draws when a call opens.
   *
   * That is a starting point and never a prediction: every request names the
   * question it answers and the server refuses one the pane is not drawing,
   * replying with the real screen (sessionio/answerdrive.go). A reader who
   * arrives midway through a call therefore pays one refused tap, not a wrong
   * answer.
   *
   * CONTENT is the transcript's where it has it, merged in by
   * `withCallContent` below. The pane carries only what was drawn — no
   * per-question header on a multi-question dialog, and a description cut to
   * the width — and the header is what every request is addressed by, so that
   * merge is what makes a multi-question call answerable at all. Where the
   * transcript has nothing to merge yet, `callAddress` addresses the call by a
   * chip instead; the question keeps the empty header the pane gave it, so
   * nothing here claims a position it cannot see.
   */
  const view = createMemo((): QuestionDialogView | null => {
    const known = asked();
    const seen = ((): DialogView | undefined => {
      const r = reading();
      if (r) return r.dialog;
      const p = fromPane();
      if (p) {
        return {
          questions: p.questions,
          headers: p.headers,
          count: p.count,
          answered: p.answered,
          partial: p.partial,
        };
      }
      if (known.length === 0) return undefined;
      return {
        questions: known,
        headers: known.map((q) => q.header),
        count: known.length,
        answered: 0,
      };
    })();
    if (!seen) return null;
    return {
      ...withCallHeaders(seen, known),
      questions: drawnQuestions(seen).map((q) => withCallContent(q, known)),
    };
  });

  /**
   * The pane is on the CLI's review screen, where the only thing left is
   * Submit.
   *
   * The reply says so directly, because the server reads both wordings out of
   * the dialog's own region: "Review your answers" and "Ready to submit your
   * answers?" are ordinary English that a session discussing its own dialogs
   * puts on the pane — this feature's design doc quotes both — and matching
   * them anywhere in the capture turns a question into a Submit
   * (sessionio reviewOnScreen).
   *
   * Where it does not say so, the screen's own SHAPE does: the CLI's Submit
   * screen offers nothing to choose, and ParseDialog never returns a question
   * with an empty option list (it returns nil rather than a question with no
   * answers, dialog.go). So no options means the review screen whatever the
   * reply said about it — which is the case where `reviewOnScreen` read the
   * dialog's region and the parse fell back to the whole capture, and the two
   * disagreed. A `review` the pane does not agree with costs one refused
   * Submit and a fresh reading (answerdrive answerSubmit); the alternative is
   * a card with nothing to choose and no way to finish.
   *
   * NOT `answered` against `count`, which looks like the same question and is
   * not — measured 2026-09-10, a multi-select question's box fills on the
   * FIRST Space, before the Enter that leaves it, so a two-question call reads
   * as answered=2 while question 2 is still on screen.
   */
  const review = createMemo((): boolean => {
    if (reading()?.review === true) return true;
    const v = view();
    return !!v && v.questions.length > 0 && v.questions[0]!.options.length === 0;
  });

  // Pinch to size the transcript, the way a pinch sizes the terminal. The
  // arithmetic and the guards are ported from term.html so both views answer
  // the gesture identically; see mobile/textzoom.ts. The size is device-local,
  // and it is published as a scale the transcript zooms by rather than as a
  // font-size on one element: every font-size in app.css multiplies itself by
  // this, so the transcript, the answer card and the composer follow one pinch
  // together.
  /**
   * The agent panel, and which of its two forms fits.
   *
   * The margin needs 260px beside a readable column, so below RAIL_MIN_PX of
   * text view it becomes a one-line strip above the transcript instead. The
   * width is the TEXT VIEW's, not the window's: a workspace tile or the open
   * sidebar narrows it without the viewport changing, which is why this is an
   * observer and not a media query. A container query would have been the
   * CSS-only way, but `container-type` makes the view a containing block for
   * every fixed-position menu inside it (the composer's among them).
   */
  const agentSet = createMemo(() => props.agents?.() ?? null);
  const showAgents = createMemo(() =>
    panelPresent(agentSet()?.set, live() !== undefined, props.background?.(), props.tool?.()),
  );
  const [narrow, setNarrow] = createSignal(false);

  /**
   * The drill-in (design step 6): tapping an agent in the panel puts its own
   * transcript in the session's place, and Back or Escape puts the session's
   * back.
   *
   * VIEW STATE, NOT AN ADDRESS. The URL's hash is the session's own address,
   * rewritten in place as the selection moves and read once at startup
   * (lobby.logic `updateHash`, App `readInitialSelection`), and a session is
   * renamed under that address when its first prompt lands, so an agent
   * address inside it would have nothing stable to hang from. A reload
   * therefore comes back to the session, which is also where Back goes.
   *
   * The session's timeline stays mounted behind the drill-in, hidden, so Back
   * finds the reader where they left it, folds and all. The panel stays
   * beside it with the open agent marked, and the drill-in stays when the
   * panel goes: an agent that ends while someone reads it is still being read.
   */
  const [drill, setDrill] = createSignal<string | null>(null);
  /** The newest the set said about the open agent, kept once it leaves the set. */
  const drillInfo = createMemo<AgentInfo | undefined>((was) => {
    const id = drill();
    if (id === null) return undefined;
    return agentSet()?.set.agents.find((a) => a.id === id) ?? (was?.id === id ? was : undefined);
  });
  const drillRun = createMemo<WorkflowInfo | undefined>((was) => {
    const run = drillInfo()?.workflowId;
    if (!run) return undefined;
    return (
      agentSet()?.set.workflows.find((w) => w.id === run) ?? (was?.id === run ? was : undefined)
    );
  });
  /** Back to the session. From Back and Escape the focus returns to the entry
   *  that opened it; a find jump keeps the focus it put on its own row. */
  const closeDrill = (refocus: boolean): void => {
    const id = drill();
    setDrill(null);
    if (!refocus || id === null) return;
    const entry = [...(viewEl?.querySelectorAll<HTMLElement>("[data-agent]") ?? [])].find(
      (e) => e.dataset.agent === id,
    );
    // The strip folds its list away on a tap, so there the entry is gone and
    // the strip's own bar is the nearest thing to it.
    const opener =
      entry?.querySelector<HTMLButtonElement>("button.tl-agent-open") ??
      viewEl?.querySelector<HTMLButtonElement>("button.tl-agents-bar");
    opener?.focus({ preventScroll: true });
  };
  // Escape goes back from the view the keystrokes are going to (a workspace
  // shows several), and never from a field being typed into. A key some other
  // layer has claimed, an open file preview for one, is left to it.
  const tileFocused = useContext(TileFocusContext);
  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented || drill() === null) return;
      if (props.onScreen === false || !tileFocused() || !viewEl || viewEl.closest(".tl-hidden")) {
        return;
      }
      const t = e.target instanceof Element ? e.target : null;
      if (t && t !== document.body && !viewEl.contains(t)) return;
      if (isEditingTarget(t)) return;
      e.preventDefault();
      closeDrill(true);
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  const observeWidth = (el: HTMLDivElement): void => {
    if (typeof ResizeObserver !== "function") return; // older engines: the rail
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < RAIL_MIN_PX));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };

  const [textSize, setTextSize] = createSignal(loadTextSize());
  const [sizing, setSizing] = createSignal<number | null>(null);
  let viewEl: HTMLDivElement | undefined;
  onMount(() => {
    const stop = installTextZoom({
      // Whichever timeline is showing: the session's, or the drill-in's.
      surface: () => viewEl?.querySelector<HTMLElement>(".tl-timeline:not(.tl-hidden)") ?? null,
      get: textSize,
      set: (n) => {
        setTextSize(n);
        saveTextSize(n);
      },
      onReadout: setSizing,
    });
    onCleanup(stop);
  });
  // The composer's own handle, so "Chat about this" can hand the reader the
  // message field rather than an answer they did not want to give.
  let sinks: ComposerSinks | undefined;
  const focusComposer = () => sinks?.focus();
  /** The same handle as a signal, for what renders from it: the plan card
   *  offers "Approve with this feedback" only while the field holds text. */
  const [composerSinks, setComposerSinks] = createSignal<ComposerSinks>();

  /**
   * Put one request to the dialog and render whatever comes back.
   *
   * There is no plan here and nothing is predicted. The server answers the
   * question the pane is drawing and replies with a reading taken after it, so
   * the card renders the screen rather than a forecast of it. That is the
   * whole of the fix: over 10 days of field data the walk this replaces failed
   * 4 four-question answers in 5, and all six recorded failures were a
   * prediction that did not turn up
   * (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md).
   *
   * A REFUSAL IS NOT AN ERROR. `applied: false` — the reader tapped a question
   * the pane has moved past, or an option it no longer offers — comes back
   * with the current reading, and the card re-renders against it and carries
   * on. Nothing latches, and nobody is sent to the Terminal by it.
   */
  const put = async (req: AnswerRequest): Promise<AnswerResponse | null> => {
    if (!props.onAnswer || answering()) return null;
    // Stamped with the card that asked, taken BEFORE the await: a reply that
    // lands after the session has moved to another call describes neither, and
    // pairing it with the key it was sent under is what drops it.
    const at = asking();
    const call = callKey();
    setAnswering(true);
    let resp: AnswerResponse | null;
    try {
      resp = await props.onAnswer(req);
    } catch (err) {
      setAnswering(false);
      throw err;
    }
    if (!resp) {
      setAnswering(false);
      // The CALL failed — no reply, so there is nothing to render and no way
      // to know whether the keys landed. Deliberately not "nothing was typed":
      // a dropped reply cannot tell us that, and the next request re-reads the
      // pane anyway, as does the watcher within its 2s tick.
      props.notify?.("Couldn't reach the session to answer that.", "error");
      return null;
    }
    // `pane` is read HERE rather than next to `at`, so it is the watcher's
    // last word as of the reply landing. A tick that fired while the request
    // was in flight was captured before the keys went in, and counting it as
    // news would hand the card back the question that has just been answered.
    const pane = paneKey();
    // The reading and the end of the request land TOGETHER. Lowering
    // `answering` first ran every effect watching it inside that one write,
    // while the reading on screen was still the one from before the request.
    // The card's queue of multi-select clicks is such an effect, and a card
    // with no toggle of its own in flight worked its next click out against
    // that stale reading and asked the server to untick what the reply had
    // just ticked (found in review, 2026-09-24).
    batch(() => {
      setReplied({ at, pane, call, resp });
      setAnswering(false);
    });
    return resp;
  };

  /**
   * How a choice is addressed when the card cannot NAME the question on
   * screen: by the call, using one of the tab bar's own chips.
   *
   * This is the window before Claude Code writes the AskUserQuestion record —
   * measured 2026-08-28 over five consecutive calls, two records were not
   * written until after the question was answered, one of them 112 s later.
   * Through it the only thing describing the call is the tab bar, a
   * multi-question dialog draws no per-question header, and `capture-pane -p`
   * carries no colour to say which tab is current. So the question genuinely
   * cannot be named, and an empty header is refused outright
   * (answerdrive.go answerChoice) — every tap comes back not-drawn, forever,
   * on exactly the call shape the field data says fails most.
   *
   * A chip is a claim about the CALL and not about the position, and the
   * driver reads it as one: with no known question list it cannot place the
   * pane either, so `drawnHeader` answers drawnUnsure and the keys are planned
   * from the question the pane is DRAWING, with the option check standing in
   * for the placement (answerplan.go). Tapping "Tea" while the pane draws
   * "Pick a drink" therefore answers that question, whichever chip named the
   * call. Nothing here is marked current on the strength of it.
   *
   * Once the record lands the card names the question properly, so this only
   * ever fires in that window. If the SERVER has the record while the card
   * does not, it places the pane, finds the chip is a different question and
   * refuses with the current reading — one wasted tap, and the record reaches
   * the card on the same transcript within 200 ms.
   */
  const callAddress = (): string => view()?.headers?.find((h) => h.trim() !== "") ?? "";

  // One handler per thing the card can do. Each is one request and one fresh
  // reading; none of them works out what the next screen will say.
  // One label goes on the wire as `choice` and several as `choices`, which is
  // the shorthand the contract defines rather than two code paths: the server
  // reads a lone `choice` as a set of one (sessionio/answerapi.go). Keeping
  // the single-select spelling is what leaves every existing client, and this
  // package's own tests, sending exactly what they sent before. An EMPTY set
  // still goes as `choices: []`, which is how a toggle asks for a
  // multi-select with nothing ticked.
  //
  // `stay` is the multi-select toggle: apply the set and stay on the
  // question. Without it a multi-select request is the commit, and until
  // 2026-09-23 every click was one, so the first click left the question.
  const choiceRequest = (
    header: string,
    choices: string[],
    text?: string,
    stay?: boolean,
  ): AnswerRequest => ({
    header: header || callAddress(),
    ...(choices.length === 1 ? { choice: choices[0] } : { choices }),
    ...(text ? { text } : {}),
    ...(stay ? { stay: true } : {}),
  });
  const chooseOption = async (
    header: string,
    choices: string[],
    text?: string,
    stay?: boolean,
  ): Promise<void> => {
    await put(choiceRequest(header, choices, text, stay));
  };
  const toggleOptions = (header: string, choices: string[], text?: string): Promise<void> =>
    chooseOption(header, choices, text, true);
  const goBackTo = async (header: string): Promise<void> => {
    await put({ back: header });
  };
  const submitAnswers = async (): Promise<void> => {
    await put({ submit: true });
  };
  const pressKeys = async (keys: string[]): Promise<void> => {
    await put({ keys });
  };

  /** The docked card's way of turning typed words into an answer, while a card
   *  is docked. */
  let typedAnswer: ((words: string) => TypedAnswer | null) | undefined;

  /**
   * The composer's Send. With a question docked it ANSWERS the question with
   * what was typed, the way the card's own free-text field does.
   *
   * Reported 2026-09-26 (Viktor): he typed his answer into the message field
   * and pressed Send, and it went in as a prompt. A prompt is typed into the
   * pane and closed with Enter, and with the dialog up that Enter picked the
   * highlighted option and the words were lost. A person who types while being
   * asked something is answering it.
   *
   * The CLI's free-text row is a single line, so line breaks become spaces.
   * When the server finds no dialog on screen the question has gone and the
   * words go as the prompt they would otherwise have been. Any other refusal
   * keeps the words in the field (a false return) and says why.
   */
  /**
   * Bumped on each send that went in, so the timeline brings the reader back
   * to the latest message (MessagesTimeline's `follow`).
   */
  const [sends, setSends] = createSignal(0);
  const followed = (ok: boolean): boolean => {
    if (ok) setSends((n) => n + 1);
    return ok;
  };
  const send = async (text: string): Promise<boolean> => followed(await sendNow(text));
  const sendNow = async (text: string): Promise<boolean> => {
    // A permission prompt's menu takes keys, not a prompt: its Enter picks
    // the highlighted row, "Yes". The words stay in the field.
    if (permission()) {
      props.notify?.("Claude is asking to use a tool. Answer it from the card first.", "warning");
      return false;
    }
    if (!asking() || !props.onAnswer || !typedAnswer) return props.onSend(text);
    const words = text.replace(/\s*\n\s*/g, " ").trim();
    const answer = typedAnswer(words);
    if (!answer) {
      props.notify?.(
        review()
          ? "Claude's question is waiting on Submit. Submit it from the card first."
          : "The card can't read Claude's question. Answer it from the card or the Terminal.",
        "error",
      );
      return false;
    }
    if (answering()) {
      props.notify?.("Still sending the last answer. Send again in a moment.", "error");
      return false;
    }
    const resp = await put(choiceRequest(answer.header, answer.choices, answer.text));
    if (!resp) return false;
    if (resp.applied) return true;
    if (resp.reason === "no-dialog") return props.onSend(text);
    props.notify?.(
      resp.reason === "unverified"
        ? "Couldn't confirm your answer went in. Check the card before sending again."
        : "The question changed before your answer went in. Check the card and send again.",
      "error",
    );
    return false;
  };

  // ---- The plan approval ----
  //
  // docs/plans/2026-09-24-text-composer-redesign.md, "The plan-approval flow"
  // and "When the card docks, and what it shows". The card docks where the
  // question card docks; an option tap is one request, and the composer's
  // Send is the dialog's feedback row while the card is up.

  /** What the dock decision reads off the events: the pane's plan reading and
   *  the newest ExitPlanMode call (plan.logic). */
  const planFacts = createMemo(() => planDockFacts(props.events));
  /**
   * This client's plan answer, applied and not settled yet: the readings it
   * was sent against, the call it answered, and what the row says meanwhile.
   *
   * It ends when the transcript records the result, or for a clear context
   * when the old conversation's events go, which is the stream switching to
   * the new one; or after PLAN_SETTLE_MS, whichever comes first. Only this
   * client knows it answered, so other devices go straight from the pending
   * row to what the transcript says (open point 12).
   */
  const [planAnswered, setPlanAnswered] = createSignal<{
    keys: string[];
    toolId: string;
    action: PlanTransient;
  } | null>(null);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const endPlanAnswer = (): void => {
    clearTimeout(settleTimer);
    settleTimer = undefined;
    setPlanAnswered(null);
  };
  onCleanup(() => clearTimeout(settleTimer));
  /**
   * Whether the card docks. The answered keys are usually one reading, the
   * watcher's; after an `unknown-option` redraw the card was answering the
   * reply's reading, and the watcher may still be on the older one or catch up
   * to the newer, so neither re-docks while the answer settles.
   */
  const planDock = createMemo((): PlanDock => {
    if (!props.onAnswer) return { docked: false };
    const facts = planFacts();
    let dock = decidePlanDock(facts, null);
    for (const key of planAnswered()?.keys ?? []) {
      if (!dock.docked) break;
      dock = decidePlanDock(facts, { key, settling: true });
    }
    return dock;
  });
  const planDocked = createMemo(() => {
    const d = planDock();
    return d.docked ? d : null;
  });

  createEffect(() => {
    const a = planAnswered();
    if (!a || !a.toolId) return;
    const row = findPlanRow(baseRows(), a.toolId);
    // The call has gone from the transcript: the stream switched to the
    // conversation a clear context started.
    if (!row) {
      endPlanAnswer();
      return;
    }
    // A clear also shows over the rejection the old transcript records
    // (shownPlanOutcome), so only the switch or the clock ends it.
    if (a.action === "clear") return;
    const k = row.outcome.kind;
    if (k !== "pending" && k !== "superseded") endPlanAnswer();
  });

  const [planSending, setPlanSending] = createSignal<PlanSending | null>(null);
  /**
   * What the card says after the last reply, or after a press it ignored,
   * stamped with the watcher reading it was said against. `reading` is the
   * reply's own reading when it carried one, which the card draws instead of
   * the watcher's: an `unknown-option` reply is the screen after the refusal.
   */
  const [planReply, setPlanReply] = createSignal<{
    against: string;
    reading: PlanReading | null;
    notice: PlanNotice;
  } | null>(null);
  /** The reply, while the card it was said on is still up. The watcher
   *  catching up to the reply's own reading does not end it. */
  const planReplyNow = createMemo(() => {
    const d = planDocked();
    const r = planReply();
    if (!d || !r) return null;
    const k = planReadingKey(d.reading);
    return k === r.against || (r.reading && k === planReadingKey(r.reading)) ? r : null;
  });
  createEffect(() => {
    if (!planDocked()) setPlanReply(null);
  });
  /** The approve rows the card offers: the reply's reading where it has one. */
  const planCardReading = (): PlanReading | null => {
    const d = planDocked();
    if (!d) return null;
    const r = planReplyNow();
    if (!r) return d.reading;
    if (r.reading) return r.reading;
    return r.notice === "changed" ? null : d.reading;
  };
  /** The plan the card shows: the pending call's row, corrected for a plan
   *  file written in the same message (timeline.logic), or null while the
   *  transcript has no call for this dialog ("Loading the plan…"). */
  const planShown = createMemo((): { text: string | null; stale: boolean } => {
    const call = planDocked()?.call;
    const row = call ? findPlanRow(baseRows(), call) : undefined;
    return row ? { text: row.body, stale: row.stale === true } : { text: null, stale: false };
  });
  /** A notice for a press that was not sent, keeping any reading a reply left. */
  const sayOnPlanCard = (notice: PlanNotice): void => {
    const d = planDocked();
    if (!d) return;
    const r = planReplyNow();
    setPlanReply({
      against: r?.against ?? planReadingKey(d.reading),
      reading: r?.reading ?? null,
      notice,
    });
  };

  /**
   * Put one plan answer to the dialog. Applied, the card undocks at once and
   * the row shows `action` until the transcript catches up; refused, the card
   * says why from the reply and stays. Resolves undefined when nothing was
   * sent, null when the call failed.
   */
  const answerPlan = async (
    plan: PlanAnswer,
    sending: PlanSending,
    action: PlanTransient,
  ): Promise<AnswerResponse | null | undefined> => {
    const d = planDocked();
    if (!d || !props.onAnswer || planSending()) return undefined;
    const against = planReadingKey(d.reading);
    const shown = planCardReading();
    const keys = shown ? [against, planReadingKey(shown)] : [against];
    const toolId = d.call ?? "";
    batch(() => {
      setPlanSending(sending);
      setPlanReply(null);
    });
    let resp: AnswerResponse | null;
    try {
      resp = await props.onAnswer({ plan });
    } catch (err) {
      setPlanSending(null);
      throw err;
    }
    batch(() => {
      setPlanSending(null);
      const notice = planReplyNotice(resp);
      if (notice === null) {
        clearTimeout(settleTimer);
        setPlanAnswered({ keys, toolId, action });
        settleTimer = setTimeout(endPlanAnswer, PLAN_SETTLE_MS);
        // An approval leaves plan mode for the one its option names, and the
        // turn it starts writes no mode record, so the pane is what says where
        // it went. Without this the dial read "Plan" through a whole Bypass
        // turn (2026-09-26).
        if (action !== "feedback") void readMode(untrack(mode));
        return;
      }
      setPlanReply({ against, reading: planFromPane(resp?.dialog), notice });
    });
    return resp;
  };

  const approvePlanOption = (option: PlanOptionView): void => {
    void answerPlan(
      { option: option.number, label: option.label },
      { kind: "option", number: option.number },
      clearsContext(option.label) ? "clear" : "approve",
    );
  };

  /**
   * The composer's text as feedback on the plan: `approve: false` keeps
   * Claude planning (Send), `approve: true` approves with it (the card's
   * button). Resolves true only when the reply is applied, so the field keeps
   * the text otherwise.
   *
   * Once the card has said the plan is gone, the next Send goes out as the
   * prompt it would otherwise have been. An approval with feedback approves
   * through option 1 (feedbackClearsContext), so the row says what option 1
   * says it does, as the card's button did.
   */
  const sendPlanFeedback = async (text: string, approve: boolean): Promise<boolean> =>
    followed(await sendPlanFeedbackNow(text, approve));
  const sendPlanFeedbackNow = async (text: string, approve: boolean): Promise<boolean> => {
    if (!planDocked() || planReplyNow()?.notice === "gone") return props.onSend(text);
    if (planSending()) {
      sayOnPlanCard("busy");
      return false;
    }
    const f = planFeedback(text);
    if (f.text === "") return false;
    if (f.tooLong) {
      sayOnPlanCard("too-long");
      return false;
    }
    const action: PlanTransient = !approve
      ? "feedback"
      : feedbackClearsContext(planCardReading())
        ? "clear"
        : "approve";
    const resp = await answerPlan({ feedback: f.text, approve }, { kind: "feedback" }, action);
    return resp?.applied === true;
  };

  /**
   * What the composer's line is handed as the open turn. While the card is
   * docked it reads "Waiting for you" even before the transcript has the call,
   * when the transcript alone still says Claude is working. The wait's start
   * is not known then, so the line shows no clock rather than the turn's.
   */
  const lineLive = createMemo((): WorkingRow | undefined => {
    const l = live();
    if (!planDocked() || l?.waiting) return l;
    return {
      kind: "working",
      key: l?.key ?? "plan-dock",
      turnKey: l?.turnKey ?? "",
      steps: l?.steps ?? 0,
      waiting: true,
    };
  });

  // How full the context is, from the CLI's own `/context` reading — whenever
  // one is in the transcript, because somebody ran the command. Nothing injects
  // it and nothing here computes a context size: the ceiling is not on the wire
  // and is not a constant.
  const context = createMemo(() => contextState(props.events, props.sessionState));

  /**
   * What the session is answering as.
   *
   * Two sources, for the same reason the mode dial has two. The TRANSCRIPT is
   * authoritative and is what an arriving reader has, but it only moves when a
   * turn ends, so a change made from the model dial would not show until the
   * session next answered. The APPLY reports what the session said about
   * itself immediately afterwards, and that reading holds until the transcript
   * reports a pair of its own.
   *
   * A pi session has no transcript here, so its STAMP stands in for one: the
   * pair the lobby's pi extension writes on the pane whenever the model or the
   * level changes. An apply holds until the stamp moves, exactly as it would
   * wait for the transcript.
   */
  const transcriptModel = createMemo(
    () => currentModel(props.events, props.sessionState) ?? props.stampedModel,
  );
  const [appliedModel, setAppliedModel] = createSignal<{
    state: ModelState;
    against: string;
  } | null>(null);
  const modelState = createMemo((): ModelState | undefined => {
    const t = transcriptModel();
    const a = appliedModel();
    return a && a.against === modelKey(t) ? a.state : t;
  });
  const [modelBusy, setModelBusy] = createSignal(false);

  /**
   * Drive the session's picker, then say what it actually did.
   *
   * The reply is the session's own reading, not an echo: an effort change can
   * be refused without anything failing — an `env.CLAUDE_CODE_EFFORT_LEVEL` in
   * the account's settings pins one and the slider still moves — so a dial
   * that trusted the request would show a level the session is not on
   * (lib/model-api.ts).
   */
  const pickModel = (field: ModelField, id: string): void => {
    if (!props.onSetModel || modelBusy() || modelHeld()) return;
    const want = {
      model: field === "model" ? id : "",
      effort: field === "effort" ? id : "",
    };
    const against = modelKey(transcriptModel());
    setModelBusy(true);
    void props
      .onSetModel(want)
      .then((r) => {
        if (!r.ok) {
          props.notify?.(r.reason, "error");
          return;
        }
        // MERGED, not replaced. The reply carries only what the change could
        // establish: an effort pass reads the effort back off the pane and
        // says nothing about the model, because a stock Claude pane does not
        // report one. Replacing wholesale blanked half the dial until the
        // session next answered.
        const was = modelState();
        setAppliedModel({
          state: {
            model: r.state.model || was?.model,
            effort: r.state.effort || was?.effort,
          },
          against,
        });
        const got = field === "model" ? r.state.model : r.state.effort;
        const took =
          field === "model" ? isCurrentModel(props.harness ?? "claude", id, got) : got === id;
        if (got && !took) {
          props.notify?.(`The session stayed on ${got} — something on the box pins it`, "error");
        }
      })
      .finally(() => setModelBusy(false));
  };

  // The catalogue is files on disk; one read when the view opens is enough.
  // `readable` is held separately from the list because an empty list means two
  // different things and the menu has to be able to say which (store/catalogue.ts).
  const [commands, setCommands] = createSignal<SlashCommand[]>([]);
  const [catalogueOk, setCatalogueOk] = createSignal(true);
  createEffect(() => {
    if (!everShown()) return;
    void props.onCommands?.().then((c) => {
      setCommands(c.commands);
      setCatalogueOk(c.ok);
    });
  });

  /**
   * Whether a dialog is on the pane, which holds the mode dial, Shift+Tab and
   * the model dial: Shift+Tab is a key the dialog reads (on the plan's
   * feedback row it approves the plan), and `/model` would be typed into it.
   *
   * Four ways to know one is up. A question the card is answering, a
   * permission the panel is answering, the plan card, which docks from the
   * pane's reading before the transcript has the call, and the live row's
   * `waiting`, which is true while the transcript holds any of Claude's stops
   * without an answer.
   */
  const dialogUp = createMemo(
    (): boolean =>
      asking() !== "" ||
      props.pending.length > 0 ||
      live()?.waiting === true ||
      planDocked() !== null,
  );
  const modeHeld = (): string => (dialogUp() ? MODE_HELD_BY_DIALOG : "");
  /** The model dial is held for the same dialogs (MODEL_HELD_BY_DIALOG). */
  const modelHeld = (): string => (dialogUp() ? MODEL_HELD_BY_DIALOG : "");
  /** Modes the server has said this session does not offer. They stay out of
   *  reach until the view remounts, since launch flags do not change mid-run. */
  const [unavailable, setUnavailable] = createSignal<ReadonlySet<string>>(new Set());

  const cycleMode = () => {
    // Shift+Tab in the CLI cycles the permission mode. One press, then the pane
    // says where it landed — the transcript will not, until the next turn.
    // Never into a dialog, and never from a device that only watches.
    if (!props.onKeys || modeBusy() || modeHeld() || props.inertReason) return;
    setModeBusy(true);
    const was = mode();
    void props
      .onKeys(["BTab"])
      .then((ok) => (ok ? readMode(was) : undefined))
      .finally(() => setModeBusy(false));
  };

  /**
   * Put the session in a mode picked from the dial's list.
   *
   * One request: the server walks Shift+Tab and replies with the mode it read
   * at the end, whether or not the walk got there (lib/mode-api.ts). That
   * reading goes through the same `paneRead` signal as a read of the pane, so
   * the transcript still takes over once it reports a mode of its own. A
   * refusal says why through the toast stack, the way a model pick does.
   */
  const pickMode = (id: ModeId): void => {
    if (!props.onSetMode || modeBusy() || modeHeld() || props.inertReason || id === mode()) return;
    const was = mode();
    setModeBusy(true);
    void props
      .onSetMode(id)
      .then((r) => {
        if (!r.ok) {
          props.notify?.(r.reason, "error");
          return;
        }
        if (r.reply.mode) setPaneRead({ mode: r.reply.mode, against: transcriptMode() });
        if (r.reply.applied) return;
        if (r.reply.reason === "unavailable") setUnavailable((u) => new Set(u).add(id));
        const said = refusal(id, was, r.reply);
        props.notify?.(said.text, said.tone);
      })
      .finally(() => setModeBusy(false));
  };

  return (
    <div
      class="tl-textview"
      ref={viewEl}
      style={{ "--tl-text-scale": String(scaleFor(textSize())) }}
    >
      {/* What size the pinch has reached, while it is being made. */}
      <Show when={sizing() !== null}>
        <div class="tl-size-pill" role="status">
          Aa {sizing()}px
        </div>
      </Show>
      {/* The transcript and, beside it, the agent panel: the right margin of
          the reading column, or a strip above it when the view is narrow. */}
      <div
        class="tl-textview-body"
        classList={{ "tl-textview-body-strip": showAgents() && narrow() }}
        ref={observeWidth}
      >
        <MessagesTimeline
          opening={props.opening}
          owns={props.onScreen !== false}
          events={shown()}
          rows={shownRows()}
          onOpenPreview={props.onOpenPreview}
          onLoadFull={props.onLoadFull}
          onLoadEarlier={props.onLoadEarlier}
          hasEarlier={props.hasEarlier}
          onPinned={props.onPinned}
          pinned={props.pinned}
          follow={sends()}
          me={props.me}
          session={props.session}
          queued={queued()}
          planDocked={planDocked()?.call ?? null}
          planAnswer={(() => {
            const a = planAnswered();
            return a ? { toolId: a.toolId, action: a.action } : null;
          })()}
          hidden={drill() !== null}
          onReveal={() => closeDrill(false)}
        />
        <Show when={drill()} keyed>
          {(id) => (
            <AgentTranscript
              session={props.session ?? ""}
              agent={id}
              info={drillInfo()}
              run={drillRun()}
              skew={agentSet()?.skew ?? 0}
              parked={props.parked === true}
              onBack={() => closeDrill(true)}
              onOpenPreview={props.onOpenPreview}
              me={props.me}
              notify={props.notify}
            />
          )}
        </Show>
        <Show when={showAgents() ? agentSet() : null}>
          {(snap) => (
            <AgentPanel
              snapshot={snap()}
              form={narrow() ? "strip" : "rail"}
              // An agent's transcript is read through its session's routes.
              onOpen={props.session ? (id) => setDrill(id) : undefined}
              openId={drill()}
            />
          )}
        </Show>
      </div>
      {/* Docked, not inline: on a phone the timeline scrolls and the keyboard
          covers it, and a walk that slides out from under a thumb mid-answer is
          worse than no walk. The permanent record is the inline row, which
          appears the moment the transcript carries the result. */}
      {/* KEYED on the CALL (`callSerial`), which is how one call is told from
          the next. The card holds state of its own: a half-typed free-text
          answer, which row is being tapped, the multi-select clicks waiting
          their turn. Reusing it across two calls carried that over, and a
          fresh single question opened showing what had been chosen for
          something nobody was being asked any more.

          Not on the call's content, which this was keyed on until 2026-09-24.
          Content moves within a call, at the handover from the pane to the
          transcript and at each next question of a pane-read call, and every
          move built a new card, dropping the clicks waiting in the old one.

          The child MUST take an argument: Solid only calls a `keyed` child as a
          factory when its arity is above zero, and a zero-arg one is cached as a
          static child — which is the reuse this exists to prevent. */}
      <Show when={props.onAnswer && asking() ? callSerial().n : 0} keyed>
        {(_call) => (
          <QuestionCard
            dialog={view()}
            pane={reading()?.pane}
            review={review()}
            busy={answering()}
            onChoose={chooseOption}
            onToggle={toggleOptions}
            onBack={goBackTo}
            onSubmit={submitAnswers}
            onKeys={pressKeys}
            onChat={focusComposer}
            onTerminal={props.onOpenTerminal}
            register={(fn) => {
              typedAnswer = fn;
            }}
          />
        )}
      </Show>
      {/* The tool permission prompt docks there too, keyed on the reading so
          each prompt gets a card of its own (PermissionCard says why). */}
      <Show when={props.onKeys ? (permission()?.id ?? 0) : 0} keyed>
        {(_prompt) => {
          const reading = permission();
          return reading ? (
            <PermissionCard
              reading={reading}
              onPick={pickPermission}
              onTerminal={props.onOpenTerminal}
            />
          ) : null;
        }}
      </Show>
      {/* The plan approval docks in the same place. It holds no state of its
          own that belongs to one dialog, beyond whether the plan is shown in
          full, so it is not keyed. */}
      <Show when={planDocked()}>
        <PlanCard
          reading={planCardReading()}
          plan={planShown().text}
          stale={planShown().stale}
          hasInput={composerSinks()?.hasInput() ?? false}
          lineBreaks={composerSinks()?.lineBreaks() ?? false}
          sending={planSending()}
          notice={planReplyNow()?.notice ?? null}
          onApprove={approvePlanOption}
          onApproveWithFeedback={() => {
            void composerSinks()?.submitVia((text) => sendPlanFeedback(text, true));
          }}
          onTerminal={props.onOpenTerminal}
        />
      </Show>
      <Composer
        textSize={textSize()}
        // The open turn's row, which the thin line reads, and what the session
        // still owes once the transcript has closed the turn: an agent or a
        // workflow it launched keeps going and writes into this conversation
        // minutes later (the session list knows, the transcript does not).
        // The agent panel names the same work one entry at a time, so the line
        // leaves it out while the panel shows; on the panel's own signal, so
        // the two cannot disagree.
        live={lineLive()}
        background={showAgents() ? undefined : backgroundLabel(props.background?.())}
        // Send stays available while a question is docked, and answers it:
        // `send` types what is in the field as the question's free-text
        // answer, and only falls back to a prompt when the pane has no dialog
        // left. Send's label says so. `asking()` is the same signal the card
        // itself is keyed on, so the two cannot disagree.
        asking={!!asking()}
        planOpen={planDocked() !== null}
        onPlanFeedback={(text) => sendPlanFeedback(text, false)}
        planClearing={planAnswered()?.action === "clear"}
        pending={props.pending}
        onSend={send}
        onStop={props.onStop}
        onResolve={props.onResolve}
        sendToTerminal={props.sendToTerminal}
        history={history()}
        {...(props.onKeys ? { mode: mode(), onCycleMode: cycleMode } : {})}
        {...(props.onSetMode ? { onPickMode: pickMode } : {})}
        modeBusy={modeBusy()}
        modeHeld={modeHeld()}
        modelHeld={modelHeld()}
        modesUnavailable={unavailable()}
        onTakeControl={props.onTakeControl}
        {...(context() ? { context: context()! } : {})}
        {...(props.harness && props.onSetModel
          ? { harness: props.harness, onPickModel: pickModel, modelOffer: props.modelOffer }
          : {})}
        {...(modelState() ? { model: modelState()! } : {})}
        modelBusy={modelBusy()}
        onListDir={props.onListDir}
        commands={commands()}
        commandsOk={catalogueOk()}
        session={props.session}
        onAttach={props.onAttach}
        inertReason={props.inertReason}
        register={(api) => {
          sinks = api;
          setComposerSinks(api);
          props.register?.(api);
        }}
      />
    </div>
  );
};

/**
 * A reading's questions, in the shape the card's own types promise.
 *
 * THE WIRE IS LOOSER THAN THE TYPE. `sessionio.DialogQuestion.Options` is
 * tagged `json:"options"` with no omitempty, so a nil list marshals as
 * `"options": null` while `DialogQuestionView.options` is declared as an
 * array. That is not hypothetical: `reviewScreen` builds its pseudo-question
 * with no options at all, so every review screen already puts a null on the
 * wire today (sessionio/dialog.go). It goes unnoticed while `review` is true,
 * because every read of the list sits behind that flag in the card — and a
 * reply carrying the same dialog with `review` false, which is what a capture
 * the region parse could not read produces, reached `q.options.length` and
 * took the whole text view down with a TypeError mid-render.
 *
 * Repairing it here rather than at the parse is deliberate: this is the one
 * place a reply becomes something the card renders, and the card should not
 * have to hold an opinion about which fields the server omits.
 */
function drawnQuestions(d: DialogView): DialogQuestionView[] {
  const qs: DialogQuestionView[] | null | undefined = d.questions;
  if (!qs) return [];
  return qs.map((q) => {
    const options: DialogOptionView[] | null = q.options;
    return options ? q : { ...q, options: [] };
  });
}

/**
 * A review screen whose tab bar is off the top of the pane, with the call's
 * questions filled in.
 *
 * A review screen taller than the pane loses its tab bar, so the reading
 * carries the Submit screen and no headers (sessionio reviewFoot, found on an
 * 80x23 pane on 2026-09-27). The record still says which questions the call
 * asked. They count as answered: the review screen is one past the last
 * question, and the card only walks there by answering each one.
 */
function withCallHeaders(d: DialogView, known: Question[]): DialogView {
  if ((d.headers?.length ?? 0) > 0 || known.length === 0) return d;
  const qs = drawnQuestions(d);
  const onReview = qs.length > 0 && qs[0]!.options.length === 0;
  if (!onReview) return d;
  return { ...d, headers: known.map((q) => q.header), count: known.length, answered: known.length };
}

/**
 * One drawn question, with the call's own content filled in.
 *
 * The pane is the only honest source for WHICH question is on screen, and a
 * poor one for what the question SAYS: `capture-pane -p` carries what fitted
 * the width and no colour, so a multi-question dialog draws no per-question
 * header at all and a long description arrives cut. The transcript has the
 * call exactly as the tool was called. So the drawn question keeps its
 * identity and borrows the rest.
 *
 * The header matters most. Every request is addressed by it — the server
 * refuses one that names no question, which is what stops a stale client
 * answering the wrong one (sessionio/answerapi.go) — so without this merge a
 * multi-question call would not be answerable from here at all.
 *
 * THE WORDS ARE THE RECORD'S too, once it has placed the question. The pane
 * parses back less than the tool was called with whenever the CLI draws the
 * question in pieces. A blank line inside it reads as the question's top, so
 * only the last paragraph comes back (measured on CLI 2.1.280, 2026-09-24),
 * and a long one keeps its last twelve lines (dialog.go maxQuestionLines).
 * Until the first reply the card draws the record, whose words are whole, and
 * handing it the pane's after that changed the question under the reader. The
 * card took it for another question, dropped the click waiting behind the
 * first toggle, and scrolled back to the top. The reader gets the whole
 * question throughout instead.
 *
 * Nothing is invented: a question that cannot be placed is returned exactly as
 * it was drawn, and the reader still gets the screen and its options.
 */
function withCallContent(drawn: DialogQuestionView, known: Question[]): DialogQuestionView {
  const from = placeQuestion(drawn, known);
  if (!from) return drawn;
  return {
    ...drawn,
    question: from.question || drawn.question,
    header: drawn.header || from.header,
    multiSelect: drawn.multiSelect || from.multiSelect,
    options: drawn.options.map((o) => ({
      ...o,
      description: o.description || describedBy(from, o.label),
    })),
  };
}

/** What the call said about an option the pane drew, matched by label. */
function describedBy(q: Question, label: string): string {
  const want = label.trim().toLowerCase();
  return q.options.find((o) => o.label.trim().toLowerCase() === want)?.description ?? "";
}

/**
 * Which of the call's questions the pane is drawing, or undefined for "cannot
 * say".
 *
 * The TypeScript half of sessionio's `questionOnScreen`, and deliberately the
 * same rule: the header the dialog draws for itself when there is one, and
 * otherwise the question text matched against the call. Two matches are no
 * match — a call asking the same thing twice cannot be placed by its text, and
 * guessing between them is the failure this whole change exists to stop.
 *
 * It never reads the answered count. Measured 2026-09-10 against CLI 2.1.267,
 * a multi-select question's tab-bar box flips to ☒ on the FIRST Space, before
 * the Enter that leaves the question, so the tally runs one ahead of the
 * position, and using it as an index is how question 1's choice lands in
 * question 2.
 */
function placeQuestion(drawn: DialogQuestionView, known: Question[]): Question | undefined {
  const header = (drawn.header ?? "").trim().toLowerCase();
  if (header) {
    return onlyOne(known, (k) => k.header.trim().toLowerCase() === header);
  }
  return onlyOne(known, (k) => sameDrawnQuestion(drawn.question, k.question));
}

/** The single element that matches, or undefined when none or several do. */
function onlyOne<T>(xs: T[], is: (x: T) => boolean): T | undefined {
  const hits = xs.filter(is);
  return hits.length === 1 ? hits[0] : undefined;
}
