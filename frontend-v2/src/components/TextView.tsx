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
  permissionFromPane,
  type PermissionReading,
  currentMode,
  currentModel,
  deriveRows,
  liveRowOf,
  pendingQuestion,
  promptHistory,
  handedBack,
  queuedGhosts,
  queuedPrompts,
  withoutQueued,
  withPendingPrompts,
  planFromPane,
  type PendingPermission,
  type PlanReading,
  type PlanRow,
  type PlanTransient,
  type TimelineRow,
  type UserRow,
  type WorkingRow,
} from "./timeline.logic";
import { modeFromPane, type PendingPrompt, type SlashCommand } from "../logic/compose.logic";
import type { Catalogue } from "../store/catalogue";
import { contextState } from "./context.logic";
import {
  type AnswerRequest,
  type AnswerResponse,
  type PlanAnswer,
  type PlanOptionView,
} from "../lib/answer-api";
import type { Question } from "./canonicalize";
import { QuestionCard, type QuestionCardState } from "./QuestionCard";
import { heldCallsFromEvents } from "./question.logic";
import { PlanCard } from "./PlanCard";
import { PermissionCard, type OwnDraft } from "./PermissionCard";
import { permissionPreview, permissionPromptKey } from "./permission.logic";
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
import type { BrowserCardHost } from "./BrowserCard";
import { MessagesTimeline } from "./MessagesTimeline";
import { backgroundLabel } from "./lobby.logic";
import type { BackgroundWork, ClaudeState, SessionTool } from "../types/lobby";
import { AgentPanel } from "./AgentPanel";
import { AgentTranscript } from "./AgentTranscript";
import { panelPresent, type AgentSnapshot } from "./agents.logic";
import { TileFocusContext } from "../lib/ownwhile";
import { isEditingTarget } from "../keybindings/editing";
import { isCoarsePointer } from "../mobile/pointer";
import { trustDialogUp } from "../lib/first-prompt";
import { installTextZoom, loadTextSize, saveTextSize, scaleFor } from "../mobile/textzoom";
import { Composer, type ComposerSinks } from "./Composer";
import type { DraftAttachment } from "../store/drafts";
import { rememberSent, sentPictures } from "../store/sentPictures";
import { withSentPictures } from "../lib/attachments";
import type { StopResult } from "../store/session";
import {
  contextWindow,
  fillModel,
  isCurrentModel,
  modelName,
  codexModelFromPane,
  modelFromBanner,
  type ModelField,
  type ModelHarness,
  type ModelState,
  type PiOffer,
} from "../lib/models";
import type { SetModelResult } from "../lib/model-api";
import type { SetModeReply, SetModeResult } from "../lib/mode-api";
import { isDangerMode, modeHangsOnModel, modeTitle, type ModeId } from "../logic/modes";

/**
 * A model reading, as one comparable string.
 *
 * The applied reading holds only until the TRANSCRIPT moves, and this is how it
 * notices: the reading is stored alongside the transcript's value at the moment
 * it was taken, and it simply stops matching when a turn writes a new one. The
 * same trick the mode reading uses for the pane, and it needs no
 * bookkeeping to expire.
 */
const modelKey = (m: ModelState | undefined): string => `${m?.model ?? ""}/${m?.effort ?? ""}`;

/**
 * When to look at the pane after asking it to change, in ms. The CLI's status
 * line repainted 40ms after the keystroke when this was measured (2026-08-17);
 * the first delay is that with room to spare, the second is the retry.
 *
 * This is Shift+Tab's own read-back, and the last one left in this file. A
 * pick from the sheet's Mode list does not wait on the pane from here: the
 * server walks and reads in one local sequence and replies with the mode it
 * read (lib/mode-api.ts), and answering a dialog works the same way
 * (sessionio/answerdrive.go).
 */
const PANE_READ_DELAYS_MS = [150, 600];
/**
 * How often, and for how long, a Codex view with no model named reads the
 * pane again. Codex has no transcript here, so no turn opens or closes to
 * prompt a reading, and a view opened during codex's start-up dialogs read
 * "Model" until a reload (deployed review round 2 of the T3 pass, 2026-09-29).
 * Ten minutes covers a person reading those dialogs; the view coming back on
 * screen starts it again.
 */
const CODEX_MODEL_POLL_MS = 2_000;

/**
 * How often an open Claude session's pane is read for its permission mode.
 *
 * A mode changed from another device's Terminal, or by keys on the pane,
 * writes nothing to the transcript until the next prompt, and the view read
 * the pane only at moments of its own (deployed review round 6, 2026-09-30:
 * Bypass on the pane, Manual on the button 15 s later, and a pick of Manual
 * sent nothing). One read is a capture of a few KB; a view reads only while
 * it is on screen and the page is visible.
 */
const MODE_POLL_MS = 4_000;
const CODEX_MODEL_POLLS = 300;

/**
 * Why the mode cannot change while a dialog is on the pane.
 *
 * Shift+Tab is the only way the CLI changes mode, and inside a dialog it is a
 * key the dialog reads. On the plan approval's feedback row it APPROVES the
 * plan with whatever was typed (measured on CLI 2.1.281, memory #13896). What
 * it does in a question or a permission dialog was not measured, so those hold
 * the mode too, as a precaution (spec section 5.5).
 */
const MODE_HELD_BY_DIALOG =
  "Answer Claude first: a mode change now would type into the open dialog";
/** The same hold for a model pick: `/model` is typed into the pane too, and
 *  the server already refuses it while a question is up. */
const MODEL_HELD_BY_DIALOG =
  "Answer Claude first: a model change now would type into the open dialog";
/** And while the session is suspended: no Claude is running to drive the
 *  picker, and a Send is what wakes it (store/wake-send.ts). */
