import { createMemo, createSignal, onMount, type Component } from "solid-js";
import type { Event, PermissionDecision } from "../types/events";
import {
  currentMode,
  promptHistory,
  queuedPrompts,
  type PendingPermission,
  type QuestionRow,
} from "./timeline.logic";
import { modeFromPane } from "./compose.logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { Composer, type ComposerSinks } from "./Composer";
import type { DraftAttachment } from "../store/drafts";

/**
 * When to look at the pane after asking it to change, in ms. The CLI's status
 * line repainted 40ms after the keystroke when this was measured (2026-08-17);
 * the first delay is that with room to spare, the second is the retry.
 */
const PANE_READ_DELAYS_MS = [150, 600];

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
  /** read what the session's pane currently shows — the live permission mode. */
  onPane?: () => Promise<{ pane: string; state: string } | null>;
  /** fetch a capped tool result in full. */
  onLoadFull?: (toolId: string) => Promise<string | null>;
  /** load the window of turns before the oldest held. */
  onLoadEarlier?: () => Promise<void>;
  hasEarlier?: boolean;
  /** list a directory for `@` completion. */
  onListDir?: (dir: string) => Promise<string[]>;
  /** the session, so the composer can key its unsent draft. */
  session?: string;
  /** the effective OS user — decides which store paths render as attachments. */
  me?: string;
  /** upload files and return the ones that became attachable. */
  onAttach?: (files: File[]) => Promise<DraftAttachment[]>;
  /** watching: the controls that type, and attaching, are inert. */
  inertReason?: string;
  /** receive the composer's sinks, for gestures that land outside it. */
  register?: (api: ComposerSinks) => void;
}> = (props) => {
  const queued = createMemo(() => queuedPrompts(props.events));
  const history = createMemo(() => promptHistory(props.events));
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
   * So the pane is read at the two moments the answer can have changed without
   * a turn behind it: when this view opens, and right after the chip is pressed.
   * A pane reading holds until the transcript reports a mode of its own, at
   * which point the transcript is the fresher of the two and takes over.
   */
  const transcriptMode = createMemo(() => currentMode(props.events));
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
   * at that instant rather than leaving the chip showing the old mode.
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
  onMount(() => void readMode(""));

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
    // Shift+Tab in the CLI cycles the permission mode. One press, then the pane
    // says where it landed — the transcript will not, until the next turn.
    if (!props.onKeys || modeBusy()) return;
    setModeBusy(true);
    const was = mode();
    void props
      .onKeys(["BTab"])
      .then((ok) => (ok ? readMode(was) : undefined))
      .finally(() => setModeBusy(false));
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
        me={props.me}
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
        {...(props.onKeys ? { mode: mode(), onCycleMode: cycleMode } : {})}
        onListDir={props.onListDir}
        session={props.session}
        me={props.me}
        onAttach={props.onAttach}
        onOpenPreview={props.onOpenPreview}
        inertReason={props.inertReason}
        register={props.register}
      />
    </div>
  );
};
