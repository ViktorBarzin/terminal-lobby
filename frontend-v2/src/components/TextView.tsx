import { createMemo, createSignal, onMount, Show, type Component } from "solid-js";
import type { Event, PermissionDecision } from "../types/events";
import {
  currentMode,
  deriveRows,
  pendingQuestion,
  promptHistory,
  queuedPrompts,
  withPendingPrompts,
  type PendingPermission,
} from "./timeline.logic";
import { modeFromPane, type PendingPrompt, type SlashCommand } from "./compose.logic";
import { contextState } from "./context.logic";
import { planAnswer, runAnswer, type DraftAnswer } from "./answer.logic";
import { QuestionCard } from "./QuestionCard";
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
  /** type free text into the pane WITHOUT submitting it, for an "Other" answer. */
  onAnswerText?: (text: string) => Promise<boolean>;
  /** surface a failed answer sequence to the app's toast stack. */
  notify?: (message: string, kind: "info" | "error" | "warning" | "success") => void;
  /** the session's own skills / custom commands, for the `/` menu. */
  onCommands?: () => Promise<SlashCommand[]>;
  /** prompts sent from here the transcript has not shown yet. */
  pendingPrompts?: () => PendingPrompt[];
  /** the opening window is still arriving. */
  opening?: boolean;
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
  // What the transcript says, plus what it has not caught up with.
  const shown = createMemo(() =>
    withPendingPrompts(props.events, props.pendingPrompts?.() ?? []),
  );
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
  const blocking = createMemo(() => pendingQuestion(deriveRows(props.events)));
  const [answering, setAnswering] = createSignal(false);

  // The composer's own handle, so "Chat about this" can hand the reader the
  // message field rather than an answer they did not want to give.
  let sinks: ComposerSinks | undefined;
  const focusComposer = () => sinks?.focus();

  /**
   * Send the assembled answers, checking the pane between questions.
   *
   * Nothing has been typed until this runs, so up to here the dialog is
   * untouched. From here the sequence stops the moment the pane stops matching
   * what the plan expected, rather than typing the remaining answers into
   * whatever screen is actually there — a half-answered dialog can be finished
   * in the Terminal, and a wrong answer submitted unseen cannot be taken back.
   */
  const sendAnswers = async (answers: DraftAnswer[]): Promise<void> => {
    const q = blocking();
    if (!q || !props.onKeys || answering()) return;
    const steps = planAnswer(q.questions, answers);
    if (steps.length === 0) return;
    setAnswering(true);
    const res = await runAnswer(steps, {
      keys: props.onKeys,
      text: async (t: string) => (await props.onAnswerText?.(t)) ?? false,
      pane: async () => (await props.onPane?.())?.pane ?? null,
    });
    setAnswering(false);
    if (!res.ok) {
      props.notify?.(
        res.reason === "refused"
          ? `The session refused the answer while ${res.what}.`
          : res.reason === "unreadable"
            ? `Couldn't read the session's screen while ${res.what} — finish it in Terminal.`
            : `The dialog moved while ${res.what} — finish it in Terminal.`,
        "error",
      );
    }
  };

  // How full the context is, from the CLI's own `/context` reading — whenever
  // one is in the transcript, because somebody ran the command. Nothing injects
  // it and nothing here computes a context size: the ceiling is not on the wire
  // and is not a constant.
  const context = createMemo(() => contextState(props.events));

  // The catalogue is files on disk; one read when the view opens is enough.
  const [commands, setCommands] = createSignal<SlashCommand[]>([]);
  onMount(() => void props.onCommands?.().then(setCommands));

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
        opening={props.opening}
        events={shown()}
        onOpenPreview={props.onOpenPreview}
        onLoadFull={props.onLoadFull}
        onLoadEarlier={props.onLoadEarlier}
        hasEarlier={props.hasEarlier}
        me={props.me}
      />
      {/* Docked, not inline: on a phone the timeline scrolls and the keyboard
          covers it, and a walk that slides out from under a thumb mid-answer is
          worse than no walk. The permanent record is the inline row, which
          appears the moment the transcript carries the result. */}
      <Show when={blocking() && props.onKeys}>
        <QuestionCard
          questions={blocking()!.questions}
          onSend={sendAnswers}
          onChat={focusComposer}
          busy={answering()}
        />
      </Show>
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
        {...(context() ? { context: context()! } : {})}
        onListDir={props.onListDir}
        commands={commands()}
        session={props.session}
        me={props.me}
        onAttach={props.onAttach}
        onOpenPreview={props.onOpenPreview}
        inertReason={props.inertReason}
        register={(api) => {
          sinks = api;
          props.register?.(api);
        }}
      />
    </div>
  );
};
