import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
  type Component,
  type JSX,
} from "solid-js";
import type { PermissionDecision } from "../types/events";
import type { ClaudeState } from "../types/lobby";
import type { PendingPermission, WorkingRow } from "./timeline.logic";
import { PermissionPanel } from "./PermissionPanel";
import { isSlashCommand, type SlashCommand } from "../logic/compose.logic";
import { isDangerMode, type ModeId } from "../logic/modes";
import type { DraftAttachment } from "../store/drafts";
import type { ContextState } from "./context.logic";
import { PromptField, type PromptFieldSinks } from "./PromptField";
import { ModelSheet } from "./ModelSheet";
import type { ModelField, ModelHarness, ModelState, PiOffer } from "../lib/models";

/**
 * The LIVE session's composer, docked at the foot of the Text view: the
 * permission panel when one is pending, and the surface a message is written
 * in.
 *
 * THE T3 PASS (chosen by Viktor on 2026-09-27;
 * docs/plans/2026-09-27-text-view-t3-pass.md). On a phone at rest the surface
 * is one 50px pill: `+`, the placeholder "Ask Claude, or run a command…" and
 * the round button. Focused on the phone, and always on a desktop, it is a
 * box: the text on top, and a row beneath with `+`, the model button's slot
 * and the round button. Measured on the prototype: a 108px box on a desktop,
 * a 50px pill with 8px under it on a phone, and a 142px box when focused
 * there. PromptField draws both shapes.
 *
 * It replaced the Quiet line (2026-09-24), a thin status line above a pill.
 * The line's jobs moved: what the turn is doing went into the live work group
 * at the end of the conversation, the watching state into the pill, and the
 * dock's top edge (a sweep while working, a dashed danger rule) went with it.
 * Its three dials became the one model button in the box's row, whose sheet
 * holds the model, the effort, the mode and the context (ModelSheet), and
 * background work is a quiet note beside that button. Stop is a state of the
 * round button: it shows while Claude works and the field is empty, and only
 * when the transcript and the hook state agree that a turn runs.
 *
 * BYPASS AND NO ASK turn the surface's border the danger colour, with a ring
 * while it is focused, and put a small red shield on the model button. Nothing
 * else changes: the placeholder stays the same one sentence in every mode.
 *
 * Sending goes through ONE route on every device: `onSend` (the session control
 * channel, session-events /prompt). It used to fork on `sendToTerminal` for a
 * coarse pointer and post the bytes into the terminal iframe instead, and in
 * Text mode that frame had not attached yet, because the attach is deliberately
 * lazy. `sendBytesToFrame` (TerminalView.tsx:387) returned false with no
 * contentWindow and nothing upstream looked at the result, so the field was
 * cleared and the message went nowhere: typing on a phone, pressing send, and
 * watching the text vanish. The control channel needs no attached terminal, is
 * the same path the desktop has always used, and reports whether it landed.
 *
 * A mid-turn send QUEUES, which is what Claude Code does with typed input, and
 * the queued prompts show as dashed ghost bubbles at the end of the timeline
 * (MessagesTimeline) rather than as chips in here. When a permission is pending
 * and the field is empty, 1 approves and 2 denies (T3's number-key affordance).
 */
/** What a caller outside the composer may put into the message being written. */
export type ComposerSinks = PromptFieldSinks;

/**
 * How long one press of Stop holds the round button when the session has not
 * said the turn settled by then.
 *
 * Stop is `Injector.Cancel` (sessionio/tmux.go), which sends C-c without
 * reading the pane, and a second C-c at an idle Claude prompt exits the CLI.
 * So a press holds the button until the hook state leaves `running`: Cancel
 * re-stamps it `done` and the session list carries that within ~10s
 * (ADR-0001). NOT on the transcript's row going away: measured live on
 * 2026-09-27, the row closed and came back within a second of an interrupt
 * while the list still read `running`, and a second tap sent a second C-c.
 * Past this bound the session really is still running, and another press is
 * the reader's to make.
 */
const STOP_SETTLE_MS = 20_000;

/**
 * How long a prompt this composer sent speaks for the turn it opened, while
 * the hook state still reads the last turn's `done`.
 *
 * The stamp reaches the page through the session list, up to ~10s behind the
 * pane (ADR-0001), and measured live on 2026-09-27 the button stayed a greyed
 * Send for the first ~4s of every turn while the live group already read
 * "Working… 3s". The window closes as soon as the stamp moves, so this bound
 * only matters when it never does.
 */
