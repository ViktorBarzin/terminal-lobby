import { createMemo, createSignal, type Component } from "solid-js";
import type { Event, PermissionDecision } from "../types/events";
import {
  currentMode,
  promptHistory,
  queuedPrompts,
  type PendingPermission,
  type QuestionRow,
} from "./timeline.logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { Composer } from "./Composer";

/**
 * Text mode — the PRIMARY view. Structured transcript render (MessagesTimeline)
 * above a composer with the docked permission panel.
 *
 * It also owns the upward half of ADR-0010: a blocking prompt is mirrored from
 * the transcript (a question) or from the pane (a permission dialog), and the
 * answer goes back as keystrokes into the same pty.
 */
export const TextView: Component<{
  events: Event[];
  working: boolean;
  pending: PendingPermission[];
  /** resolves false when the session refused the prompt (the composer keeps it). */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onResolve: (reqId: string, decision: PermissionDecision) => void;
  /** Mobile: forward composed bytes to the live pty (bracketed paste + submit). */
  sendToTerminal?: (bytes: string) => void;
  /** open a file path in the preview overlay (transcript Read/Edit/Write rows). */
  onOpenPreview?: (path: string) => void;
  /** type keys into the session's pane — how an answer is delivered. */
  onKeys?: (keys: string[]) => Promise<boolean>;
  /** fetch a capped tool result in full. */
  onLoadFull?: (toolId: string) => Promise<string | null>;
  /** load the window of turns before the oldest held. */
  onLoadEarlier?: () => Promise<void>;
  hasEarlier?: boolean;
  /** list a directory for `@` completion. */
  onListDir?: (dir: string) => Promise<string[]>;
  /** attach an image and get back the path to reference. */
  onAttachImage?: (file: File) => Promise<string | null>;
}> = (props) => {
  const mode = createMemo(() => currentMode(props.events));
  const queued = createMemo(() => queuedPrompts(props.events));
  const history = createMemo(() => promptHistory(props.events));
  const [modeBusy, setModeBusy] = createSignal(false);

  /**
   * Answering a question: the option's ordinal is what the TUI's menu reads, so
   * the answer is the digit and an Enter. The options themselves came from the
   * transcript, so only the SELECTION is inferred — the low-risk half of
   * ADR-0010.
   */
  const answerQuestion = (_row: QuestionRow, optionIndex: number) => {
    if (!props.onKeys) return;
    // The menu opens on the first option, so N presses of Down then Enter picks
    // the Nth — more robust than assuming digits select, which they do not in
    // every dialog.
    const keys = [
      ...Array.from({ length: optionIndex }, () => "Down"),
      "Enter",
    ];
    void props.onKeys(keys.slice(0, 8));
  };

  const cycleMode = () => {
    // Shift+Tab in the CLI cycles the permission mode. One press, then the
    // transcript's own `permission-mode` record confirms where it landed.
    if (!props.onKeys || modeBusy()) return;
    setModeBusy(true);
    void props.onKeys(["BTab"]).finally(() => setModeBusy(false));
  };

  return (
    <div class="tl-textview">
      <MessagesTimeline
        events={props.events}
        onOpenPreview={props.onOpenPreview}
        onLoadFull={props.onLoadFull}
        onAnswer={answerQuestion}
        onLoadEarlier={props.onLoadEarlier}
        hasEarlier={props.hasEarlier}
      />
      <Composer
        working={props.working}
        pending={props.pending}
        onSend={props.onSend}
        onStop={props.onStop}
        onResolve={props.onResolve}
        sendToTerminal={props.sendToTerminal}
        history={history()}
        queued={queued()}
        {...(props.onKeys ? { mode: mode() || "default", onCycleMode: cycleMode } : {})}
        onListDir={props.onListDir}
        onAttachImage={props.onAttachImage}
      />
    </div>
  );
};
