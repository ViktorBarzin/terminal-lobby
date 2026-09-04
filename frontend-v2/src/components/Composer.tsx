import { For, Show, type Component } from "solid-js";
import type { PermissionDecision } from "../types/events";
import { MAX_QUEUED_SHOWN, type PendingPermission } from "./timeline.logic";
import { PermissionPanel } from "./PermissionPanel";
import { modeLabel, type SlashCommand } from "./compose.logic";
import type { DraftAttachment } from "../store/drafts";
import { ContextMeter } from "./ContextMeter";
import type { ContextState } from "./context.logic";
import { PromptField, type PromptFieldSinks } from "./PromptField";

/**
 * The LIVE session's composer: everything that only means something once there
 * is a session to talk to, docked around the shared writing surface.
 *
 * Above the field: the permission panel, and Claude's own records of prompts it
 * has queued. On the bar: the permission-mode chip, the context meter and Stop.
 * The field itself, the attachment tray, `/` and `@` completion, drafts, ↑
 * history and the Enter/Shift+Enter contract are `PromptField`, shared with the
 * new-session composer.
 *
 * Send is always offered; Stop joins it while a turn is in flight (Stop =
 * inject ESC/Ctrl-C into the pty). Sending mid-turn QUEUES the prompt — Claude
 * Code queues typed input itself, and the queued chips above the field are its
 * own records of having done so. When a permission is pending and the input is
 * empty, 1 approves / 2 denies (T3 number-key affordance).
 *
 * Sending goes through ONE route on every device: `onSend` (the session control
 * channel, session-events /prompt). It used to fork on `sendToTerminal` for a
 * coarse pointer and post the bytes into the terminal IFRAME instead — and in
 * Text mode that iframe has not attached yet, because the attach is
 * deliberately lazy. sendBytesToFrame returns false with no contentWindow and
 * nothing upstream looked at the result, so the field was cleared and the
 * message went nowhere: typing on a phone, pressing send, and watching the text
 * vanish. The control channel needs no attached iframe, is the same path the
 * desktop has always used, and reports whether it landed.
 */
/** What a caller outside the composer may put into the message being written. */
export type ComposerSinks = PromptFieldSinks;

export const Composer: Component<{
  /** The text view's pinch size, forwarded to the field. */
  textSize?: number;
  /** A turn is in flight, so there is something to Stop. NOT a reason to
   *  withhold Send: it is derived from the transcript and lags the pane, and a
   *  mid-turn send queues rather than failing. */
  working: boolean;
  /** Claude is asking a blocking question right now. Sending a prompt takes the
   *  dialog down and Claude re-asks, so Send says so — it does not refuse.
   *  ADR-0010: whoever answers first wins; the pane and this view are two
   *  windows onto one process. */
  asking?: boolean;
  pending: PendingPermission[];
  /** resolves false when the session refused the prompt (5xx, unreachable),
   *  which puts the typed text back in the field. */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onResolve: (reqId: string, decision: PermissionDecision) => void;
  /** Forward raw pty bytes to the live terminal iframe. No longer used for
   *  SENDING — kept for callers that hand bytes to the pty for other reasons,
   *  e.g. answering a prompt the transcript cannot express. */
  sendToTerminal?: (bytes: string) => void;
  /** Prompts already sent in this session, oldest first (↑ recalls them). */
  history?: string[];
  /** Prompts Claude has queued but not yet started. */
  queued?: string[];
  /** The permission mode in force, shown as a chip. */
  mode?: string;
  /** The newest `/context` reading, shown as a fill chip beside the mode. */
  context?: ContextState;
  /** Cycle the permission mode (Shift+Tab in the CLI). */
  onCycleMode?: () => void;
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
  /** Effective OS user, so a tray thumbnail knows it may fetch its own store. */
  me?: string;
  /**
   * Upload these files and return what became attachable. The uploader decides:
   * a document over the store cap stays an ephemeral /tmp transfer and comes back
   * absent from the result, which is why this returns a list rather than one item
   * per input file.
   */
  onAttach?: (files: File[]) => Promise<DraftAttachment[]>;
  /** Open one attachment in the file preview overlay. */
  onOpenPreview?: (path: string) => void;
  /** Watching: the controls that type are inert, and so is attaching. */
  inertReason?: string;
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

  return (
    <div class="tl-composer">
      <Show when={props.pending.length > 0}>
        <PermissionPanel pending={props.pending} onResolve={props.onResolve} />
      </Show>
      <Show when={(props.queued?.length ?? 0) > 0}>
        <div class="tl-queued">
          <For each={(props.queued ?? []).slice(0, MAX_QUEUED_SHOWN)}>
            {(q) => (
              <div class="tl-queued-item" title={q}>
                <span class="tl-queued-chip">queued</span>
                <span class="tl-queued-text">{q}</span>
              </div>
            )}
          </For>
          <Show when={(props.queued?.length ?? 0) > MAX_QUEUED_SHOWN}>
            <div class="tl-queued-item tl-queued-more">
              +{(props.queued?.length ?? 0) - MAX_QUEUED_SHOWN} more waiting
            </div>
          </Show>
        </div>
      </Show>
      <PromptField
        textSize={props.textSize}
        onSend={props.onSend}
        label="Message to send to the session"
        history={props.history}
        onListDir={props.onListDir}
        commands={props.commands}
        commandsOk={props.commandsOk}
        draftKey={props.session}
        me={props.me}
        onAttach={props.onAttach}
        onOpenPreview={props.onOpenPreview}
        inertReason={props.inertReason}
        onCycleMode={props.onCycleMode}
        onEmptyDigit={onEmptyDigit}
        register={props.register}
        sendTitle={
          props.asking
            ? "Send — this will dismiss the question Claude is asking, and it will ask again"
            : undefined
        }
        leftExtra={
          <Show when={props.mode && props.onCycleMode}>
            <button
              type="button"
              class="tl-mode-chip"
              // The mode is the chip's whole meaning, so it drives the colour
              // from CSS rather than a second mapping in here.
              data-mode={props.mode}
              title={`Permission mode: ${modeLabel(props.mode ?? "")} (Shift+Tab)`}
              onClick={() => props.onCycleMode?.()}
            >
              {modeLabel(props.mode ?? "")}
            </button>
          </Show>
        }
        rightExtra={
          <>
            <Show when={props.context}>{(ctx) => <ContextMeter state={ctx()} />}</Show>
            <Show when={props.working}>
              <button type="button" class="tl-stop" onClick={() => props.onStop()}>
                Stop
              </button>
            </Show>
          </>
        }
      />
    </div>
  );
};
