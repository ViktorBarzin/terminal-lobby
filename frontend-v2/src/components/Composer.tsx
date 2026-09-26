import { createMemo, Show, type Component } from "solid-js";
import type { PermissionDecision } from "../types/events";
import type { PendingPermission, WorkingRow } from "./timeline.logic";
import { PermissionPanel } from "./PermissionPanel";
import type { SlashCommand } from "../logic/compose.logic";
import { isDangerMode, modeRow, modeTitle, placeholderFor, type ModeId } from "../logic/modes";
import type { DraftAttachment } from "../store/drafts";
import {
  contextTone,
  formatTokens,
  percentFull,
  readingAge,
  type ContextState,
} from "./context.logic";
import { ContextPanel } from "./ContextPanel";
import { PromptField, type PromptFieldSinks } from "./PromptField";
import { ModelPanel } from "./ModelPanel";
import { StatusLine } from "./StatusLine";
import { DialBar, type DialSpec } from "./Dial";
import { ModePanel } from "./ModePanel";
import { ContextRing, ShieldIcon, WarnIcon } from "./Icons";
import {
  chipName,
  labelFor,
  modelName,
  summarise,
  type ModelField,
  type ModelHarness,
  type ModelState,
  type PiOffer,
} from "../lib/models";

/**
 * The LIVE session's composer, docked at the foot of the Text view: the
 * permission panel when one is pending, the thin status line with its dials,
 * and the pill a message is written in.
 *
 * THE QUIET LINE (chosen by Viktor on 2026-09-24 from five prototypes, for the
 * four complaints he named: too much at once, eats the screen, controls say
 * too little, looks generic). One line of small type above a pill. The line's
 * left side is what the session is doing, with Stop beside the work it stops;
 * its right side is the mode, model and context dials, each named for what it
 * sets. The pill is `+`, the field and Send. At rest the dock measures 86px on
 * a desktop and 92px on a phone, where the one it replaced measured 124px and
 * 127px with the session's state in a row of its own above it.
 *
 * THE DOCK'S TOP EDGE carries the state too: a slow sweep of the running
 * colour while Claude works, the awaiting colour while it waits, and a dashed
 * danger rule while the mode lets everything through. It follows the SESSION,
 * not what this device may do, so a watcher still sees the sweep.
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

export const Composer: Component<{
  /** The text view's pinch size, forwarded to the field. */
  textSize?: number;
  /**
   * The open turn's live row, exactly as the timeline used to draw it, or
   * undefined while no turn is open. It decides the line's words, whether Stop
   * shows (while something RUNS, never while Claude waits), the "queues" hint
   * beside Send, and the dock's top edge.
   *
   * NOT a reason to withhold Send: it is derived from the transcript and lags
   * the pane, and a mid-turn send queues rather than failing.
   */
  live?: WorkingRow;
  /** What the session still owes once its turn has closed ("2 agents"). */
  background?: string;
  /** Claude is asking a blocking question right now. The text view sends what
   *  is typed as the question's free-text answer then (TextView `send`), so
   *  Send says so. */
  asking?: boolean;
  /**
   * The plan-approval dialog is on the pane. The field then answers the plan:
   * its placeholder says so and Send goes to `onPlanFeedback`, which types the
   * text into the dialog's feedback row, so nothing typed here can land in an
   * open plan menu by accident.
   */
  planOpen?: boolean;
  /** This device's plan answer is clearing the context; the line says so. */
  planClearing?: boolean;
  /** Send's route while `planOpen`. Resolves false when refused, which puts
   *  the text back. */
  onPlanFeedback?: (text: string) => Promise<boolean>;
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
  /** The permission mode in force, which the mode dial shows. */
  mode?: string;
  /** A mode change is in flight. */
  modeBusy?: boolean;
  /** Why the mode cannot change right now: a dialog is on the pane, where
   *  Shift+Tab would type into it. The mode dial is held with this reason. */
  modeHeld?: string;
  /** Why the model dial cannot act right now, for the same dialogs: the
   *  picker is driven by typing `/model` into the pane. */
  modelHeld?: string;
  /** Modes the server has said this session does not offer. */
  modesUnavailable?: ReadonlySet<string>;
  /** Step the permission mode once, as Shift+Tab does in the CLI. */
  onCycleMode?: () => void;
  /** Put the session in a mode picked from the dial's list. */
  onPickMode?: (mode: ModeId) => void;
  /** The newest `/context` reading, shown as the context dial. */
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
  /** Hand the session back to this device, from the line's watching state. */
  onTakeControl?: () => void;
  /** Hand the caller the sinks a message can be filled from OUTSIDE this
   *  component (a window drop, a gallery tile, a paste). */
  register?: (api: ComposerSinks) => void;
}> = (props) => {
  /**
   * 1 approves the oldest pending permission, 2 denies it — but only on an
   * empty field, and only when there IS one, so the digits stay typable.
   */
  const onEmptyDigit = (digit: string): boolean => {
    const p = props.pending[0];
    if (!p) return false;
    props.onResolve(p.reqId, digit === "1" ? "allow" : "deny");
    return true;
  };

  const working = (): boolean => !!props.live && !props.live.waiting;
  const danger = (): boolean => isDangerMode(props.mode ?? "");

  // ---- the dials ------------------------------------------------------------
  // Built once each and handed to the bar by reference, with every value read
  // through an accessor, so a change of mode or model updates a dial in place
  // rather than rebuilding it under the reader's focus.

  /** Why the mode dial cannot act: watching, or a dialog on the pane. */
  const modeHeld = (): string => props.inertReason || props.modeHeld || "";
  const modeDial: DialSpec = {
    id: "mode",
    label: "mode",
    tab: "Mode",
    title: "Permission mode",
    dataMode: () => props.mode,
    tone: () => modeRow(props.mode ?? "")?.tone,
    danger,
    busy: () => props.modeBusy === true,
    held: modeHeld,
    value: () => (
      <>
        <span class="tl-dial-icon">
          <Show when={danger()} fallback={<ShieldIcon />}>
            <WarnIcon />
          </Show>
        </span>
        <span class="tl-dial-value">{modeTitle(props.mode ?? "")}</span>
      </>
    ),
    ariaLabel: () =>
      `Permission mode: ${modeTitle(props.mode ?? "")}. ${modeHeld() || "Change it"}`,
    hint: () => {
      const row = modeRow(props.mode ?? "");
      return (
        `Permission mode: ${modeTitle(props.mode ?? "")}.` +
        (row ? ` ${row.line}.` : "") +
        " Shift+Tab in the message steps to the next one."
      );
    },
    panel: (ctx) => (
      <ModePanel
        current={props.mode ?? ""}
        unavailable={props.modesUnavailable}
        held={modeHeld() || undefined}
        onPick={(id) => {
          // Picking the mode in force sends nothing: the walk would press no
          // key, and saying so is the dial showing the mode it already shows.
          if (id !== props.mode) props.onPickMode?.(id);
          ctx.close();
        }}
      />
    ),
  };

  /** Why the model dial cannot act: watching, or a dialog on the pane. */
  const modelHeld = (): string => props.inertReason || props.modelHeld || "";
  /** The model half and the effort half, or whichever is known. */
  const modelWords = (): string => {
    const h = props.harness ?? "claude";
    const m = props.model?.model ? modelName(h, props.model.model) : "";
    const e = props.model?.effort ? labelFor(h, "effort", props.model.effort) : "";
    return [m, e].filter((s) => s !== "").join(" · ");
  };
  /** What the dial is called, in the harness's own words: pi's second
   *  setting is "thinking" (lib/models.ts chipName). */
  const modelTitle = (): string => chipName(props.harness ?? "claude");
  const modelDial: DialSpec = {
    id: "model",
    label: "model",
    tab: "Model",
    // A getter, so the float's name follows the harness like the rest does.
    get title() {
      return modelTitle();
    },
    fold: 1,
    busy: () => props.modelBusy === true,
    held: modelHeld,
    // A session that has not answered yet has said nothing about either, so
    // the dial reads "Model" rather than inventing a value: the composer's
    // stored preference is what the NEXT session starts on, which is a
    // different question.
    unknown: () => !props.modelBusy && modelWords() === "",
    value: () => (
      <span class="tl-dial-value">{props.modelBusy ? "Switching…" : modelWords() || "Model"}</span>
    ),
    ariaLabel: () =>
      `${modelTitle()}: ${modelWords() || "not reported yet"}. ${modelHeld() || "Change them"}`,
    // The exact slug, which the name on the dial shortens (lib/models.ts).
    hint: () =>
      summarise(props.model)
        ? `${modelTitle()}: ${summarise(props.model)}`
        : `${modelTitle()}. The session has not answered yet`,
    panel: (ctx) => (
      <ModelPanel
        harness={props.harness ?? "claude"}
        state={props.model}
        busy={props.modelBusy === true}
        // The phone's sheet reaches this panel by its tab, past the held dial.
        inertReason={modelHeld() || undefined}
        onPick={(field, id) => props.onPickModel?.(field, id)}
        onDone={ctx.close}
        {...(props.modelOffer ? { offer: props.modelOffer } : {})}
      />
    ),
  };

  const ctxDial: DialSpec = {
    id: "ctx",
    label: "context",
    tab: "Context",
    title: "Context window",
    fold: 2,
    readout: true,
    tone: () => (props.context ? contextTone(props.context.reading) : undefined),
    value: () => (
      <>
        <ContextRing percent={props.context ? percentFull(props.context.reading) : 0} />
        <span class="tl-dial-value tl-dial-num">
          {props.context ? percentFull(props.context.reading) : 0}%
        </span>
      </>
    ),
    ariaLabel: () =>
      `Context window ${props.context ? percentFull(props.context.reading) : 0}% full. Show the breakdown`,
    hint: () => {
      const c = props.context;
      if (!c) return "Context window";
      const r = c.reading;
      return (
        `Context window ${percentFull(r)}% full: ${formatTokens(r.usedTokens)} of ` +
        `${formatTokens(r.maxTokens)} tokens${r.model ? ` on ${r.model}` : ""}, read ${readingAge(c.turnsAgo)}`
      );
    },
    panel: () => <Show when={props.context}>{(c) => <ContextPanel state={c()} />}</Show>,
  };

  /**
   * Which dials exist. The mode only once something has read one (a pane or a
   * transcript that never named a mode, a codex pane for one, gets no dial
   * rather than a confident wrong one), the model only for a CLI that has one
   * to pick, the context only once a `/context` reading exists.
   */
  const dials = createMemo<DialSpec[]>(() => {
    const out: DialSpec[] = [];
    if (props.mode && (props.onPickMode || props.onCycleMode)) out.push(modeDial);
    if (props.harness && props.onPickModel) out.push(modelDial);
    if (props.context) out.push(ctxDial);
    return out;
  });

  /**
   * Where Send goes. While the plan dialog is up, the text is feedback on the
   * plan and is typed into the dialog's own row; a plain prompt then would be
   * typed into the plan menu, which is what `onPlanFeedback` exists to
   * prevent. A stable function rather than a conditional prop, so the field
   * reads the route at the moment it sends.
   */
  const send = (text: string, held: readonly DraftAttachment[]): Promise<boolean> =>
    props.planOpen && props.onPlanFeedback ? props.onPlanFeedback(text) : props.onSend(text, held);
  const placeholder = (): string =>
    props.planOpen ? "Tell Claude what to change…" : placeholderFor(props.mode ?? "");

  /** What Send's tooltip warns of, when a send would do more than send. */
  const sendTitle = (): string | undefined => {
    if (props.planOpen)
      return "Send (Enter). Tells Claude what to change in its plan, and it keeps planning";
    if (props.asking)
      return "Send (Enter). Answers the question Claude is asking with what you typed";
    return undefined;
  };

  return (
    <div
      class="tl-composer"
      data-status={props.live ? (props.live.waiting ? "waiting" : "working") : undefined}
      data-danger={danger() ? "" : undefined}
    >
      <Show when={props.pending.length > 0}>
        <PermissionPanel pending={props.pending} onResolve={props.onResolve} />
      </Show>
      <StatusLine
        live={props.live}
        background={props.background}
        inertReason={props.inertReason}
        clearing={props.planClearing}
        onStop={props.onStop}
        onTakeControl={props.onTakeControl}
      >
        <Show when={dials().length > 0}>
          <DialBar dials={dials()} sheetTitle="This session" />
        </Show>
      </StatusLine>
      <PromptField
        textSize={props.textSize}
        onSend={send}
        label="Message to send to the session"
        placeholder={placeholder()}
        history={props.history}
        onListDir={props.onListDir}
        commands={props.commands}
        commandsOk={props.commandsOk}
        draftKey={props.session}
        onAttach={props.onAttach}
        inertReason={props.inertReason}
        onCycleMode={props.onCycleMode}
        onEmptyDigit={onEmptyDigit}
        register={props.register}
        // Hidden while the plan card is up: that send answers the dialog, and
        // the live row can still say working before the plan call is recorded.
        queueHint={working() && !props.planOpen}
        trayNote="Images join this session's gallery"
        sendTitle={sendTitle()}
      />
    </div>
  );
};
