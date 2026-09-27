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
  type AnswerRequest,
  type AnswerResponse,
  type PlanAnswer,
  type PlanOptionView,
} from "../lib/answer-api";
import type { Question } from "./canonicalize";
import { QuestionCard, type QuestionCardApi, type QuestionCardState } from "./QuestionCard";
import { heldFromEvents } from "./question.logic";
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
 * How long a question the transcript shows waits for the lobby's hook to hold
 * it before the card says the Terminal is the place to answer. The hook fires as
 * the CLI draws its menu, usually before the record is written, so this only
 * runs out for a session whose Claude started before the hook was installed.
 */
const HOLD_GRACE_MS = 4_000;

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
   * Two sources for one call. `held` is the question the lobby's hook is
   * holding for the card (ADR-0034); it is what makes the card answerable, and
   * it arrives before the transcript's record, which Claude Code sometimes
   * writes only once the question is answered (measured 2026-08-28, 112 s late
   * in one case). `recorded` is the transcript's call, which stands in for a
   * session whose question no hook is holding, so the reader still sees what is
   * being asked and where to answer it.
   */
  const recorded = createMemo(() => pendingQuestion(baseRows()));
  const held = createMemo(() => heldFromEvents(props.events));
  const asked = createMemo((): Question[] => held() ?? recorded()?.questions ?? []);
  /** WHAT is being asked, as the call's question texts; empty when nothing is. */
  const asking = createMemo(() => asked().map((q) => q.question).join("\u0000"));
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
   * way this view writes to the session goes through here first.
   */
  const refuseWatching = (): boolean => {
    const why = props.inertReason;
    if (!why) return false;
    props.notify?.(why, "info");
    return true;
  };
  /** The docked permission card's press, for a row number typed on the
   *  keyboard (PermissionCard `register`). */
  let pressPermissionRow: ((row: number) => boolean) | undefined;
  /** Press a permission row's number. */
  const pickPermission = async (n: number): Promise<boolean> => {
    if (refuseWatching()) return false;
    const ok = (await props.onKeys?.([String(n)])) ?? false;
    if (!ok) props.notify?.("Couldn't answer Claude's prompt. Answer it in the Terminal.", "error");
    return ok;
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
  /** The same handle as a signal, for what renders from it: the plan card
   *  offers "Approve with this feedback" only while the field holds text. */
  const [composerSinks, setComposerSinks] = createSignal<ComposerSinks>();

  /** The docked card's handle, while a card is docked. */
  let cardApi: QuestionCardApi | undefined;

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
      props.notify?.("The question is no longer waiting on this card. Answer it in the Terminal.", "error");
    } else if (resp.reason === "incomplete") {
      props.notify?.("Every question needs an answer before it can be sent.", "error");
    }
    return false;
  };
  const submitAnswers = (answers: Record<string, string[]>): Promise<boolean> =>
    answerHeld({ answers });
  /** "Chat about this": the composer's words, if it holds any, go to Claude
   *  with the refusal, and the field clears only if they were taken. */
  const chatInstead = (): void => {
    const sinks = composerSinks();
    if (sinks?.hasInput()) {
      void sinks.submitVia((text) => answerHeld({ chat: text }));
      return;
    }
    void answerHeld({ chat: "" });
  };

  /**
   * The composer's Send. With a question docked it ANSWERS the question with
   * what was typed, as the free-text answer to the question on show, the way
   * T3 Code's composer does.
   *
   * Reported 2026-09-26 (Viktor): he typed his answer into the message field
   * and pressed Send, and it went in as a prompt. A person who types while
   * being asked something is answering it.
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
    if (refuseWatching()) return false;
    // A permission prompt's menu takes keys, not a prompt: its Enter picks
    // the highlighted row, "Yes". The words stay in the field.
    if (permission()) {
      props.notify?.("Claude is asking to use a tool. Answer it from the card first.", "warning");
      return false;
    }
    if (!asking() || !props.onAnswer || !cardApi) return props.onSend(text);
    if (cardState() !== "open") {
      props.notify?.(
        cardState() === "terminal"
          ? "Claude's question can only be answered in the Terminal right now."
          : "Still connecting to Claude's question. Send again in a moment.",
        "error",
      );
      return false;
    }
    if (answering()) {
      props.notify?.("Still sending the last answer. Send again in a moment.", "error");
      return false;
    }
    return cardApi.typed(text.replace(/\s*\n\s*/g, " ").trim());
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
    if (refuseWatching()) return false;
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
            questions={asked()}
            state={cardState()}
            busy={answering()}
            hasInput={composerSinks()?.hasInput() ?? false}
            keysActive={props.onScreen !== false && tileFocused()}
            inert={props.inertReason}
            onSubmit={submitAnswers}
            onChat={chatInstead}
            onUseTyped={() => {
              void composerSinks()?.submitVia(send);
            }}
            onTerminal={props.onOpenTerminal}
            register={(api) => {
              cardApi = api;
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
              inert={props.inertReason}
              register={(press) => {
                pressPermissionRow = press;
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
          hasInput={composerSinks()?.hasInput() ?? false}
          lineBreaks={composerSinks()?.lineBreaks() ?? false}
          sending={planSending()}
          inert={props.inertReason}
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
        onPermissionDigit={(row) => (permission() ? (pressPermissionRow?.(row) ?? false) : false)}
        register={(api) => {
          setComposerSinks(api);
          props.register?.(api);
        }}
      />
    </div>
  );
};