const MODEL_HELD_ASLEEP = "The session is asleep. Send a message to wake it, then change the model";

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
 * The model button already shows the mode the reply read, so these say why it is not
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
  model = "",
): { text: string; tone: "warning" | "error" } {
  const to = modeTitle(target);
  const now = modeTitle(reply.mode || was);
  switch (reply.reason) {
    case "unavailable":
      return {
        text: `${to} is not offered ${model ? `on ${model}` : "in this session"}, so it stayed on ${now}.`,
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
 * prototype's breakpoint: a 280px rail beside what is left still reads as a
 * column, and below it the panel folds into a strip above the transcript.
 */
const RAIL_MIN_PX = 900;

/**
 * How long a question the transcript shows waits for the lobby's hook to hold
 * it before the card says the Terminal is the place to answer. The hook fires as
 * the CLI draws its menu, usually before the record is written, so this only
 * runs out for a session whose Claude started before the hook was installed.
 */
const HOLD_GRACE_MS = 4_000;

/**
 * How long a send waits for a Stop that may hand text back (`sendNow`). The
 * server pops the queue (up to 1 s for the box to show it), interrupts, then
 * waits up to 1.5 s for the stopped prompt to land on the input line
 * (sessionio reclaimWait), so this covers both with room for the network. A
 * Stop that never answers does not hold the send past it.
 */
const STOP_HAND_BACK_WAIT_MS = 5_000;

/**
 * How close two prompt records are when the CLI ran them as one batch: the
 * prompts queued behind a turn, written 1 to 2 ms apart when it ends, the
 * window session-events reads a batch with too (sessionio batchWindow).
 */
const BATCH_MS = 1_000;

/**
 * How soon after a Stop puts its prompt back an Enter counts as typed without
 * seeing it (`landed`). Typing began 160 to 520 ms after the Stop in the round 7
 * replay, and Enter followed about a second later; 3 s leaves room for a
 * longer line typed as quickly.
 */
const FAST_ENTER_MS = 3_000;

/**
 * How soon after the stopped prompt comes back typing can begin and still be
 * typing that never saw it. The round 7 replay began typing 60 to 420 ms after
 * the prompt landed; reading a returned line and deciding to add to it takes
 * longer than that.
 */
const UNSEEN_TYPING_MS = 700;

/**
 * How long a card is up before its row digits press rows.
 *
 * Deployed review round 3 (2026-09-28): the card took the focus the moment it
 * docked over the empty field, and "4 more words" typed 30ms later pressed
 * row 4 (No) and lost the rest; a leading "2" would have granted a lasting
 * permission. A reader who means a row reads the card first, which takes
 * longer than this; a keystroke inside it was meant for the message.
 */
const CARD_KEYS_ARM_MS = 600;

/**
 * The same wait once a card has put the phone's keyboard away. Its rows sit
 * where the keys were, and a reader typing in flow keeps tapping for a moment
 * before looking up: deployed review round 4 (2026-09-29, Android emulator)
 * tapped the "e" key every 0.4 s, and the tap 647 ms after the keyboard went
 * pressed "Yes". Each tap swallowed in the wait starts it again.
 */
const CARD_KEYS_ARM_AFTER_KEYBOARD_MS = 1_000;

/** Keys that move the caret: pressing one means the reader is placing it in
 *  the text that is there. */
const CARET_KEYS = new Set([
  "Home",
  "End",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
]);

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
 * answers-dialogs-design.md). A pick from the sheet's Mode list works the same
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
  /** The session's hook-stamped state, from the session list (ADR-0001). The
   *  composer's Stop needs it to say `running` as well as the transcript. */
  claudeState?: () => ClaudeState | undefined;
  pending: PendingPermission[];
  /** resolves false when the session refused the prompt (the composer keeps it). */
  onSend: (text: string) => Promise<boolean>;
  /**
   * Interrupt the turn. Handed the prompts to take back when any are queued,
   * and the stopped turn's own prompt when Claude has written nothing for it
   * (store/session.ts `interrupt`). Resolves what came back: off Claude's
   * queue, and off the pane's input line, which is when the view puts each
   * back in the field.
   */
  onStop: (restoreQueue?: readonly string[], returnPrompt?: string) => Promise<StopResult> | void;
  onResolve: (reqId: string, decision: PermissionDecision) => void;
  /** Mobile: forward composed bytes to the live pty (bracketed paste + submit). */
  sendToTerminal?: (bytes: string) => void;
  /** open a file path in the preview overlay (transcript Read/Edit/Write rows). */
  onOpenPreview?: (path: string) => void;
  /** type keys into the session's pane: Shift+Tab in the message field. */
  onKeys?: (keys: string[]) => Promise<boolean>;
  /** put the session in a permission mode picked from the sheet's Mode list;
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
  /** Told what the conversation says the session is doing, for the header's
   *  subtitle: it moves with the transcript, where the session list's state
   *  waits for its next poll. Undefined while the view is not on screen or
   *  still opening. */
  onLiveState?: (s: "running" | "awaiting" | "done" | undefined) => void;
  /** The session's stream is parked while nobody reads it. An agent's
   *  transcript open in the drill-in parks with it. */
  parked?: boolean;
  /** The session's browser, for the Browser cards in the conversation.
   *  Absent, the conversation draws none. */
  browser?: BrowserCardHost;
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
  /** stop watching and drive the session from this device: the watching
   *  pill's Take control and a card head's, the same toggle as the header's
   *  Watch button. */
  onTakeControl?: () => void;
  /** receive the composer's sinks, for gestures that land outside it. */
  register?: (api: ComposerSinks) => void;
  /** The session is suspended (the session list's mark): the model button
   *  holds until a Send wakes it. */
  suspended?: () => boolean;
  /**
   * Nothing records this session's conversation here: a plain shell, or
   * Codex, which session-events does not register (its stream answers 404).
   * What is sent still goes to the pane and shows as a bubble, with no live
   * row under it that nothing would end, and a note says the replies are in
   * the Terminal view.
   */
  noTranscript?: "codex" | "shell";
  /** show the Terminal view — where a question the pane can only half show has
   *  to be answered until the transcript catches up. */
  onOpenTerminal?: () => void;
}> = (props) => {
  const queued = createMemo(() => queuedPrompts(props.events, props.sessionState));
  // What the transcript says, plus what it has not caught up with. A prompt
  // Claude has already queued is left out: the timeline draws it as a ghost
  // bubble at its end, and one message should show once (withoutQueued).
  const unrecorded = createMemo(() => withoutQueued(props.pendingPrompts?.() ?? [], queued()));
  /** The transcript folded, once. */
  const baseRows = createMemo(() => props.rows?.() ?? deriveRows(props.events));
  /**
   * The prose sent from here while the transcript's own turn is still open.
   * It waits behind that turn, so it is drawn as a ghost with the ones the
   * CLI has queued, not as a turn of its own: standing in as the next turn, it
   * made the running turn read as settled, its work group said "stopped" with
   * the command still running, and the live group moved onto the stand-in
   * (found live on 2026-09-27). A slash command keeps its stand-in turn, since
   * it may never be recorded at all.
   */
  const waitingHeld = createMemo(() =>
    baseRows().at(-1)?.kind === "working" ? unrecorded().filter((p) => !p.command) : [],
  );
  const sent = createMemo(() => {
    const waiting = waitingHeld();
    return waiting.length === 0 ? unrecorded() : unrecorded().filter((p) => !waiting.includes(p));
  });
  /** Every ghost at the conversation's end: Claude's queue, then what it has
   *  not recorded yet. */
  const ghosts = createMemo(() => {
    const waiting = waitingHeld();
    const fromQueue = queuedGhosts(queued(), props.pendingPrompts?.() ?? []);
    return waiting.length === 0 ? fromQueue : [...fromQueue, ...waiting.map((p) => p.text)];
  });
  const shown = createMemo(() => withPendingPrompts(props.events, sent()));
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
  // A session with no transcript here (`noTranscript`) never records what was
  // sent, so nothing would ever end the pending turn's live row: it counted
  // for as long as the view was open on a shell (deployed review round 1,
  // 2026-09-28). The bubbles stay; the live row does not.
  const live = createMemo(() =>
    props.noTranscript ? undefined : liveRowOf(shownRows(), baseRows(), sent()),
  );
  // Messages with a picture sent from here, so ↑ gives back the picture the
  // transcript calls `[Image #N]` (deployed review round 3, 2026-09-28).
  const [sentPics, setSentPics] = createSignal(props.session ? sentPictures(props.session) : []);
  const history = createMemo(() =>
    withSentPictures(promptHistory(props.events, props.sessionState), sentPics()),
  );
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
   * from the sheet's Mode list comes back with a reading of its own, the mode the
   * server's walk ended on, and is stored the same way. A pane reading holds
   * until the transcript reports a mode of its own, at which point the
   * transcript is the fresher of the two and takes over.
   */
  const transcriptMode = createMemo(() => currentMode(props.events, props.sessionState));
  // A pane reading, plus the transcript value it was taken against. It stops
  // counting the moment the transcript moves, with no bookkeeping: the reading
  // simply no longer matches what it was taken against.
  const [paneRead, setPaneRead] = createSignal({ mode: "", against: "" });
  /**
   * The model the pane's start-up banner names, for a session the transcript
   * has not named one for yet: Claude Code writes the model on its first reply,
   * and a fresh session's button read "Model" with nothing ticked until then
   * (found live on 2026-09-28). Read with the mode, and it stands only while
   * the transcript says nothing (transcriptModel).
   */
  const [bannerModel, setBannerModel] = createSignal<ModelState | undefined>();
  /**
   * Claude's folder-trust dialog is on the pane (lib/first-prompt.ts). No card
   * answers it, so a band above the composer says Claude is waiting on it and
   * offers the Terminal, and the header reads "waiting for you" (deployed
   * review round 5, 2026-09-29: the view read idle and empty, with the parked
   * prompt in the field and only a toast to explain). Read with the mode, and
   * gone once the transcript starts, which it cannot while the dialog is up.
   */
  const [trustOnPane, setTrustOnPane] = createSignal(false);
  const trustUp = (): boolean => trustOnPane() && props.events.length === 0;
  const mode = createMemo(() => {
    const t = transcriptMode();
    const p = paneRead();
    return (p.against === t ? p.mode : "") || t;
  });

  /**
   * Re-read the pane, twice when the first read still shows what was there
   * before. The status line repaints ~40ms after the keystroke (measured), so
   * one read is normally enough; the second covers a pane that was mid-repaint
   * at that instant rather than leaving the model button showing the old mode.
   */
  const readMode = async (was: string): Promise<void> => {
    for (const wait of PANE_READ_DELAYS_MS) {
      await new Promise((r) => setTimeout(r, wait));
      const pane = (await props.onPane?.())?.pane ?? "";
      if (props.harness === "claude") {
        const banner = modelFromBanner(pane);
        if (banner) setBannerModel(banner);
        setTrustOnPane(trustDialogUp(pane));
      } else if (props.harness === "codex") {
        const named = codexModelFromPane(pane);
        if (named) setBannerModel(named);
      }
      const seen = modeFromPane(pane);
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
  // Not while a pick from the sheet is walking: its reply is the reading that
  // counts, and a read taken mid-walk could land after it.
  const rereadMode = (): void => {
    if (!untrack(modeBusy)) void readMode("");
  };
  createEffect(() => {
    if (onScreen()) rereadMode();
  });
  // A mode changed from somewhere else: another device's Terminal, or keys on
  // the pane. The transcript does not move for it at idle, so the pane is read
  // on a clock while the view is on screen and the page is visible
  // (MODE_POLL_MS), and whenever the window gets the focus back, which is the
  // moment a reader returns from the other device.
  const [pageVisible, setPageVisible] = createSignal(document.visibilityState !== "hidden");
  onMount(() => {
    const seen = (): void => {
      const now = document.visibilityState !== "hidden";
      setPageVisible(now);
      if (now && onScreen()) rereadMode();
    };
    const focused = (): void => {
      if (onScreen()) rereadMode();
    };
    document.addEventListener("visibilitychange", seen);
    window.addEventListener("focus", focused);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", seen);
      window.removeEventListener("focus", focused);
    });
  });
  createEffect(() => {
    if (props.harness !== "claude" || !onScreen() || !pageVisible()) return;
    const timer = setInterval(rereadMode, MODE_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });
  // A Codex session names its model only on its pane (CODEX_MODEL_POLL_MS).
  // Reading is all this does: nothing is typed into the session.
  createEffect(() => {
    if (props.harness !== "codex" || !onScreen() || bannerModel()) return;
    let polls = 0;
    const timer = setInterval(() => {
      if (++polls > CODEX_MODEL_POLLS) clearInterval(timer);
      else rereadMode();
    }, CODEX_MODEL_POLL_MS);
    onCleanup(() => clearInterval(timer));
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
   * Two sources for one call. `held` is the question the lobby's hook is
   * holding for the card (ADR-0034); it is what makes the card answerable, and
   * it arrives before the transcript's record, which Claude Code sometimes
   * writes only once the question is answered (measured 2026-08-28, 112 s late
   * in one case). `recorded` is the transcript's call, which stands in for a
   * session whose question no hook is holding, so the reader still sees what is
   * being asked and where to answer it.
   */
  const recorded = createMemo(() => pendingQuestion(baseRows()));
  /** Every call the hook holds, oldest first. Claude asks several at once
   *  more often than not when it grills; the card answers the oldest, as the
   *  terminal does, and the next takes its place. */
  const heldCalls = createMemo(() => heldCallsFromEvents(props.events));
  const held = (): Question[] | null => heldCalls()[0] ?? null;
  const asked = createMemo((): Question[] => held() ?? recorded()?.questions ?? []);
  /** The call on show, named the way the server finds its hold. */
  const askedCall = (): string[] => asked().map((q) => q.question);
  /** WHAT is being asked, as the call's question texts; empty when nothing is. */
  const asking = createMemo(() =>
    asked()
      .map((q) => q.question)
      .join("\u0000"),
  );
  /**
   * WHICH CALL the card belongs to: a count that moves when something starts
   * asking after nothing was, or the call being asked changes. The card holds
   * the reader's drafts and keys on this, so one call's picks never carry
   * into the next, even when the next asks the same thing.
   */
  const callSerial = createMemo<{ n: number; asking: string }>(
    (was) => {
      const a = asking();
      return { n: a !== "" && a !== was.asking ? was.n + 1 : was.n, asking: a };
    },
    { n: 0, asking: "" },
  );
  const [answering, setAnswering] = createSignal(false);
  /** The server said nothing holds the question: the Terminal is the way. */
  const [notHeld, setNotHeld] = createSignal(false);
  /** A call with no hold yet gets a moment for the hold to arrive before the
   *  card sends the reader to the Terminal. */
  const [graceOver, setGraceOver] = createSignal(false);
  createEffect(
    on(
      () => callSerial().n,
      () => {
        setNotHeld(false);
        setGraceOver(false);
        const t = setTimeout(() => setGraceOver(true), HOLD_GRACE_MS);
        onCleanup(() => clearTimeout(t));
      },
    ),
  );
  const cardState = (): QuestionCardState =>
    held() && !notHeld() ? "open" : graceOver() || notHeld() ? "terminal" : "connecting";
  /** The tool permission prompt on the pane, answered by its own card. */
  const permission = createMemo(() => permissionFromPane(props.events));
  /**
   * Refuse a write while this device only watches, and say why.
   *
   * Watching is a read-only tmux attach on the client; the server takes a
   * prompt or an answer from any client. Found in review on 2026-09-27: with
   * the line reading "Watching", Enter sent the prompt, Send over a plan went
   * out as feedback, and the permission card answered the CLI's prompt. Every
   * way this view writes to the session goes through here first. The watching
   * pill hides the field, + and the round button since the T3 pass, which is
   * what the reader sees; this refusal stays the authority.
   */
  const refuseWatching = (): boolean => {
    const why = props.inertReason;
    if (!why) return false;
    props.notify?.(why, "info");
    return true;
  };
  /**
   * "Type your own answer" for the prompt on the pane, kept here rather than
   * in the card: the card is keyed on the reading, and a redraw of the same
   * prompt's rows (the decline driver's Tab, a resize) is a new reading
   * (permissionPromptKey says which prompt a reading is of).
   */
  let permOwn: { key: string; own: OwnDraft } | undefined;
  // Answered or gone, the prompt takes its words with it, so the same command
  // asked again later starts empty.
  createEffect(() => {
    if (!permission()) permOwn = undefined;
  });
  const permOwnFor = (reading: PermissionReading): OwnDraft | undefined => {
    const key = permissionPromptKey(reading);
    return permOwn?.key === key ? permOwn.own : undefined;
  };
  /** The docked permission card's press, for a row number typed on the
   *  keyboard (PermissionCard `register`). */
  let pressPermissionRow: ((row: number) => boolean) | undefined;
  /**
   * Pick a permission row. Where this view can answer, the row goes through
   * the answer route with its number and the label the reader saw, and the
   * server walks the cursor off the No row's open field before the digit
   * (sessionio permdrive.go permPick): with the cursor in that field a bare
   * digit is typed into it. Found in deployed review round 2 (2026-09-28),
   * after a failed typed decline left the field open and "1 Yes" made the row
   * read "No, 1". Without the answer route the digit goes as a key.
   */
  const pickPermission = async (n: number): Promise<boolean> => {
    if (refuseWatching()) return false;
    const label = permission()?.options.find((o) => o.number === n)?.label ?? "";
    let ok: boolean;
    let gone = false;
    if (props.onAnswer) {
      const resp = await props.onAnswer({ permission: { option: n, label } }).catch(() => null);
      ok = resp?.applied ?? false;
      gone = resp?.reason === "no-dialog" || resp?.reason === "not-drawn";
    } else {
      ok = (await props.onKeys?.([String(n)])) ?? false;
    }
    if (!ok) {
      props.notify?.(
        gone
          ? "Claude's prompt has already gone."
          : "Couldn't answer Claude's prompt. Answer it in the Terminal.",
        "error",
      );
    }
    return ok;
  };
  /**
   * Decline the permission prompt with the reader's words (the card's "Type
   * your own answer"). The server drives the prompt's No row and reads the
   * words back before its Enter (sessionio permdrive.go). The CLI's field is
   * one line, so line breaks go out as spaces, as plan feedback does.
   */
  const declinePermission = async (raw: string): Promise<boolean> => {
    if (refuseWatching() || !props.onAnswer) return false;
    const f = planFeedback(raw);
    if (f.text === "") return false;
    if (f.tooLong) {
      props.notify?.(
        "That answer is too long for Claude's prompt. Keep it under 2,000 characters.",
        "warning",
      );
      return false;
    }
    const resp = await props.onAnswer({ permission: { decline: f.text } }).catch(() => null);
    if (resp?.applied) return true;
    props.notify?.(
      resp?.reason === "no-dialog" || resp?.reason === "not-drawn"
        ? "Claude's prompt has already gone."
        : "Couldn't answer Claude's prompt. Answer it in the Terminal.",
      "error",
    );
    return false;
  };
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
   * The margin needs 280px beside a readable column, so below RAIL_MIN_PX of
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
  /** The same handle as a signal, for what acts on the field from outside it:
   *  Stop hands queued messages back into it. */
  const [composerSinks, setComposerSinks] = createSignal<ComposerSinks>();

  /**
   * The prompt a Stop would take back: the open turn's, while Claude has
   * written nothing for it. A Stop then puts it back on Claude Code's input
   * line and out of the conversation (CLI 2.1.283, measured 2026-09-28), so
   * the view names it to the server and hands it back to the field.
   *
   * It is the first prose sent between turns that the transcript has not
   * recorded yet, or else the transcript's own open turn when its prompt is all
   * it holds. `held` is the store's copy, which then does not also go back as
   * a queued prompt.
   *
   * Prompts queued behind a turn run as one batch when it ends, each its own
   * record written together, and a Stop puts every one back on the input line,
   * one per line (deployed review round 4, 2026-09-28). So the open turn's
   * prompt is the whole batch, oldest first, a blank line between each: the
   * user rows before the working row that the CLI wrote within BATCH_MS of
   * each other.
   *
   * `text` is what the server is told, and for a recorded prompt it is the
   * transcript's words: the CLI's input line and the record both hold
   * "[Image #N]" where a picture was. `back` is what the field gets, the
   * message as it was sent from here with its pictures' paths
   * (`withSentPictures`), which the field turns back into chips. Deployed
   * review round 2 of the T3 pass (2026-09-29): a Stop 1 to 2.5 s after
   * sending two pictures put the placeholders in the field and no pictures.
   */
  const stoppable = createMemo((): { text: string; back: string; held?: PendingPrompt } | null => {
    const early = sent().find((p) => !p.command);
    if (early) return { text: early.text, back: early.text, held: early };
    const rows = baseRows();
    if (rows.at(-1)?.kind !== "working") return null;
    const batch: UserRow[] = [];
    for (let i = rows.length - 2; i >= 0; i--) {
      const row = rows[i];
      if (row?.kind !== "user" || row.body.trim() === "") break;
      const next = batch[0];
      if (next && !(row.at !== undefined && next.at !== undefined && next.at - row.at < BATCH_MS))
        break;
      batch.unshift(row);
    }
    if (batch.length === 0) return null;
    const bodies = batch.map((r) => r.body);
    return {
      text: bodies.join("\n\n"),
      back: withSentPictures(bodies, sentPics()).join("\n\n"),
    };
  });

  /**
   * Stop, handing back what the interrupt would lose (the T3 pass, item 8).
   *
   * The ghosts' texts, and prose sent from here that the transcript never
   * recorded, go back as a draft (`handedBack`): oldest first, a blank line between
   * each, in front of whatever the field holds by then. Nothing is sent. They
   * go back only once the server says it took them off Claude's queue, since
   * CLI 2.1.283 runs every queued prompt as the next turn on an interrupt;
   * when the server could not, they run, and the field is left alone.
   *
   * The stopped turn's own prompt goes back first when Claude had written
   * nothing for it (`stoppable`), once the server says it took it off the
   * pane's input line; the stream's `rewound` marker then takes its bubble
   * away. A watching device does not stop the session at all.
   */
  const stopHandingBack = async (): Promise<void> => {
    if (props.inertReason) return;
    const stopped = stoppable();
    const held = (props.pendingPrompts?.() ?? []).filter((p) => p !== stopped?.held);
    const back = handedBack(queued(), held);
    const before = composerSinks()?.text() ?? "";
    const asking =
      back.length === 0 && !stopped
        ? props.onStop()
        : stopped
          ? props.onStop(back.length > 0 ? back : undefined, stopped.text)
          : props.onStop(back);
    // Every Stop holds the sends behind it, the ones with nothing to hand back
    // too: a prompt that reached the pane first would be the turn it stops.
    let done!: () => void;
    const settled = new Promise<void>((r) => (done = r));
    handingBack = settled;
    try {
      const got = await asking;
      if (!got) return;
      const text = [
        ...(got.returned && stopped ? [stopped.back] : []),
        ...(got.restored ? back : []),
      ];
      if (text.length === 0) return;
      waitingBack = [...waitingBack, text.join("\n\n")];
      landHandedBack(before);
    } finally {
      if (handingBack === settled) handingBack = null;
      done();
      focusAfterStop();
    }
  };

  /**
   * After a Stop, the field has the focus again on a desktop, so the next
   * message (or the words handed back) can be typed at once: the press on
   * Stop took it (deployed review rounds 3 to 5, 2026-09-28). Given only once
   * what came back has landed, so the focus says the reader came back to the
   * field and saw it (`land`). A phone keeps the keyboard it had: a finger's
   * press does not take the focus, and raising one would cover the
   * conversation.
   */
  const focusAfterStop = (): void => {
    if (isCoarsePointer() || props.onScreen === false) return;
    const active = document.activeElement;
    if (active && active !== document.body && !viewEl?.contains(active)) return;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;
    composerSinks()?.focus();
  };

  /**
   * A Stop still waiting on the server to hand text back, and the text it
   * handed back that has not gone into the field yet.
   *
   * Found in the round 7 check (2026-09-28). An Enter 300 ms after an early
   * Stop sent the new prompt while the server was still taking the stopped one
   * off the pane's input line, and the new one was lost; and text that came
   * back was glued in front of words typed meanwhile, so a quick Enter sent
   * the stopped prompt again, joined to them. So a send waits for the Stop
   * (`sendNow`, bounded by STOP_HAND_BACK_WAIT_MS), and what came back only
   * goes into a field that holds what it held at the Stop, or nothing. Words
   * typed meanwhile go out alone, and it follows them in.
   */
  let handingBack: Promise<void> | null = null;
  let waitingBack: string[] = [];
  let sendsWaiting = 0;
  const landHandedBack = (before: string): void => {
    const sinks = composerSinks();
    if (!sinks || waitingBack.length === 0 || sendsWaiting > 0) return;
    const now = sinks.text();
    if (now !== before && now.trim() !== "") {
      props.notify?.(
        "Stopped. Your earlier message comes back to the field once this one is sent.",
        "info",
      );
      return;
    }
    const text = waitingBack.join("\n\n");
    waitingBack = [];
    // Alone in the field, it is guarded against a quick Enter (`send`).
    landed = now.trim() === "" ? land(text) : null;
    sinks.prependText(text);
  };
  /**
   * What a Stop last put back into an empty field, when, and whether the
   * reader can still be typing without having seen it.
   *
   * The replay of the round 7 race (2026-09-28) had the prompt back 100 ms
   * after the Stop, before typing began 160 to 520 ms after it: the new words
   * went onto its end and Enter sent both as one prompt, 5 times in 12. An
   * Enter within FAST_ENTER_MS of it coming back, on a field that still starts
   * with it, sends only the words after it, and it stays in the field.
   *
   * Only while `unseen` holds. Deployed review round 1 (2026-09-28) added
   * " in French please" to the returned prompt and Enter sent the fragment
   * alone. That reader had come back to the prompt, and the field says so:
   * it did not have the focus as the prompt landed (a desktop Stop takes it),
   * or it was pressed, or the caret was moved, or typing began later than
   * UNSEEN_TYPING_MS. Any of those, and the field goes out as it reads.
   */
  let landed: { text: string; at: number; unseen: boolean; typedAt: number } | null = null;
  const composerFocused = (): boolean => {
    const active = document.activeElement;
    return (
      active instanceof HTMLTextAreaElement &&
      !!active.closest(".tl-composer") &&
      !!viewEl?.contains(active)
    );
  };
  const land = (text: string) => ({
    text,
    at: Date.now(),
    unseen: composerFocused(),
    typedAt: 0,
  });
  /** What the reader does in the field after a prompt came back says whether
   *  they saw it (`landed`). */
  const watchLanded = (e: globalThis.Event): void => {
    const back = landed;
    if (!back?.unseen) return;
    const t = e.target;
    if (!(t instanceof HTMLTextAreaElement) || !t.closest(".tl-composer")) return;
    if (e.type === "keydown") {
      if (e instanceof KeyboardEvent && CARET_KEYS.has(e.key)) back.unseen = false;
      return;
    }
    if (e.type === "input") {
      if (back.typedAt === 0) {
        back.typedAt = Date.now();
        if (back.typedAt - back.at > UNSEEN_TYPING_MS) back.unseen = false;
      }
      return;
    }
    // A press or a focus: the reader came to the field and the prompt in it.
    back.unseen = false;
  };
  onMount(() => {
    const el = viewEl;
    if (!el) return;
    const kinds = ["pointerdown", "mousedown", "touchstart", "focusin", "keydown", "input"];
    for (const k of kinds) el.addEventListener(k, watchLanded, true);
    onCleanup(() => {
      for (const k of kinds) el.removeEventListener(k, watchLanded, true);
    });
  });

  /**
   * Answer the held call, or decline it with "Chat about this", as data
   * (ADR-0034): the hook holding the question hands it to the CLI and nothing
   * is typed. Resolves true once the session has it; otherwise the card stays
   * as it was and a toast says why.
   */
  const answerHeld = async (req: AnswerRequest): Promise<boolean> => {
    if (!props.onAnswer || answering() || refuseWatching()) return false;
    setAnswering(true);
    let resp: AnswerResponse | null;
    try {
      resp = await props.onAnswer(req);
    } finally {
      setAnswering(false);
    }
    if (!resp) {
      props.notify?.("Couldn't reach the session to answer that.", "error");
      return false;
    }
    if (resp.applied) return followed(true);
    if (resp.reason === "not-held") {
      setNotHeld(true);
      props.notify?.(
        "The question is no longer waiting on this card. Answer it in the Terminal.",
        "error",
      );
    } else if (resp.reason === "incomplete") {
      props.notify?.("Every question needs an answer before it can be sent.", "error");
    }
    return false;
  };
  const submitAnswers = (answers: Record<string, string[]>): Promise<boolean> =>
    answerHeld({ call: askedCall(), answers });
  /** "Chat about this": decline the question and hand Claude the words typed
   *  in the card's own field. The composer is hidden behind the card, so its
   *  draft stays in it and goes nowhere. Only the call on show is declined;
   *  another asked with it stays for the card to answer next. */
  const chatInstead = (words: string): void => {
    void answerHeld({ call: askedCall(), chat: words });
  };

  /**
   * Bumped on each send that went in, so the timeline brings the reader back
   * to the latest message (MessagesTimeline's `follow`).
   */
  const [sends, setSends] = createSignal(0);
  const followed = (ok: boolean): boolean => {
    if (ok) setSends((n) => n + 1);
    return ok;
  };
  const send = async (text: string): Promise<boolean> => {
    const back = landed;
    landed = null;
    if (
      back?.unseen &&
      Date.now() - back.at < FAST_ENTER_MS &&
      text.startsWith(back.text) &&
      text.slice(back.text.length).trim() !== ""
    ) {
      const own = followed(await sendNow(text.slice(back.text.length).trim()));
      // The field was emptied for the send; the prompt goes back into it.
      if (own) {
        landed = land(back.text);
        composerSinks()?.prependText(back.text);
        props.notify?.("Sent what you typed. The stopped message stays in the field.", "info");
      }
      return own;
    }
    const ok = followed(await sendNow(text));
    if (ok && props.session) {
      rememberSent(props.session, text);
      setSentPics(sentPictures(props.session));
    }
    // What a Stop handed back while these words were being written follows
    // them into the field (`landHandedBack`).
    if (ok) landHandedBack("");
    return ok;
  };
  const sendNow = async (text: string): Promise<boolean> => {
    if (refuseWatching()) return false;
    const stopping = handingBack;
    if (stopping) {
      sendsWaiting++;
      try {
        await Promise.race([
          stopping,
          new Promise<void>((r) => setTimeout(r, STOP_HAND_BACK_WAIT_MS)),
        ]);
      } finally {
        sendsWaiting--;
      }
    }
    // A permission prompt's menu takes keys, not a prompt: its Enter picks
    // the highlighted row, "Yes". The words stay in the field.
    if (permission()) {
      props.notify?.("Claude is asking to use a tool. Answer it from the card first.", "warning");
      return false;
    }
    // A question's free-text answer is the card's own field since the T3
    // pass (reported 2026-09-26: an answer typed in the message field went in
    // as a prompt). The composer is hidden behind the card, so a send that
    // still reaches here keeps its words rather than taking the dialog down.
    if (asking() && props.onAnswer) {
      props.notify?.(
        cardState() === "terminal"
          ? "Claude's question can only be answered in the Terminal right now."
          : "Claude is asking a question. Answer it from the card first.",
        "warning",
      );
      return false;
    }
    // The plan's feedback is the card's own field since the T3 pass. A prompt
    // typed at the pane now would land in the open plan menu (memory #13896),
    // so a send that still reaches here keeps its words.
    if (planUp()) {
      props.notify?.("Claude's plan is waiting. Answer it from the card first.", "warning");
      return false;
    }
    return props.onSend(text);
  };

  // ---- The plan approval ----
  //
  // docs/plans/2026-09-24-text-composer-redesign.md, "The plan-approval flow"
  // and "When the card docks, and what it shows". The card takes the
  // composer's place; an option tap is one request, and the card's own "Tell
  // Claude what to change" field is the dialog's feedback row (the T3 pass).

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
    if (!d || !props.onAnswer || planSending() || refuseWatching()) return undefined;
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
   * The card's words as feedback on the plan: `approve: false` keeps Claude
   * planning (the field's Send), `approve: true` approves with them ("Approve
   * with this feedback"). Resolves true only when the reply is applied, so the
   * card keeps the words otherwise.
   *
   * When the reply says the plan has gone, the words move into the composer,
   * which comes back in the card's place, so the next Send goes out as the
   * prompt they would otherwise have been; the card lets go of them. An
   * approval with feedback approves through option 1 (feedbackClearsContext),
   * so the row says what option 1 says it does, as the card's button does.
   */
  const sendPlanFeedback = async (text: string, approve: boolean): Promise<boolean> => {
    if (followed(await sendPlanFeedbackNow(text, approve))) return true;
    if (planReplyNow()?.notice !== "gone") return false;
    composerSinks()?.prependText(text);
    return true;
  };
  const sendPlanFeedbackNow = async (text: string, approve: boolean): Promise<boolean> => {
    if (refuseWatching()) return false;
    if (!planDocked() || planReplyNow()?.notice === "gone") return false;
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
   * The open turn as the live group and the composer are handed it. While the
   * card is docked it reads "Waiting for you" even before the transcript has
   * the call, when the transcript alone still says Claude is working. The
   * wait's start is not known then, so the live group shows no clock rather
   * than the turn's.
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

  /**
   * What the session is answering as.
   *
   * Two sources, for the same reason the mode has two. The TRANSCRIPT is
   * authoritative and is what an arriving reader has, but it only moves when a
   * turn ends, so a change made from the model sheet would not show until the
   * session next answered. The APPLY reports what the session said about
   * itself immediately afterwards, and that reading holds until the transcript
   * reports a pair of its own.
   *
   * A pi session has no transcript here, so its STAMP stands in for one: the
   * pair the lobby's pi extension writes on the pane whenever the model or the
   * level changes. An apply holds until the stamp moves, exactly as it would
   * wait for the transcript.
   */
  const transcriptModel = createMemo(() =>
    fillModel(currentModel(props.events, props.sessionState), props.stampedModel, bannerModel()),
  );
  // The sheet's context line: a /context reading, or the last turn's usage
  // over the window measured for the model the session answers as.
  const context = createMemo(() => {
    const model = transcriptModel()?.model;
    const window = contextWindow(model);
    return contextState(props.events, props.sessionState, {
      ...(model ? { model } : {}),
      ...(window ? { window } : {}),
    });
  });
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
   * the account's settings pins one and the slider still moves — so a button
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
        // report one. Replacing wholesale blanked half the model button until the
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
          props.notify?.(`The session stayed on ${got}. Something on the box pins it`, "error");
        }
        // A switch can move the mode too: Claude Code drops Auto to Manual on
        // a model that does not offer it (Haiku 4.5, deployed review round 4,
        // 2026-09-29), and the button kept saying Auto until a reload.
        void readMode(untrack(mode));
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
   * Whether a dialog is on the pane, which holds a mode pick, Shift+Tab and
   * a model pick: Shift+Tab is a key the dialog reads (on the plan's
   * feedback row it approves the plan), and `/model` would be typed into it.
   *
   * Five ways to know one is up. A question the card is answering, the tool
   * permission prompt its card is answering (a `/model` would land in its
   * menu), a permission the hook-fed panel is answering, the plan card, which
   * docks from the pane's reading before the transcript has the call, and the
   * live row's `waiting`, which is true while the transcript holds any of
   * Claude's stops without an answer.
   */
  const dialogUp = createMemo(
    (): boolean =>
      asking() !== "" ||
      permission() !== null ||
      props.pending.length > 0 ||
      live()?.waiting === true ||
      planDocked() !== null,
  );
  const modeHeld = (): string => (dialogUp() ? MODE_HELD_BY_DIALOG : "");
  /** A model pick is held for the same dialogs (MODEL_HELD_BY_DIALOG). */
  const modelHeld = (): string =>
    dialogUp() ? MODEL_HELD_BY_DIALOG : props.suspended?.() ? MODEL_HELD_ASLEEP : "";
  /**
   * Modes the server has said the session does not offer, and the model it
   * was on when it said so. Launch flags do not change mid-run, but the model
   * does, and whether Auto is offered depends on it: deployed review round 6
   * (2026-09-30) refused Auto on Haiku 4.5, and the row stayed greyed out after
   * the switch back to Opus 5.5, which offers it, until a reload. So the set
   * holds only while the session is on the model it was refused on.
   */
  const [refused, setRefused] = createSignal<{ model: string; modes: ReadonlySet<string> }>({
    model: "",
    modes: new Set(),
  });
  const currentModelId = (): string => modelState()?.model ?? "";
  /** The model's name when it is what decides whether `id` is offered. */
  const modelOffering = (id: ModeId): string => {
    const m = currentModelId();
    return modeHangsOnModel(id) && m && props.harness ? modelName(props.harness, m) : "";
  };
  const unavailable = createMemo((): ReadonlySet<string> => {
    const r = refused();
    return r.model === currentModelId() ? r.modes : new Set();
  });

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
   * Put the session in a mode picked from the sheet's Mode list.
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
        if (r.reply.reason === "unavailable") {
          const model = currentModelId();
          setRefused((u) => ({
            model,
            modes: new Set(u.model === model ? u.modes : []).add(id),
          }));
        }
        const said = refusal(id, was, r.reply, modelOffering(id));
        props.notify?.(said.text, said.tone);
      })
      .finally(() => setModeBusy(false));
  };

  // ---- The bottom slot ----
  //
  // One slot holds either the composer or the card Claude is waiting on (the
  // T3 pass, "Regions and who owns them"). The composer stays MOUNTED behind a
  // card, hidden: its draft, its attachments and the sinks registered with the
  // session view keep working, and the reader finds the field as they left it
  // once the card goes.
  const questionUp = (): boolean => !!props.onAnswer && asking() !== "";
  const permissionUp = (): boolean => !!props.onKeys && permission() !== null;
  /** A plan card that has said the plan is gone has nothing left to answer, and
   *  the field is where the next prompt goes, so the composer comes back. */
  const planUp = (): boolean => planDocked() !== null && planReplyNow()?.notice !== "gone";
  const composerHidden = createMemo(() => questionUp() || permissionUp() || planUp());
  /**
   * A card docked while the reader was typing in the field, and the field
   * still has the focus: the composer stops drawing but stays in the page,
   * out of sight, so the rest of the sentence lands in the message.
   *
   * Deployed review round 1 (2026-09-28): the card docked at the ninth
   * character of a sentence typed at 200 ms a key, the field hid, the focus
   * fell to the page and the other 130 characters were lost with no notice.
   * Read when the card docks, before the field would hide; it ends when the
   * focus leaves the field (`releaseTyping`) or the card goes. A digit typed
   * into a field with words in it is typing, so no row is pressed.
   */
  const [typingReleased, releaseTyping] = createSignal(0);
  /** Bumped when typing starts on the card itself (`typeBehind`). */
  const [typedOnCard, typeOnCard] = createSignal(0);
  const behind = createMemo<{ on: boolean; gen: number; typed: number }>(
    (prev) => {
      const up = composerHidden();
      const gen = typingReleased();
      const typed = typedOnCard();
      if (!up) return { on: false, gen, typed };
      if (prev.on) return { on: gen === prev.gen, gen: prev.gen, typed };
      if (typed !== prev.typed) return { on: true, gen, typed };
      // Not on a phone: there the field lets go of the focus as the card
      // docks (`letGoOnPhone`), or its keyboard covers the card.
      return {
        on:
          !isCoarsePointer() && composerFocused() && (composerSinks()?.text() ?? "").trim() !== "",
        gen,
        typed,
      };
    },
    { on: false, gen: 0, typed: 0 },
  );
  const typingBehind = (): boolean => behind().on;
  createEffect(
    on(typingBehind, (now, was) => {
      if (now && !was) {
        props.notify?.(
          "Claude needs an answer. What you type stays in your message for after.",
          "info",
        );
      }
    }),
  );
  onMount(() => {
    const el = viewEl;
    if (!el) return;
    const out = (e: FocusEvent): void => {
      const t = e.target;
      if (!typingBehind() || !(t instanceof HTMLTextAreaElement) || !t.closest(".tl-composer")) {
        return;
      }
      releaseTyping((n) => n + 1);
    };
    el.addEventListener("focusout", out, true);
    onCleanup(() => el.removeEventListener("focusout", out, true));
  });
  const cardUp = createMemo(() => questionUp() || permissionUp() || planDocked() !== null);

  // The header's subtitle follows the conversation while it is on screen: a
  // card that docks says "waiting for you" at once, where the session list's
  // state lagged it by a poll (found live on 2026-09-27).
  createEffect(() => {
    const tell = props.onLiveState;
    if (!tell) return;
    if (props.textShown === false || props.onScreen === false) {
      tell(undefined);
      return;
    }
    // The trust dialog comes before any transcript, so it is said while the
    // conversation is still opening, which it can stay for a session with
    // none.
    if (trustUp()) {
      tell("awaiting");
      return;
    }
    if (props.opening) {
      tell(undefined);
      return;
    }
    const l = lineLive();
    tell(cardUp() || l?.waiting ? "awaiting" : l ? "running" : "done");
  });
  onCleanup(() => props.onLiveState?.(undefined));

  // ---- following: the "Latest" band ------------------------------------------
  // Each timeline says whether its reader is at the live end, and hands over
  // the call that takes them there. The drill-in's own timeline answers while
  // it is on screen; it mounts at the end, so it starts true.
  const [atEnd, setAtEnd] = createSignal(true);
  const [drillAtEnd, setDrillAtEnd] = createSignal(true);
  let toEnd: (() => void) | undefined;
  let drillToEnd: (() => void) | undefined;
  const latestShown = createMemo(() => !cardUp() && !(drill() !== null ? drillAtEnd() : atEnd()));
  /** Claude is working: the live group at the end reads the same row. */
  const latestWorking = (): boolean => {
    const l = lineLive();
    return !!l && !l.waiting;
  };

  /** Whether a key from this target is this view's to act on: the view is on
   *  screen and the one being typed into, and the focus is inside it on
   *  something that does not take text. */
  const keyInView = (t: EventTarget | null): boolean =>
    props.onScreen !== false &&
    tileFocused() &&
    !!viewEl &&
    !viewEl.closest(".tl-hidden") &&
    t instanceof Element &&
    viewEl.contains(t) &&
    !isEditingTarget(t);

  // A permission row's digit, pressed while the field is hidden (a62e8220 did
  // this from the empty field, which the card now hides). Only from inside the
  // view: the rest of a sentence being typed when the card docked lands on the
  // page's body, and "fix the 2 tests" must not allow anything.
  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!keyInView(e.target)) return;
      const digit = /^[1-9]$/.test(e.key);
      if (digit && permissionUp() && cardKeysArmed()) {
        if (pressPermissionRow?.(Number(e.key))) e.preventDefault();
        return;
      }
      // A row digit on an armed question or plan card is the card's
      // (QuestionCard, PlanCard).
      if (digit && (questionUp() || planUp()) && cardKeysArmed()) return;
      if (typeBehind(e)) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  /**
   * A character typed on the focused card goes into the message behind it,
   * and the field takes the rest, out of sight, the way words typed while a
   * card docks already do. Letters used to go nowhere, with no notice, and a
   * digit before the rows arm is typing too (deployed review round 3,
   * 2026-09-28). Only on the card itself: a row or a link with the focus keeps
   * its own keys, Space included. True when it took the key.
   *
   * A space is typing once there are words for it to follow. On a phone the
   * focus stays on the card, so every key of the sentence comes here, and
   * dropping spaces sent back "keeptypingwhilethecardarrives" (deployed
   * review round 6, 2026-09-30). A space on a card over an empty field is
   * left alone.
   */
  const typeBehind = (e: KeyboardEvent): boolean => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.classList.contains("tl-qcard")) return false;
    if (e.key.length !== 1 || props.inertReason) return false;
    const sinks = composerSinks();
    if (!sinks || !cardUp()) return false;
    if (e.key === " " && sinks.text() === "") return false;
    // Not into the field's focus on a phone: that raises the keyboard the
    // card has just put away, over its lower rows. The key came from that
    // keyboard as it slid away (deployed review round 4, 2026-09-29), and any
    // after it land on the card and come here the same way.
    const phone = isCoarsePointer();
    sinks.insertText(e.key, { focus: !phone });
    typeOnCard((n) => n + 1);
    if (!phone) sinks.focus();
    return true;
  };

  // A card that docks while nothing has the focus takes it, so its keys work at
  // once. So does one that docks over the EMPTY field the reader just sent
  // from: the card hides that field, and the focus would fall to the page,
  // where the row digits are not the view's (found live on 2026-09-27). A
  // reader who was typing keeps theirs where it was: the field hides, and
  // their next keys land on the page rather than on the card's rows.
  const emptyField = (el: Element): boolean =>
    el instanceof HTMLTextAreaElement && !!el.closest(".tl-composer") && el.value === "";
  const [cardKeysArmed, setCardKeysArmed] = createSignal(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  /** This card put the phone's keyboard away as it docked. */
  let tookKeyboard = false;
  /** Disarm the card's keys and arm them a wait from now: CARD_KEYS_ARM_MS,
   *  or CARD_KEYS_ARM_AFTER_KEYBOARD_MS once the card took the keyboard. */
  const armCardKeys = (): void => {
    clearTimeout(armTimer);
    setCardKeysArmed(false);
    const wait = tookKeyboard ? CARD_KEYS_ARM_AFTER_KEYBOARD_MS : CARD_KEYS_ARM_MS;
    armTimer = setTimeout(() => setCardKeysArmed(true), wait);
  };
  createEffect(
    on(cardUp, (up) => {
      clearTimeout(armTimer);
      setCardKeysArmed(false);
      if (!up) tookKeyboard = false;
      if (up) armCardKeys();
    }),
  );
  onCleanup(() => clearTimeout(armTimer));
  /**
   * On a phone, a card that docks while the field has the focus takes it off
   * the field, which puts the keyboard away. The draft stays in the field,
   * which stays mounted, and comes back with it once the card goes.
   *
   * Deployed review round 3 of the T3 pass (2026-09-29, Android emulator):
   * the field kept the focus behind the card, as it does on a desktop
   * (`behind`), so the keyboard stayed up. The card got the 471px above it,
   * its No row and "Type your own answer" were scrolled out of sight, and a
   * "1" typed next went into the field nobody could see.
   *
   * The card's rows land where the keys were, so its keys and taps arm only
   * once the keyboard has finished going and the taps meant for it have
   * stopped: each step of the viewport growing back, and each tap swallowed,
   * starts CARD_KEYS_ARM_AFTER_KEYBOARD_MS again (`tapTooSoon`).
   */
  createEffect(
    on(composerHidden, (up) => {
      if (!up || !isCoarsePointer() || !composerFocused()) return;
      const draft = (composerSinks()?.text() ?? "").trim() !== "";
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      tookKeyboard = true;
      if (cardUp()) armCardKeys();
      if (draft) props.notify?.("Claude needs an answer. Your message is kept for after.", "info");
      const vv = window.visualViewport;
      if (!vv) return;
      const rearm = (): void => {
        if (cardUp() && !cardKeysArmed()) armCardKeys();
      };
      vv.addEventListener("resize", rearm);
      onCleanup(() => vv.removeEventListener("resize", rearm));
    }),
  );
  /**
   * A tap on a card's button before its keys arm presses nothing on a phone:
   * it was meant for the keyboard that was there a moment ago, or for the
   * conversation the card has just covered. It starts the wait again, since a
   * tap that soon means the reader is still typing and has not looked up.
   */
  //
  // Nor does the focus such a tap gives a row stay on it. Deployed review
  // round 6 (2026-09-30, Android emulator): Android Chrome focuses a button
  // as the finger goes down, before the click this swallows, and once the
  // card armed one Space pressed that row; once it granted "Yes, and don't
  // ask again" and wrote an allow rule into the project's settings. A row
  // that takes the focus before the card arms hands it to the card, where
  // keys go into the draft (`typeBehind`), and Space or Enter on a row
  // before then presses nothing. A tap that went down before the card armed
  // is swallowed even when it lifts after.
  onMount(() => {
    const el = viewEl;
    if (!el) return;
    const tooSoon = (): boolean => cardUp() && !cardKeysArmed() && isCoarsePointer();
    const cardButton = (t: EventTarget | null): HTMLElement | null =>
      t instanceof Element ? t.closest<HTMLElement>(".tl-qcard button") : null;
    const toCard = (b: HTMLElement): void => {
      if (document.activeElement !== b) return;
      const card = b.closest<HTMLElement>(".tl-qcard");
      if (card) card.focus({ preventScroll: true });
      if (document.activeElement === b) b.blur();
    };
    let downTooSoon = false;
    const down = (e: PointerEvent): void => {
      downTooSoon = !!cardButton(e.target) && tooSoon();
    };
    const tapTooSoon = (e: MouseEvent): void => {
      const early = downTooSoon;
      downTooSoon = false;
      const b = cardButton(e.target);
      if (!b || !cardUp() || !(tooSoon() || (early && isCoarsePointer()))) return;
      e.preventDefault();
      e.stopPropagation();
      toCard(b);
      armCardKeys();
    };
    const focusTooSoon = (e: FocusEvent): void => {
      const b = cardButton(e.target);
      if (b && tooSoon()) toCard(b);
    };
    const keyTooSoon = (e: KeyboardEvent): void => {
      if (e.key !== " " && e.key !== "Enter") return;
      const t = e.target;
      if (!(t instanceof Element) || !t.closest(".tl-qcard-option")) return;
      if (cardUp() && !cardKeysArmed()) e.preventDefault();
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("click", tapTooSoon, true);
    el.addEventListener("focusin", focusTooSoon, true);
    el.addEventListener("keydown", keyTooSoon, true);
    el.addEventListener("keyup", keyTooSoon, true);
    onCleanup(() => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("click", tapTooSoon, true);
      el.removeEventListener("focusin", focusTooSoon, true);
      el.removeEventListener("keydown", keyTooSoon, true);
      el.removeEventListener("keyup", keyTooSoon, true);
    });
  });
  // A card answered and gone hands the focus back to the field that comes
  // back in its place, so the next message can be typed at once (deployed
  // review rounds 3 to 5, 2026-09-28: it fell to the page). On a phone only
  // when the reader was typing in the card's own field: raising a keyboard
  // after a tap on a row would cover the conversation.
  let typedInCard = false;
  onMount(() => {
    const el = viewEl;
    if (!el) return;
    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target;
      typedInCard = t instanceof HTMLTextAreaElement && !!t.closest(".tl-qcard");
    };
    el.addEventListener("focusin", onFocusIn);
    onCleanup(() => el.removeEventListener("focusin", onFocusIn));
  });
  createEffect(
    on(cardUp, (up, was) => {
      if (up || !was) return;
      const typed = typedInCard;
      queueMicrotask(() => {
        if (props.onScreen === false || !tileFocused() || props.inertReason) return;
        const active = document.activeElement;
        const inView = !!active && !!viewEl?.contains(active);
        if (active && active !== document.body && !inView) return;
        if (isCoarsePointer() && !typed) return;
        composerSinks()?.focus();
      });
    }),
  );
  createEffect(
    on(cardUp, (up) => {
      if (!up) return;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active && active !== document.body && !emptyField(active)) return;
        if (props.onScreen === false || !tileFocused()) return;
        viewEl?.querySelector<HTMLElement>(".tl-qcard")?.focus({ preventScroll: true });
      });
    }),
  );

  return (
    <div
      class="tl-textview"
      ref={viewEl}
      style={{ "--tl-text-scale": String(scaleFor(textSize())) }}
      data-card-keys={cardUp() && cardKeysArmed() ? "armed" : undefined}
      // The agent panel is in the right margin, so the composer and the cards
      // below the transcript centre on what is left of it (app.css).
      data-rail={showAgents() && agentSet() && !narrow() ? "true" : undefined}
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
          // A session with no transcript here has no stream to open (404).
          opening={props.noTranscript ? false : props.opening}
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
          queued={ghosts()}
          planDocked={planDocked()?.call ?? null}
          cardDocked={cardUp()}
          planAnswer={(() => {
            const a = planAnswered();
            return a ? { toolId: a.toolId, action: a.action } : null;
          })()}
          hidden={drill() !== null}
          onReveal={() => closeDrill(false)}
          // The live group at the end says what the turn is doing: off the
          // same row the composer reads, so a docked plan card reads "Waiting
          // for you" there too, and a pending slash command draws nothing.
          live={lineLive() ?? null}
          clearing={planAnswered()?.action === "clear"}
          onAtEnd={setAtEnd}
          registerToEnd={(fn) => {
            toEnd = fn;
          }}
          browser={props.browser}
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
              onAtEnd={setDrillAtEnd}
              registerToEnd={(fn) => {
                drillToEnd = fn;
              }}
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
              onBack={() => closeDrill(true)}
            />
          )}
        </Show>
      </div>
      {/* Where a session with no transcript here answers: the Terminal view.
          Deployed review round 1 (2026-09-28) found a Codex session's Text
          view reading "No messages yet" while Codex answered in the pane. */}
      <Show when={props.noTranscript}>
        {(kind) => (
          <div class="tl-terminal-note" role="note">
            <span>
              {kind() === "codex"
                ? "Codex replies in the Terminal view."
                : "Output shows in the Terminal view."}
            </span>
            <Show when={props.onOpenTerminal}>
              <button type="button" class="tl-linkbtn" onClick={() => props.onOpenTerminal?.()}>
                Open the Terminal
              </button>
            </Show>
          </div>
        )}
      </Show>
      {/* "Latest", in a band of its own between the transcript and the
          composer (prototype 6-scrolled). The band takes its 42px from the
          transcript while it shows, so the button covers no row, which it did
          from inside the scroller. It follows whichever timeline is on screen,
          the session's or the drill-in's. A card Claude is waiting on holds the
          bottom of the view and says what it is waiting on, so the band stays
          away while one is up. */}
      <Show when={trustUp() && !cardUp()}>
        <div class="tl-trust-band" role="status">
          <span>Claude is asking whether to trust this folder.</span>
          <Show when={props.onOpenTerminal}>
            <button type="button" class="tl-linkbtn" onClick={() => props.onOpenTerminal?.()}>
              Answer in the Terminal
            </button>
          </Show>
        </div>
      </Show>
      <Show when={latestShown()}>
        <div class="tl-latest-band">
          <button
            type="button"
            class="tl-latest"
            onClick={() => (drill() !== null ? drillToEnd : toEnd)?.()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M8 3v10M3.5 8.5 8 13l4.5-4.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span>
              Latest
              <Show when={latestWorking()}>
                {" · "}
                <span class="tl-latest-working">working</span>
              </Show>
            </span>
          </button>
        </div>
      </Show>
      {/* In the composer's place, not inline: on a phone the timeline scrolls
          and the keyboard covers it, and a walk that slides out from under a
          thumb mid-answer is worse than no walk. The permanent record is the
          inline row, which appears the moment the transcript carries the
          result. The composer below stays mounted and hidden while a card is
          up (`composerHidden`). */}
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
            questions={asked()}
            more={Math.max(0, heldCalls().length - 1)}
            state={cardState()}
            busy={answering()}
            keysActive={props.onScreen !== false && tileFocused() && cardKeysArmed()}
            inert={props.inertReason}
            onSubmit={submitAnswers}
            onChat={chatInstead}
            onTerminal={props.onOpenTerminal}
            onTakeControl={props.onTakeControl}
          />
        )}
      </Show>
      {/* The tool permission prompt docks there too, keyed on the reading so
          each prompt gets a card of its own (PermissionCard says why). */}
      <Show when={props.onKeys ? (permission()?.id ?? 0) : 0} keyed>
        {(_prompt) => {
          const reading = permission();
          const own = reading ? permOwnFor(reading) : undefined;
          return reading ? (
            <PermissionCard
              reading={reading}
              preview={permissionPreview(reading, props.events)}
              onPick={pickPermission}
              {...(props.onAnswer ? { onDecline: declinePermission } : {})}
              inert={props.inertReason}
              onTakeControl={props.onTakeControl}
              register={(press) => {
                pressPermissionRow = press;
              }}
              {...(own ? { own } : {})}
              onOwn={(own) => {
                permOwn = { key: permissionPromptKey(reading), own };
              }}
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
          sending={planSending()}
          inert={props.inertReason}
          notice={planReplyNow()?.notice ?? null}
          onApprove={approvePlanOption}
          onFeedback={(words) => sendPlanFeedback(words, false)}
          onApproveWithFeedback={(words) => sendPlanFeedback(words, true)}
          onTerminal={props.onOpenTerminal}
          onTakeControl={props.onTakeControl}
          keysActive={props.onScreen !== false && tileFocused() && cardKeysArmed()}
        />
      </Show>
      <Composer
        placeholder={
          props.noTranscript === "codex"
            ? "Ask Codex, or run a command…"
            : props.noTranscript === "shell"
              ? "Run a command…"
              : undefined
        }
        hidden={composerHidden() && !typingBehind()}
        offstage={typingBehind()}
        textSize={textSize()}
        // The open turn's row, which decides Stop, and what the session still
        // owes once the transcript has closed the turn: an agent or a workflow
        // it launched keeps going and writes into this conversation minutes
        // later (the session list knows, the transcript does not).
        // The agent panel names the same work one entry at a time, so the line
        // leaves it out while the panel shows; on the panel's own signal, so
        // the two cannot disagree.
        live={lineLive()}
        claudeState={props.claudeState?.()}
        queued={queued().length}
        background={showAgents() ? undefined : backgroundLabel(props.background?.())}
        pending={props.pending}
        onSend={send}
        onStop={() => void stopHandingBack()}
        onResolve={props.onResolve}
        sendToTerminal={props.sendToTerminal}
        history={history()}
        {...(props.onKeys ? { mode: mode(), onCycleMode: cycleMode } : {})}
        {...(props.onSetMode ? { onPickMode: pickMode } : {})}
        modeBusy={modeBusy()}
        modeHeld={modeHeld()}
        modelHeld={modelHeld()}
        modesUnavailable={unavailable()}
        onModelSheetOpen={rereadMode}
        onTakeControl={props.onTakeControl}
        {...(context() ? { context: context()! } : {})}
        {...(props.harness && props.onSetModel
          ? {
              harness: props.harness,
              onPickModel: pickModel,
              modelOffer: props.modelOffer,
            }
          : {})}
        {...(modelState() ? { model: modelState()! } : {})}
        modelBusy={modelBusy()}
        onListDir={props.onListDir}
        commands={commands()}
        commandsOk={catalogueOk()}
        session={props.session}
        onAttach={props.onAttach}
        inertReason={props.inertReason}
        // Not from a field typing behind the card: the reader cannot see it
        // is empty, so a digit there is typing (`typingBehind`).
        onPermissionDigit={(row) =>
          permission() && !typingBehind() && cardKeysArmed()
            ? (pressPermissionRow?.(row) ?? false)
            : false
        }
        register={(api) => {
          setComposerSinks(api);
          props.register?.(api);
        }}
      />
    </div>
  );
};
