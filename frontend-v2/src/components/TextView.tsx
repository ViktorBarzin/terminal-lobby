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
  currentModel,
  deriveRows,
  pendingQuestion,
  promptHistory,
  queuedPrompts,
  withPendingPrompts,
  type PendingPermission,
  type TimelineRow,
} from "./timeline.logic";
import { modeFromPane, type PendingPrompt, type SlashCommand } from "../logic/compose.logic";
import type { Catalogue } from "../store/catalogue";
import { contextState } from "./context.logic";
import type {
  AnswerRequest,
  AnswerResponse,
  DialogOptionView,
  DialogQuestionView,
  DialogView,
} from "../lib/answer-api";
import type { Question } from "./canonicalize";
import { QuestionCard } from "./QuestionCard";
import { MessagesTimeline } from "./MessagesTimeline";
import { backgroundLabel } from "./lobby.logic";
import type { BackgroundWork } from "../types/lobby";
import {
  installTextZoom,
  loadTextSize,
  saveTextSize,
  scaleFor,
} from "../mobile/textzoom";
import { Composer, type ComposerSinks } from "./Composer";
import type { DraftAttachment } from "../store/drafts";
import {
  isCurrentModel,
  type ModelField,
  type ModelHarness,
  type ModelState,
} from "../lib/models";
import type { SetModelResult } from "../lib/model-api";

/**
 * A model reading, as one comparable string.
 *
 * The applied reading holds only until the TRANSCRIPT moves, and this is how it
 * notices: the reading is stored alongside the transcript's value at the moment
 * it was taken, and it simply stops matching when a turn writes a new one. The
 * same trick the permission-mode chip uses for its pane reading, and it needs
 * no bookkeeping to expire.
 */
const modelKey = (m: ModelState | undefined): string =>
  `${m?.model ?? ""}/${m?.effort ?? ""}`;

/**
 * When to look at the pane after asking it to change, in ms. The CLI's status
 * line repainted 40ms after the keystroke when this was measured (2026-08-17);
 * the first delay is that with room to spare, the second is the retry.
 *
 * This is the permission-mode chip's own read-back, and the last one left in
 * this file. Answering a dialog no longer waits on the pane from here: the
 * server types, captures and verifies in one local sequence and replies with
 * the reading (sessionio/answerdrive.go).
 */
const PANE_READ_DELAYS_MS = [150, 600];

