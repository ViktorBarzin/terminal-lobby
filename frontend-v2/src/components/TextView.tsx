import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Component,
} from "solid-js";
import type { Event, PermissionDecision, SessionState } from "../types/events";
import {
  askingFromPane,
  currentMode,
  deriveRows,
  pendingQuestion,
  promptHistory,
  queuedPrompts,
  withPendingPrompts,
  type PendingPermission,
  type TimelineRow,
} from "./timeline.logic";
import { modeFromPane, type PendingPrompt, type SlashCommand } from "./compose.logic";
import { contextState } from "./context.logic";
import { planAnswer, runAnswer, type DraftAnswer } from "./answer.logic";
import { QuestionCard } from "./QuestionCard";
import { MessagesTimeline } from "./MessagesTimeline";
import { backgroundLabel } from "./lobby.logic";
import type { BackgroundWork } from "../types/lobby";
import { track } from "../telemetry/track";
import {
  installTextZoom,
  loadTextSize,
  saveTextSize,
  scaleFor,
} from "../mobile/textzoom";
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
  /** What the SESSION still owes, from the session list rather than the
   *  transcript. The transcript cannot answer this: it closes the turn when the
   *  main thread stops talking, and says nothing about the background agent
   *  that is still running. */
  background?: () => BackgroundWork | undefined;
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
  /** fetch a capped tool result in full. */
  onLoadFull?: (toolId: string) => Promise<string | null>;
  /** take one step further back through the transcript. */
  onLoadEarlier?: () => Promise<void>;
  hasEarlier?: boolean;
  /** what the held window cannot carry: the mode, the newest /context reading,
   *  the queue and the composer's history, folded over the whole session. */
  sessionState?: SessionState | null;
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
  /** show the Terminal view — where a question the pane can only half show has
   *  to be answered until the transcript catches up. */
  onOpenTerminal?: () => void;
}> = (props) => {
  // What the transcript says, plus what it has not caught up with.
  const sent = createMemo(() => props.pendingPrompts?.() ?? []);
  const shown = createMemo(() => withPendingPrompts(props.events, sent()));
  /** The transcript folded, once. */
  const baseRows = createMemo(() => props.rows?.() ?? deriveRows(props.events));
  /** What the timeline draws. `withPendingPrompts` returns `events` itself when
   *  nothing is in flight, so the common case reuses the fold above rather than
   *  repeating it; an unsent prompt is rare and short-lived. */
  const shownRows = createMemo(() =>
    sent().length === 0 ? baseRows() : deriveRows(shown()),
  );
  const queued = createMemo(() => queuedPrompts(props.events, props.sessionState));
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
   * So the pane is read at the two moments the answer can have changed without
   * a turn behind it: when this view opens, and right after the chip is pressed.
   * A pane reading holds until the transcript reports a mode of its own, at
   * which point the transcript is the fresher of the two and takes over.
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
  createEffect(() => {
    if (!everShown()) return;
    void readMode("");
  });

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
  /** The transcript wins wherever it has the call: it carries every question of
   *  a multi-question call, the descriptions and the multi-select flags exactly
   *  as the tool was called, and the pane only what is drawn on it. */
  const blocking = createMemo(() => recorded() ?? fromPane());
  /** A call the pane can only show part of — reported, not answered from here. */
  const partial = createMemo(() => !recorded() && (fromPane()?.partial ?? false));
  const asked = createMemo(() => blocking()?.questions ?? []);
  /**
   * WHICH question is being asked, keyed by its CONTENT rather than by the
   * transcript's tool id.
   *
   * The card walks — question, then review — and that walk is state it holds, so
   * a new question has to build a new card (a fresh single question opening on
   * the review step of the previous one would show answers chosen for something
   * nobody is being asked). Content is what makes that survive the HANDOVER: the
   * same question arrives first from the pane and then from the transcript, and
   * keying on the tool id would throw away a half-finished walk at that moment.
   */
  const asking = createMemo(() =>
    asked()
      .map((q) => `${q.header}|${q.question}|${q.options.map((o) => o.label).join(",")}`)
      .join("~"),
  );
  const [answering, setAnswering] = createSignal(false);

  // Pinch to size the transcript, the way a pinch sizes the terminal. The
  // arithmetic and the guards are ported from term.html so both views answer
  // the gesture identically; see mobile/textzoom.ts. The size is device-local,
  // and it is published as a scale the transcript zooms by rather than as a
  // font-size on one element: every font-size in app.css multiplies itself by
  // this, so the transcript, the answer card and the composer follow one pinch
  // together.
  const [textSize, setTextSize] = createSignal(loadTextSize());
  const [sizing, setSizing] = createSignal<number | null>(null);
  let viewEl: HTMLDivElement | undefined;
  onMount(() => {
    const stop = installTextZoom({
      surface: () => viewEl?.querySelector<HTMLElement>(".tl-timeline") ?? null,
      get: textSize,
      set: (n) => {
        setTextSize(n);
        saveTextSize(n);
      },
      onReadout: setSizing,
    });
    onCleanup(stop);
  });
  /** A send stopped partway, leaving the dialog half-answered — see the card's
   *  `stopped` prop. Keyed to the question it happened on, so the NEXT question
   *  starts clean rather than inheriting the last one's failure. */
  const [stoppedOn, setStoppedOn] = createSignal<string | null>(null);

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
    if (!q || partial() || !props.onKeys || answering()) return;
    const steps = planAnswer(q.questions, answers);
    if (steps.length === 0) return;
    setAnswering(true);
    // Which step the sequence reached, so a failure can say WHERE it stopped.
    // runAnswer walks the plan in order and stops at the first step that does
    // not verify, so the count of completed key batches locates it.
    let reached = 0;
    let paneReads = 0;
    const res = await runAnswer(steps, {
      keys: async (batch: string[]) => {
        reached = Math.max(reached, steps.findIndex((st) => st.batches.includes(batch)) + 1);
        return props.onKeys!(batch);
      },
      text: async (t: string) => (await props.onAnswerText?.(t)) ?? false,
      pane: async () => {
        paneReads += 1;
        return (await props.onPane?.())?.pane ?? null;
      },
    });
    setAnswering(false);
    // Default-on, and deliberately content-free: a dialog can quote anything the
    // session was working on, so this records the SHAPE of the failure and where
    // it stopped, never what was on screen. Nothing about this path was recorded
    // before, which is why a report of it could only be answered with guesses.
    const shape = {
      "tl.multi": q.questions.some((x) => x.multiSelect),
      "tl.questions": q.questions.length,
      "tl.options": q.questions[0]?.options.length ?? 0,
      "tl.steps": steps.length,
      "tl.source": recorded() ? "transcript" : "pane",
    };
    if (res.ok) {
      track("text.answer_sent", shape);
    } else {
      track("text.answer_failed", {
        ...shape,
        "tl.reason": res.reason ?? "unknown",
        "tl.step": reached,
        "tl.pane_read": paneReads,
        // The LENGTH of what we were looking for, not the text.
        "tl.expect_len": steps[Math.max(0, reached - 1)]?.expect?.length ?? 0,
      });
    }
    if (!res.ok) {
      // Latch. Some keys landed and the pane has moved on, so the plan this card
      // is holding no longer describes what is on screen — pressing Send again
      // would answer question 1 into question 2.
      setStoppedOn(asking());
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
  const context = createMemo(() => contextState(props.events, props.sessionState));

  // The catalogue is files on disk; one read when the view opens is enough.
  const [commands, setCommands] = createSignal<SlashCommand[]>([]);
  createEffect(() => {
    if (!everShown()) return;
    void props.onCommands?.().then(setCommands);
  });

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
      <MessagesTimeline
        opening={props.opening}
        owns={props.onScreen !== false}
        events={shown()}
        rows={shownRows()}
        onOpenPreview={props.onOpenPreview}
        onLoadFull={props.onLoadFull}
        onLoadEarlier={props.onLoadEarlier}
        hasEarlier={props.hasEarlier}
        me={props.me}
      />
      {/* The transcript closes the turn when the main thread stops talking, so
          the working row goes with it — while a background agent or a workflow
          it launched keeps running and will write into this same conversation
          minutes later. This strip covers exactly that gap: shown only when the
          session owes something AND no turn is open, so it never doubles up
          with the working row. */}
      <Show when={!props.working && backgroundLabel(props.background?.())}>
        {(what) => (
          <div class="tl-bg-strip" role="status">
            <span class="tl-state-dot tl-state-running" aria-hidden="true" />
            Still working in the background: {what()}
          </div>
        )}
      </Show>
      {/* Docked, not inline: on a phone the timeline scrolls and the keyboard
          covers it, and a walk that slides out from under a thumb mid-answer is
          worse than no walk. The permanent record is the inline row, which
          appears the moment the transcript carries the result. */}
      {/* KEYED on the question. The card walks — one question at a time, then a
          review — and that walk is state it holds. Reusing the card across two
          calls carried the walk over: a fresh single question opened on the
          REVIEW step of the previous one, showing answers chosen for something
          nobody was being asked any more, and Send would have typed them into
          the live dialog. A new question builds a new card.

          The child MUST take an argument: Solid only calls a `keyed` child as a
          factory when its arity is above zero, and a zero-arg one is cached as a
          static child — which is the reuse this exists to prevent. */}
      <Show when={props.onKeys ? asking() : ""} keyed>
        {(_asking) => (
          <QuestionCard
            questions={asked()}
            onSend={sendAnswers}
            onChat={focusComposer}
            busy={answering()}
            stopped={stoppedOn() !== null && stoppedOn() === asking()}
            partial={partial()}
            headers={fromPane()?.headers ?? []}
            count={fromPane()?.count ?? asked().length}
            onTerminal={props.onOpenTerminal}
          />
        )}
      </Show>
      <Composer
        working={props.working}
        textSize={textSize()}
        // Send stays available while a question is docked — ADR-0010's "whoever
        // answers first wins" — but it says what it will cost: a prompt takes
        // the dialog down and Claude asks again. `asking()` is the same signal
        // the card itself is keyed on, so the two cannot disagree.
        asking={!!asking()}
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
