import { For, Show, createMemo, createSignal, type Component } from "solid-js";
import {
  FREE_TEXT_LABEL,
  answerableOptions,
  isFreeText,
  type DialogOptionView,
  type DialogQuestionView,
  type DialogView,
} from "../lib/answer-api";
import { PaneKeypad } from "./PaneKeypad";

/**
 * The card that answers a blocking AskUserQuestion, docked above the composer.
 *
 * IT HOLDS NOTHING ABOUT THE DIALOG. One reading comes in, one question is
 * drawn, and a tap on an option is a request. There is no draft, no plan, no
 * Next and no local idea of where in the call the reader is — the reply to
 * every request is a fresh reading of the pane, and that is what gets drawn
 * next. The one exception is the free-text field's half-typed words, which
 * exist nowhere else until they are sent, and those are stamped with the
 * question they were typed for so they cannot be committed against another
 * one.
 *
 * WHY IT IS SHAPED THIS WAY. The card used to walk: four questions, a draft
 * per question, a review, and a Send that typed the lot while predicting what
 * each next screen would say. Over 10 days of field data four-question answers
 * failed 4 times in 5, and all six failures were the same thing — the
 * prediction missed and the walk stopped, leaving the dialog half-answered
 * (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md). Removing the
 * prediction meant removing the state it was computed from, so what is left
 * here is a renderer.
 *
 * The consequence worth knowing: a choice commits when you make it. The CLI's
 * own review screen at the end is still where everything can be seen before
 * submitting, and the chips walk ← back to any question already answered,
 * where the CLI redraws the previous pick with a trailing tick.
 *
 * It docks rather than sitting in the timeline because on a phone the timeline
 * scrolls and the keyboard covers it; the permanent record of what was asked
 * and chosen is the inline row, which appears once the transcript records the
 * answer.
 */