const SEND_TRUST_MS = 15_000;

export const Composer: Component<{
  /**
   * A card Claude is waiting on has the composer's place (the T3 pass). The
   * composer stays mounted and only stops drawing, so the draft, the
   * attachments and the registered sinks outlive the card.
   */
  hidden?: boolean;
  /**
   * The card docked while the reader was typing in the field: the composer
   * stops drawing but keeps the focus, so the rest of the sentence lands in
   * the message rather than on the page (TextView `typingBehind`).
   */
  offstage?: boolean;
  /** The text view's pinch size, forwarded to the field. */
  textSize?: number;
  /**
   * The open turn's live row, or undefined while no turn is open. With
   * `claudeState` it decides whether the round button offers Stop (while
   * something RUNS, never while Claude waits) and whether Send says it
   * queues. What the turn is doing is the conversation's to say, in the live
   * group at its end.
   *
   * NOT a reason to withhold Send: it is derived from the transcript and lags
   * the pane, and a mid-turn send queues rather than failing.
   */
  live?: WorkingRow;
  /**
   * The session's hook-stamped state (ADR-0001), from the session list.
   * Stop needs it to read `running` as well as the live row saying working:
   * the row lags the pane (a `done` session showed Stop in 98 of 100 samples),
   * and a Stop pressed at an idle prompt sends a C-c that can exit Claude.
   * Absent, or any other state, offers no Stop.
   */
  claudeState?: ClaudeState;
  /** What the session still owes once its turn has closed ("2 agents"). */
  background?: string;
  pending: PendingPermission[];
  /** resolves false when the session refused the prompt (5xx, unreachable),
   *  which puts the typed text back in the field. The attachments ride along
   *  beside the text, which already carries their paths where their tokens
   *  stood; the live session ignores them. */
  onSend: (text: string, attachments?: readonly DraftAttachment[]) => Promise<boolean>;
  onStop: () => void;
  onResolve: (reqId: string, decision: PermissionDecision) => void;
  /** Forward raw pty bytes to the live terminal. No longer used for
   *  SENDING — kept for callers that hand bytes to the pty for other reasons,
   *  e.g. answering a prompt the transcript cannot express. */
  sendToTerminal?: (bytes: string) => void;
  /** Prompts already sent in this session, oldest first (↑ recalls them). */
  history?: string[];
  /** The permission mode in force, which the model sheet ticks. */
  mode?: string;
  /** A mode change is in flight. */
  modeBusy?: boolean;
  /** Why the mode cannot change right now: a dialog is on the pane, where
   *  Shift+Tab would type into it. The model button is held with this reason. */
  modeHeld?: string;
  /** Why the model cannot change right now, for the same dialogs: the
   *  picker is driven by typing `/model` into the pane. */
  modelHeld?: string;
  /** Modes the server has said this session does not offer. */
  modesUnavailable?: ReadonlySet<string>;
  /** Step the permission mode once, as Shift+Tab does in the CLI. */
  onCycleMode?: () => void;
  /** Put the session in a mode picked from the sheet's list. */
  onPickMode?: (mode: ModeId) => void;
  /** The newest `/context` reading, the sheet's context line. */
  context?: ContextState;
  /** Which CLI this session runs, when it is one with a model to pick. Absent
   *  for a plain shell, and for a session whose tool nothing has reported. */
  harness?: ModelHarness;
  /** What that CLI reports being on, and whether a change is in flight. */
  model?: ModelState;
  modelBusy?: boolean;
  /** Pi's rows: the models pi lists and the levels the session supports. */
  modelOffer?: PiOffer;
  /** Put the session on a model or an effort level. */
  onPickModel?: (field: ModelField, id: string) => void;
  /** Directory listing for `@` path completion. */
  onListDir?: (dir: string) => Promise<string[]>;
  /** The session's own skills / custom commands / plugin commands, offered by
   *  `/` beside the built-ins this page ships. */
  commands?: SlashCommand[];
  /** False when that catalogue could not be read, so the menu can say so. */
  commandsOk?: boolean;
  /**
   * The session this composer belongs to — the key its unsent draft is stored
   * under (store/drafts.ts). Attachments and text both persist, so a reload or an
   * evicted phone tab does not lose a half-written message with a photo on it.
   */
  session?: string;
  /**
   * Upload these files and return what became attachable. The uploader decides:
   * a document over the store cap stays an ephemeral /tmp transfer and comes back
   * absent from the result, which is why this returns a list rather than one item
   * per input file.
   */
  onAttach?: (files: File[]) => Promise<DraftAttachment[]>;
  /** Watching: the controls that type are inert, and so is attaching. */
  inertReason?: string;
  /**
   * The docked permission card's row for a digit typed into an empty field:
   * true when the card has a row with that number and took the press. Absent
   * while no card is docked.
   */
  onPermissionDigit?: (row: number) => boolean;
  /** Hand the session back to this device, from the watching pill. */
  onTakeControl?: () => void;
  /** Hand the caller the sinks a message can be filled from OUTSIDE this
   *  component (a window drop, a gallery tile, a paste). */
  register?: (api: ComposerSinks) => void;
}> = (props) => {
  /**
   * A digit on an empty field answers a pending permission, and only when
   * there IS one, so the digits stay typable.
   *
   * The docked card comes first: its rows are the CLI's own, drawn with their
   * numbers as keycaps, so a digit presses the row it names. What row 2 means
   * changes with the prompt ("always allow", "switch to auto mode"), which is
   * why the card's numbers are used rather than a fixed meaning. Found in
   * review on 2026-09-27: the shortcut only read the hook-fed list below,
   * which nothing fills in production, so the digit went into the field.
   *
   * The hook-fed list keeps its own rule: 1 approves the oldest request, 2
   * denies it.
   */
  const onEmptyDigit = (digit: string): boolean => {
    if (props.onPermissionDigit?.(Number(digit))) return true;
    if (digit !== "1" && digit !== "2") return false;
    const p = props.pending[0];
    if (!p) return false;
    props.onResolve(p.reqId, digit === "1" ? "allow" : "deny");
    return true;
  };

  const working = (): boolean => !!props.live && !props.live.waiting;

  /**
   * The stamp, read once per change of its VALUE. The prop is a field of the
   * session record, and the list hands over a new record on every poll, so
   * reading it directly re-runs anything watching it with the same word
   * (found live on 2026-09-28: the send's trust window ended at the first
   * poll, ~0.9s into every turn).
   */
  const claudeState = createMemo(() => props.claudeState);

  // ---- A send this composer made, before the stamp catches up -------------
  const [justSent, setJustSent] = createSignal(false);
  let sentTimer: ReturnType<typeof setTimeout> | undefined;
  const forgetSend = (): void => {
    clearTimeout(sentTimer);
    sentTimer = undefined;
    setJustSent(false);
  };
  // Any move of the stamp after the send is the session speaking for itself.
  createEffect(on(claudeState, () => forgetSend(), { defer: true }));
  onCleanup(forgetSend);

  /**
   * A turn runs by both readings: the transcript's row, and the hook state
   * saying the session is not idle.
   *
   * `awaiting` counts: a permission answered from the card leaves the stamp
   * there until the call's PostToolUse, which for a long command is the whole
   * of the call (found live on 2026-09-27, 45s of a greyed Send with Claude
   * running). It never means an idle prompt, since Stop and an interrupt both
   * stamp `done`, and the row says whether anything is waiting on the reader.
   *
   * A prose prompt sent from here also counts while the stamp still reads the
   * `done` it read at the send (SEND_TRUST_MS): the turn is the one this
   * composer just opened. What it guards against is a STALE row on a finished
   * session, and a row newer than the send is not that.
   */
  const turnRunning = (): boolean =>
    working() &&
    (claudeState() === "running" ||
      claudeState() === "awaiting" ||
      (justSent() && claudeState() === "done"));

  // ---- Stop, once per turn ---------------------------------------------------
  const [stopping, setStopping] = createSignal(false);
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = (): void => {
    clearTimeout(stopTimer);
    stopTimer = undefined;
    setStopping(false);
  };
  // Settled once the stamp says the session is idle: Cancel re-stamps `done`.
  // A move between running and awaiting is the turn going on.
  createEffect(() => {
    const state = claudeState();
    if (state !== "running" && state !== "awaiting") settled();
  });
  onCleanup(settled);
  const stop = (): void => {
    if (stopping()) return;
    setStopping(true);
    stopTimer = setTimeout(settled, STOP_SETTLE_MS);
    props.onStop();
  };
  /** Background work, once no turn is open ("2 agents"). */
  const background = (): string | undefined =>
    props.live || props.inertReason ? undefined : props.background;
  const danger = (): boolean => isDangerMode(props.mode ?? "");

  /**
   * Whether the model button has anything to open: a CLI with a model to pick,
   * a mode something has read (a pane or a transcript that never named one, a
   * codex pane for one, gets no Mode section rather than a confident wrong
   * one), or a `/context` reading. A plain shell has none of the three.
   */
  const hasSheet = (): boolean =>
    (!!props.harness && !!props.onPickModel) ||
    (!!props.mode && !!(props.onPickMode || props.onCycleMode)) ||
    !!props.context;

  /**
   * Where Send goes. A stable function rather than the prop itself, so the
   * field reads the route at the moment it sends. The plan's feedback is the
   * plan card's own field since the T3 pass; the card hides this composer
   * while it waits, and the text view refuses a send that still reaches it.
   */
  const send = (text: string, held: readonly DraftAttachment[]): Promise<boolean> => {
    const sent = props.onSend(text, held);
    // The field awaits the same promise, so a refusal restores its text on the
    // same tick as before this watched it.
    void sent.then((ok) => {
      if (!ok || isSlashCommand(text)) return;
      // A prompt that opens a turn is a turn the reader may stop. A Stop still
      // held from the last one belongs to that turn: pressed while the stamp
      // read `done`, nothing may move the stamp again to release it, and the
      // new turn read "Stopping…" for up to STOP_SETTLE_MS (found live on
      // 2026-09-28).
      settled();
      forgetSend();
      setJustSent(true);
      sentTimer = setTimeout(forgetSend, SEND_TRUST_MS);
    });
    return sent;
  };

  /** The model button's slot: the button, and background work beside it. */
  const tools = (): JSX.Element => (
    <>
      <Show when={hasSheet()}>
        <ModelSheet
          {...(props.harness && props.onPickModel
            ? { harness: props.harness, onPickModel: props.onPickModel }
            : {})}
          model={props.model}
          modelBusy={props.modelBusy === true}
          modelOffer={props.modelOffer}
          mode={props.mode && (props.onPickMode || props.onCycleMode) ? props.mode : undefined}
          modeBusy={props.modeBusy === true}
          modesUnavailable={props.modesUnavailable}
          onPickMode={props.onPickMode}
          modeHeld={props.modeHeld}
          modelHeld={props.modelHeld}
          context={props.context}
          inertReason={props.inertReason}
        />
      </Show>
      <Show when={background()}>
        {(label) => (
          <span class="tl-box-note" data-kind="background">
            <span class="tl-box-note-dot" aria-hidden="true" />
            <span class="tl-box-note-word">Background:</span>{" "}
            <span class="tl-box-note-target" title={label()}>
              {label()}
            </span>
          </span>
        )}
      </Show>
    </>
  );

  return (
    <div
      class="tl-composer"
      hidden={props.hidden}
      data-offstage={props.offstage ? "" : undefined}
      aria-hidden={props.offstage ? "true" : undefined}
    >
      <Show when={props.pending.length > 0}>
        <PermissionPanel pending={props.pending} onResolve={props.onResolve} />
      </Show>
      <PromptField
        textSize={props.textSize}
        onSend={send}
        label="Message to send to the session"
        placeholder="Ask Claude, or run a command…"
        history={props.history}
        onListDir={props.onListDir}
        commands={props.commands}
        commandsOk={props.commandsOk}
        draftKey={props.session}
        onAttach={props.onAttach}
        inertReason={props.inertReason}
        onTakeControl={props.onTakeControl}
        onCycleMode={props.onCycleMode}
        onEmptyDigit={onEmptyDigit}
        register={props.register}
        fold
        danger={danger()}
        tools={tools()}
        canStop={turnRunning() && !props.inertReason}
        onStop={stop}
        stopping={stopping()}
        queues={turnRunning()}
        attachNote="Images join this session's gallery"
      />
    </div>
  );
};