/**
 * Text mode — the PRIMARY view. Structured transcript render (MessagesTimeline)
 * above a composer with the docked permission panel.
 *
 * It also owns the upward half of ADR-0010: a blocking prompt is mirrored from
 * the transcript (a question) or from the pane (a permission dialog), and the
 * answer goes back into the same pty. A permission decision and the mode chip
 * go as keys from here. A QUESTION does not, since 2026-09-10: each choice is
 * one request to the server, which types beside the parser and replies with a
 * reading of the screen that resulted (docs/plans/2026-09-10-text-mode-
 * answers-dialogs-design.md).
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
  /** type keys into the session's pane — the permission-mode chip's Shift+Tab. */
  onKeys?: (keys: string[]) => Promise<boolean>;
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
  /** which CLI the session runs, from the session list's own `tool`. Absent
   *  for a plain shell, which has no model to pick. */
  harness?: ModelHarness | null;
  /** put the session on a model or an effort level, and say what happened. */
  onSetModel?: (choice: { model: string; effort: string }) => Promise<SetModelResult>;
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
  /**
   * The watcher's current reading, as one comparable string.
   *
   * It answers one question only: has the watcher said anything NEW since a
   * reply was stored. The watcher appends a reading when the reading CHANGES,
   * so the content of the last one it reported is the whole of its identity —
   * there is no sequence number on the wire to use instead, and the event id
   * moves for reasons that have nothing to do with the dialog.
   */
  const paneKey = createMemo(() => {
    const p = fromPane();
    if (!p) return "";
    const q = p.questions[0];
    const labels = q?.options.map((o) => o.label).join(",") ?? "";
    return [p.count, p.answered, q?.header ?? "", q?.question ?? "", labels].join("|");
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
   * WHICH CALL is being answered, keyed by its CONTENT rather than by the
   * transcript's tool id.
   *
   * It tells one call from the next, which is what the card and the reading
   * below both hang off: neither may outlive the call it describes. Content is
   * what makes that survive the HANDOVER — the same question arrives first
   * from the pane and then from the transcript, and keying on the tool id
   * would throw both away at that moment for no reason, since the pane's
   * reading has no tool id at all.
   */
  const asking = createMemo(() =>
    asked()
      .map((q) => `${q.header}|${q.question}|${q.options.map((o) => o.label).join(",")}`)
      .join("~"),
  );
  const [answering, setAnswering] = createSignal(false);

  /**
   * The newest reading the server sent back, and the card it was taken for.
   *
   * The same pairing the mode and model chips above use: a reading is stored
   * with the value it was taken against and stops counting the moment that
   * value moves, so nothing has to expire it. Here the pair is exact rather
   * than convenient — `asking()` is what the card is keyed on, so a reading
   * lives exactly as long as the card that asked for it, and a reply arriving
   * after the session has moved to another call renders on nothing.
   */
  const [replied, setReplied] = createSignal<{
    at: string;
    pane: string;
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
    if (r.at === asking()) return r.resp;
    // The HANDOVER is the exception. The same dialog arrives first from the
    // pane and then from the transcript, which changes the key without
    // changing what is on screen — the pane's reading has no per-question
    // header and the record does. A reading whose drawn question is one of
    // the call's own still describes the call, so it survives that; anything
    // else is a reading of a call nobody is being asked any more.
    const q = r.resp.dialog?.questions[0];
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
  const view = createMemo((): DialogView | null => {
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
    return { ...seen, questions: drawnQuestions(seen).map((q) => withCallContent(q, known)) };
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
  // The composer's own handle, so "Chat about this" can hand the reader the
  // message field rather than an answer they did not want to give.
  let sinks: ComposerSinks | undefined;
  const focusComposer = () => sinks?.focus();

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
  const put = async (req: AnswerRequest): Promise<void> => {
    if (!props.onAnswer || answering()) return;
    // Stamped with the card that asked, taken BEFORE the await: a reply that
    // lands after the session has moved to another call describes neither, and
    // pairing it with the key it was sent under is what drops it.
    const at = asking();
    setAnswering(true);
    let resp: AnswerResponse | null;
    try {
      resp = await props.onAnswer(req);
    } finally {
      setAnswering(false);
    }
    if (!resp) {
      // The CALL failed — no reply, so there is nothing to render and no way
      // to know whether the keys landed. Deliberately not "nothing was typed":
      // a dropped reply cannot tell us that, and the next request re-reads the
      // pane anyway, as does the watcher within its 2s tick.
      props.notify?.("Couldn't reach the session to answer that.", "error");
      return;
    }
    // `pane` is read HERE rather than next to `at`, so it is the watcher's
    // last word as of the reply landing. A tick that fired while the request
    // was in flight was captured before the keys went in, and counting it as
    // news would hand the card back the question that has just been answered.
    setReplied({ at, pane: paneKey(), resp });
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
  // package's own tests, sending exactly what they sent before.
  const chooseOption = (header: string, choices: string[], text?: string): Promise<void> =>
    put({
      header: header || callAddress(),
      ...(choices.length === 1 ? { choice: choices[0] } : { choices }),
      ...(text ? { text } : {}),
    });
  const goBackTo = (header: string): Promise<void> => put({ back: header });
  const submitAnswers = (): Promise<void> => put({ submit: true });
  const pressKeys = (keys: string[]): Promise<void> => put({ keys });

  // How full the context is, from the CLI's own `/context` reading — whenever
  // one is in the transcript, because somebody ran the command. Nothing injects
  // it and nothing here computes a context size: the ceiling is not on the wire
  // and is not a constant.
  const context = createMemo(() => contextState(props.events, props.sessionState));

  /**
   * What the session is answering as.
   *
   * Two sources, for the same reason the permission-mode chip has two. The
   * TRANSCRIPT is authoritative and is what an arriving reader has, but it only
   * moves when a turn ends, so a change made from the chip would not show until
   * the session next answered. The APPLY reports what the session said about
   * itself immediately afterwards, and that reading holds until the transcript
   * reports a pair of its own.
   */
  const transcriptModel = createMemo(() => currentModel(props.events, props.sessionState));
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
   * the account's settings pins one and the slider still moves — so a chip
   * that trusted the request would show a level the session is not on
   * (lib/model-api.ts).
   */
  const pickModel = (field: ModelField, id: string): void => {
    if (!props.onSetModel || modelBusy()) return;
    const want = { model: field === "model" ? id : "", effort: field === "effort" ? id : "" };
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
        // report one. Replacing wholesale blanked half the chip until the
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
          field === "model"
            ? isCurrentModel(props.harness ?? "claude", id, got)
            : got === id;
        if (got && !took) {
          props.notify?.(
            `The session stayed on ${got} — something on the box pins it`,
            "error",
          );
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
      {/* KEYED on the question's CONTENT, which is how one CALL is told from
          the next. The card holds state of its own — a half-typed free-text
          answer, which row is being tapped — and reusing it across two calls
          carried that over: a fresh single question opened showing what had
          been chosen for something nobody was being asked any more.

          Content-keying is also what carries the card through the HANDOVER,
          where the same question arrives first from the pane and then from the
          transcript; keying on the tool id would rebuild it at that moment for
          no reason. It costs a rebuild each time a PANE-read call draws its
          next question, which is the same moment `reading()` stops matching,
          so the card and its reading begin and end together.

          The child MUST take an argument: Solid only calls a `keyed` child as a
          factory when its arity is above zero, and a zero-arg one is cached as a
          static child — which is the reuse this exists to prevent. */}
      <Show when={props.onAnswer ? asking() : ""} keyed>
        {(_asking) => (
          <QuestionCard
            dialog={view()}
            pane={reading()?.pane}
            review={review()}
            busy={answering()}
            onChoose={chooseOption}
            onBack={goBackTo}
            onSubmit={submitAnswers}
            onKeys={pressKeys}
            onChat={focusComposer}
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
        {...(props.harness && props.onSetModel
          ? { harness: props.harness, onPickModel: pickModel }
          : {})}
        {...(modelState() ? { model: modelState()! } : {})}
        modelBusy={modelBusy()}
        onListDir={props.onListDir}
        commands={commands()}
        commandsOk={catalogueOk()}
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
  const qs: DialogQuestionView[] | null = d.questions;
  if (!qs) return [];
  return qs.map((q) => {
    const options: DialogOptionView[] | null = q.options;
    return options ? q : { ...q, options: [] };
  });
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
 * Nothing is invented: a question that cannot be placed is returned exactly as
 * it was drawn, and the reader still gets the screen and its options.
 */
function withCallContent(drawn: DialogQuestionView, known: Question[]): DialogQuestionView {
  const from = placeQuestion(drawn, known);
  if (!from) return drawn;
  return {
    ...drawn,
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

/**
 * The question the pane drew and one from the call, as the same question.
 *
 * Mirrors sessionio's `answerSameQuestion`, numbers included, because they are
 * measured rather than chosen: the drawn side loses a trailing ellipsis (the
 * CLI's mark for "there was more of this"), and a question too long for the
 * dialog is compared on its first 40 characters, of which at least 12 have to
 * be on screen for the comparison to mean anything.
 */
function sameDrawnQuestion(drawn: string, known: string): boolean {
  const d = normalizeDrawn(drawn).replace(/[…. ]+$/, "");
  const k = normalizeDrawn(known);
  if (!d || !k) return false;
  if (k.includes(d) || d.includes(k)) return true;
  const dh = comparablePrefix(d);
  return dh !== "" && dh === comparablePrefix(k);
}

/** Lower-cased, with the terminal's own drawing and every run of space gone. */
function normalizeDrawn(s: string): string {
  return s
    .replace(/[─-╿❯|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The first 40 characters, or "" when fewer than 12 are there to compare. */
function comparablePrefix(s: string): string {
  const runes = [...s];
  return runes.length < 12 ? "" : runes.slice(0, 40).join("");
}