export const QuestionCard: Component<{
  /** What the pane is drawing right now, or null when it could not be read. */
  dialog: DialogView | null;
  /** The raw capture, present only when `dialog` is null. */
  pane?: string;
  /** The pane is on the review screen, where the only action left is Submit. */
  review?: boolean;
  /** A request is in flight. */
  busy: boolean;
  /** Answer the question `header` names with the labels it should be left
   *  holding, plus free text for the CLI's "Type something" row. One label
   *  for a single-select; for a multi-select it is the DESIRED FINAL STATE,
   *  which is what makes a second pick add rather than replace. */
  onChoose: (header: string, choices: string[], text?: string) => Promise<void>;
  /** Walk ← back to an already-answered question. */
  onBack: (header: string) => Promise<void>;
  /** Press the review screen's Submit. */
  onSubmit: () => Promise<void>;
  /** Raw keys, for a screen the parser could not read. */
  onKeys: (keys: string[]) => Promise<void>;
  /** Pick "Chat about this" — defer the question and type instead. */
  onChat: () => void;
  /** Show the Terminal view. */
  onTerminal?: () => void;
}> = (props) => {
  /** Show every description in full rather than the two-line summary. The clamp
   *  is the default because choosing between four options wants four summaries;
   *  this is for the reader who wants the whole of all of them at once, which
   *  choosing each in turn is a poor way to get. */
  const [full, setFull] = createSignal(false);
  /** The label of the row whose request is in flight, or null. */
  const [sending, setSending] = createSignal<string | null>(null);
  /**
   * The free-text row's field and what has been typed into it, STAMPED WITH
   * THE QUESTION IT WAS TYPED FOR.
   *
   * It has to be stamped. As a plain pair of signals it outlived the reading
   * that opened it: tap "Type something" on question 1, type "Mango", answer,
   * and the reply's reading of question 2 arrived into a card still holding an
   * open field, the word "Mango" and a live Answer button — one tap from
   * committing question 1's words under question 2's header. That is the same
   * "an answer nobody picked can be committed" the design set out to remove
   * (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md), rebuilt out
   * of local state. Deriving the field from the stamp instead makes it
   * impossible rather than reset after the fact.
   *
   * The stamp is the question's CONTENT and deliberately not the identity of
   * the `dialog` object. TextView's `view()` is a memo over `props.events`, so
   * a new DialogView lands on every transcript event — 200 ms apart while the
   * session is talking — and wiping the field on those would delete a reader's
   * half-typed answer under their thumb. The consequence of content-stamping:
   * walking away with ← and coming back to the same question finds the words
   * still there, which is the question they were typed for.
   */
  const [draft, setDraft] = createSignal<{ of: string; typed: string } | null>(null);

  const question = (): DialogQuestionView | null => props.dialog?.questions[0] ?? null;
  const headers = (): string[] => props.dialog?.headers ?? [];
  const answered = (): number => props.dialog?.answered ?? 0;
  const count = (): number => props.dialog?.count ?? headers().length;

  /**
   * The header that names the question on screen, which is what every request
   * is addressed by.
   *
   * A single-question dialog draws its own header (` ☐ Font`). A
   * multi-question one does not — which tab is current is drawn in colour and
   * `capture-pane -p` carries no colour — so the caller places the drawn
   * question against the call the transcript recorded and fills it in. The
   * fallback covers the one case placement is unnecessary for: a call with a
   * single chip has only one question the pane could be drawing.
   *
   * If it is empty the server refuses the request and returns what IS on
   * screen, which the card then draws. That is a wasted round trip, not a dead
   * end, and it is the whole reason requests are addressed by name instead of
   * by index.
   */
  const header = createMemo(() => {
    const own = (question()?.header ?? "").trim();
    if (own) return own;
    const only = headers();
    return only.length === 1 ? only[0]!.trim() : "";
  });

  /**
   * The chip the pane is on, or "" when it is on none of them.
   *
   * The review screen sits one past the last question, so nothing is current
   * there and every chip is a way back.
   */
  const currentHeader = createMemo(() => (props.review ? "" : header()));

  /**
   * Which question of the call the pane is drawing, as an index into the
   * chips: `headers().length` on the review screen, which sits one past the
   * last question, and -1 when the reading cannot place itself.
   *
   * This is the server's `answerPosition` (sessionio/answerdrive.go), and it
   * has to be, because it is what decides which chips are a way back: `←`
   * only walks backwards, and `leftPresses` refuses a header at or ahead of
   * where the walk is (answerplan.go). A chip the server will refuse must not
   * look tappable.
   */
  const drawnAt = createMemo(() =>
    props.review ? headers().length : headers().findIndex((h) => sameHeader(h, header())),
  );

  /**
   * The question the free-text field belongs to, as its content identifies it.
   *
   * The header alone is not enough: a call whose question is redrawn under the
   * same chip after `←` is the same question, and two calls can reuse a chip
   * name like "Scope".
   *
   * The join is `\0` rather than a visible character because the CLI can draw
   * either half with anything it likes: a header of "a" with a question of
   * "b|c" and a header of "a|b" with a question of "c" are different questions
   * and have to key differently, and no pane text can contain a NUL.
   */
  const drawnKey = createMemo(() => {
    const q = question();
    if (!q) return "";
    return `${(q.header ?? "").trim()}\0${q.question.trim()}`;
  });

  /** The free-text field is open for the question on screen. */
  const typing = createMemo(() => {
    const d = draft();
    return d !== null && drawnKey() !== "" && d.of === drawnKey();
  });
  /** What is in that field, and "" whenever the field is not this question's. */
  const text = (): string => (typing() ? draft()!.typed : "");

  /**
   * The rows this question offers, in the order and at the numbers the CLI
   * drew them.
   *
   * ParseDialog drops the CLI's own two appended rows: "Chat about this",
   * which abandons the question rather than answering it, and "Type
   * something", the free-text field. The chat row stays dropped — it is an
   * action in the footer — and the free-text row is put back at the end,
   * which is exactly where the widget draws it. Checked against the captures:
   * dialog-single.txt numbers it 3 after Sans and Serif, dialog-multi.txt
   * numbers it 4 after Apple, Pear and Plum.
   *
   * `answerableOptions` runs anyway rather than being assumed unnecessary, so
   * a server that starts sending the chat row cannot put it in front of a
   * reader as an answer.
   */
  const optionRows = createMemo<DialogOptionView[]>(() => {
    const q = question();
    if (!q || q.options.length === 0) return [];
    const rows = answerableOptions(q);
    return rows.some((o) => isFreeText(o.label)) ? rows : [...rows, { label: FREE_TEXT_LABEL }];
  });

  /**
   * What the head says about where this is.
   *
   * When the drawn question matches a chip, that is a real position and it is
   * reported as one. When it does not, `answered` is reported as the count it
   * is. It is NOT turned into "question 3 of 4": measured 2026-09-10 against
   * CLI 2.1.267, a multi-select question's tab-bar box flips to ☒ on the first
   * Space, before the Enter that leaves the question, so the tally runs one
   * ahead of the position whenever a multi-select is half-answered or a reader
   * has walked back with ←.
   */
  const step = (): string => {
    if (!props.dialog) return "screen not recognised";
    if (props.review) return "ready to submit";
    const n = count();
    if (n <= 1) return "awaiting your answer";
    const at = drawnAt();
    return at >= 0 ? `question ${at + 1} of ${n}` : `${answered()} of ${n} answered`;
  };

  /**
   * Run one request, marking the row it belongs to while it is in flight.
   *
   * The mark is local because only the card knows WHICH row was tapped;
   * `props.busy` says only that something is in flight. A failure clears the
   * mark and nothing else: the caller reports it, and the card stays usable,
   * because there is no half-typed sequence left behind to protect the reader
   * from.
   */
  const run = (mark: string, go: () => Promise<void>) => {
    if (props.busy || sending() !== null) return;
    setSending(mark);
    void go()
      .catch(() => {})
      .finally(() => setSending(null));
  };

  /**
   * The labels the READING says the question is holding, in the order the CLI
   * drew them.
   *
   * Read off the pane on every render rather than counted here. A card that
   * kept its own set would drift from the terminal the moment anything else
   * moved the dialog — a keystroke in the Terminal view, an Esc, a re-ask —
   * which is the class of local state the design removed.
   */
  const held = createMemo<string[]>(() =>
    optionRows()
      .filter((o) => o.checked === true)
      .map((o) => o.label),
  );

  /**
   * What a tap on a multi-select row asks the question to END UP holding.
   *
   * Adding, because the reading says what is already ticked: tap a second
   * fruit and both go, so the server's diff toggles only the new one. Until
   * 2026-09-11 a request carried one label and this was a replacement —
   * measured with Apple ticked and the cursor on its row, the plan for Pear
   * opened with a Space on Apple and deleted it.
   *
   * Tapping a ticked row removes it, EXCEPT when it is the only one left.
   * That is the CLI's constraint rather than a choice made here: a
   * multi-select cannot be left with nothing ticked, because Enter is what
   * leaves the question and it does not fire on an empty question
   * (sessionio/answerplan.go, measured). So the last pick re-confirms itself
   * and the question is answered with it, which is what tapping your own
   * answer has always done here.
   */
  const nextSet = (label: string): string[] => {
    const on = held();
    if (!on.includes(label)) return [...on, label];
    const without = on.filter((l) => l !== label);
    return without.length > 0 ? without : [label];
  };

  const choose = (label: string) => {
    if (isFreeText(label)) {
      setDraft({ of: drawnKey(), typed: "" });
      return;
    }
    const want = question()?.multiSelect ? nextSet(label) : [label];
    run(label, () => props.onChoose(header(), want));
  };

  const sendText = () => {
    const typed = text().trim();
    if (!typed) return;
    run(FREE_TEXT_LABEL, () => props.onChoose(header(), [FREE_TEXT_LABEL], typed));
  };

  const goBack = (name: string) => run(`back:${name}`, () => props.onBack(name));

  return (
    <Show when={props.dialog || props.pane}>
      <div class="tl-qcard" role="dialog" aria-label="Claude needs an answer">
        <div class="tl-qcard-head">
          <span class="tl-qcard-title">Claude needs answers</span>
          <Show when={!props.review && question() && hasDescriptions(question()!)}>
            <button type="button" class="tl-qcard-full" onClick={() => setFull((v) => !v)}>
              {full() ? "Show less" : "Show all"}
            </button>
          </Show>
          <span class="tl-qcard-step">{step()}</span>
        </div>

        <Show
          when={props.dialog}
          fallback={<PaneKeypad pane={props.pane ?? ""} busy={props.busy} onKeys={props.onKeys} />}
        >
          <div class="tl-qcard-body">
            {/* The tab bar, as chips. A ticked one is a box the pane draws as
                ☒, and tapping a chip BEHIND the drawn question sends ← until
                that question is back on screen. One ahead of it is not a way
                forward: the CLI reaches it by answering the ones before it.

                THE TICK AND THE TAP READ DIFFERENT THINGS, which is the point.
                `answered` is the ☒ count and nothing else — measured
                2026-09-10 against CLI 2.1.267, a multi-select's box flips on
                the FIRST Space, before the Enter that leaves the question, so
                the tally runs one ahead of the position. Using it for the tap
                made every chip between the drawn question and the tally look
                live: the server's leftPresses refuses a header that is not
                behind the walk (answerplan.go), answerBack replies
                AnswerNotDrawn with the same reading, and TextView reports
                nothing because the CALL succeeded — so the reader tapped a
                chip and the screen did not move, with no way to tell why. */}
            <Show when={headers().length > 1 || answered() > 0}>
              <div class="tl-qcard-tabs">
                <For each={headers()}>
                  {(name, i) => {
                    const current = () => sameHeader(name, currentHeader());
                    const done = () => i() < answered();
                    const reachable = () => drawnAt() >= 0 && i() < drawnAt();
                    return (
                      <button
                        type="button"
                        class="tl-qcard-tab"
                        data-done={done() ? "true" : undefined}
                        data-current={current() ? "true" : undefined}
                        disabled={!reachable() || props.busy || sending() !== null}
                        // `.tl-qcard-tab` was written for a <span>, so it sets
                        // no background and no cursor. These two keep a chip
                        // looking like a chip now that it is a button, rather
                        // than adding a rule to app.css for one element.
                        style={{
                          background: done() ? undefined : "transparent",
                          cursor: reachable() ? "pointer" : "default",
                        }}
                        onClick={() => goBack(name)}
                      >
                        {name}
                      </button>
                    );
                  }}
                </For>
              </div>
            </Show>
            <div class="tl-qcard-question">{question()?.question}</div>

            <Show when={props.review}>
              {/* Everything the review screen has to show. The capture carries
                  the headers and their boxes and not the picks themselves, so
                  this lists what was answered rather than what it was answered
                  with; a chip walks back to any of them, where the CLI redraws
                  the pick with a trailing tick. */}
              <div class="tl-qcard-review">
                <For each={headers()}>
                  {(name, i) => (
                    <div class="tl-qcard-reviewrow">
                      <span class="tl-qcard-reviewq">{name}</span>
                      <span class="tl-qcard-reviewa">{i() < answered() ? "answered" : "—"}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={!props.review && optionRows().length > 0}>
              <Show when={question()?.multiSelect}>
                {/* What actually happens, which the previous wording had
                    backwards. A tap still answers the question and the CLI
                    still moves on — the Enter is what leaves a multi-select —
                    so a second fruit means coming back. What changed on
                    2026-09-11 is that coming back now ADDS: the request
                    carries every label the question should hold, so the ticks
                    already on screen survive it. The old hint promised that
                    and the wire could not deliver it. */}
                <div class="tl-qcard-hint">
                  Each tap answers the question. Come back to add another pick; the ticked ones
                  stay.
                </div>
              </Show>
              <div class="tl-qcard-options" data-full={full() ? "true" : undefined}>
                <For each={optionRows()}>
                  {(option, i) => {
                    /* THE TICK IS THE PANE'S, not the card's. A row reads as
                       chosen when the reading says its box is filled, when
                       its request is in flight, or when it is the free-text
                       row with the field open. The first of those is what a
                       reader needs to see before tapping a second option:
                       the set that goes to the server is built from it, so
                       showing it is showing what will be kept. */
                    const multi = () => question()?.multiSelect === true;
                    const ticked = () => multi() && option.checked === true;
                    const marked = () =>
                      ticked() ||
                      sending() === option.label ||
                      (typing() && isFreeText(option.label));
                    return (
                      <button
                        type="button"
                        class="tl-qcard-option"
                        data-multi={multi() ? "true" : undefined}
                        data-chosen={marked() ? "true" : undefined}
                        aria-pressed={multi() ? ticked() : undefined}
                        aria-busy={sending() === option.label ? "true" : undefined}
                        disabled={props.busy || sending() !== null}
                        onClick={() => choose(option.label)}
                      >
                        {/* The DIALOG's number. The keystroke is the server's
                            to press now, but it is still the key the CLI is
                            listening for, and the transcript's recorded row
                            numbers its options the same way. */}
                        <span
                          class="tl-qcard-key"
                          aria-hidden="true"
                          style={{
                            // The app's existing "work is happening" grammar,
                            // borrowed from .tl-working-dot rather than given
                            // a rule of its own: the row that was tapped is
                            // the one that pulses.
                            animation:
                              sending() === option.label
                                ? "tl-pulse 1.1s ease-in-out infinite"
                                : "none",
                          }}
                        >
                          {i() + 1}
                        </span>
                        <span class="tl-qcard-label">{option.label}</span>
                        <Show when={option.description}>
                          {/* Clamped to two lines, and the marked row expands
                              (see app.css). Every description stays on screen
                              because the difference between two options
                              usually lives in them, not in the labels. */}
                          <span class="tl-qcard-desc">{option.description}</span>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </div>
              <Show when={typing()}>
                <input
                  class="tl-qcard-other"
                  type="text"
                  placeholder={FREE_TEXT_LABEL}
                  aria-label="Your own answer"
                  value={text()}
                  onInput={(e) => setDraft({ of: drawnKey(), typed: e.currentTarget.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") sendText();
                  }}
                />
              </Show>
            </Show>
          </div>
        </Show>

        {/* Wrapping, for the reason `.tl-qcard-head` wraps: there are three
            things here now that Open Terminal is permanent, and at 400px the
            row overflowed with Submit off the right edge (measured against a
            three-question review). The head has carried the same `flex-wrap`
            since the pinch-size work. */}
        <div class="tl-qcard-actions" style={{ "flex-wrap": "wrap" }}>
          {/* Leaves the question rather than answering it, so it reads as a
              link and sits away from anything that commits. */}
          <button type="button" class="tl-qcard-chat" onClick={() => props.onChat()}>
            Type a message instead
          </button>
          <Show when={props.onTerminal}>
            {/* An offer, never an instruction. The card used to LATCH on a
                stopped walk and tell the reader to finish the answer in the
                Terminal; nothing stops here any more, so this is just the
                other view, one tap away.

                `.tl-qcard-back` is the card's neutral outlined button. Its
                `margin-right: auto` belongs to a Back that pins left, and this
                one sits with the other actions. */}
            <button
              type="button"
              class="tl-qcard-back"
              style={{ "margin-right": "0" }}
              onClick={() => props.onTerminal?.()}
            >
              Open Terminal
            </button>
          </Show>
          {/* `!props.review` as well as `typing()`, so the two Show blocks
              here can never both be open. The review screen's only action is
              Submit, and an "Answer" beside it would be the free-text row of
              some earlier question wearing the review screen's header. */}
          <Show when={typing() && !props.review}>
            <button
              type="button"
              class="tl-qcard-send"
              disabled={!text().trim() || props.busy || sending() !== null}
              onClick={sendText}
            >
              {sending() === FREE_TEXT_LABEL ? "Answering…" : "Answer"}
            </button>
          </Show>
          <Show when={props.review}>
            <button
              type="button"
              class="tl-qcard-send"
              disabled={props.busy || sending() !== null}
              onClick={() => run("submit", () => props.onSubmit())}
            >
              {sending() === "submit" ? "Submitting…" : "Submit"}
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
};

/** Two headers naming the same question. Empty never matches. */
function sameHeader(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x !== "" && x === y;
}

/** True when any option carries a description worth expanding. */
function hasDescriptions(q: DialogQuestionView): boolean {
  return q.options.some((o) => (o.description ?? "").trim() !== "");
}
