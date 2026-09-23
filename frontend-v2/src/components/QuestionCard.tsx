import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  untrack,
  type Component,
} from "solid-js";
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
 * One click on a multi-select that has not gone out yet, STAMPED WITH THE
 * QUESTION IT WAS MADE FOR (`drawnKey` in the card).
 *
 * `flip` names an option row to toggle. `text` is what the free-text row
 * should hold after the field's Add, "" to empty it. Neither is a set: the set
 * a click asks for is worked out when it goes, against the reading the reply
 * before it brought back, so two quick clicks cannot both be computed from the
 * same stale screen.
 */
type Toggle = { of: string; flip: string } | { of: string; text: string };

/** A multi-select request: the rows to leave ticked, and the free-text row's words. */
type Wanted = { choices: string[]; text?: string };

/**
 * The card that answers a blocking AskUserQuestion, docked above the composer.
 *
 * IT HOLDS NOTHING ABOUT THE DIALOG. One reading comes in, one question is
 * drawn, and a click on an option is a request. There is no plan and no local
 * idea of where in the call the reader is. The reply to every request is a
 * fresh reading of the pane, and that is what gets drawn next. Two things are
 * held, both because they exist nowhere else yet: the free-text field's
 * half-typed words, and the multi-select clicks made faster than the pane can
 * answer them. Both are stamped with the question they were made for, so
 * neither can be spent on another one.
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
 * The consequence worth knowing: on a single-select, a choice commits when you
 * make it. A multi-select works the way the CLI's own widget does: a click
 * ticks or unticks one row and stays, and the commit button, labelled with the
 * CLI's own commit row ("Next", or "Submit" on the last question), is what
 * leaves the question. The CLI's review screen at the end is still where
 * everything can be seen before submitting, and the chips walk ← back to any
 * question already answered, where the CLI redraws the previous pick with a
 * trailing tick.
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
  /** Answer the question `header` names and LEAVE it, with the labels it
   *  should be left holding, plus free text for the CLI's "Type something"
   *  row. One label for a single-select. For a multi-select this is the
   *  commit button: the set is the DESIRED FINAL STATE the card shows, and
   *  the server applies it and then presses the CLI's commit row. */
  onChoose: (header: string, choices: string[], text?: string) => Promise<void>;
  /** Apply a desired final state to the multi-select on screen and STAY on
   *  it. One click is one of these. An empty `choices` is a question with
   *  nothing ticked, which is what unticking the last row asks for. */
  onToggle: (header: string, choices: string[], text?: string) => Promise<void>;
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
  /**
   * The mark of a request in flight that MOVES the dialog, or null: the row
   * label of a single-select answer, "commit", "submit", or `back:<header>`.
   * A multi-select toggle is not one of these. It stays on the question, so
   * it is held in `flying` below and leaves the rows clickable.
   */
  const [sending, setSending] = createSignal<string | null>(null);
  /**
   * Multi-select clicks waiting for the reply ahead of them, oldest first.
   *
   * They have to wait. TextView's `put` drops a request while another is in
   * flight, and each click is worked out against the reading the previous
   * reply brought back (`toggled` below), so sending it early would either be
   * dropped or computed from a screen that is about to change. A click is
   * never dropped for being early; it is dropped only when the question it
   * was made for is no longer the one on screen.
   */
  const [queue, setQueue] = createSignal<Toggle[]>([]);
  /** The multi-select toggle in flight, or null. */
  const [flying, setFlying] = createSignal<Toggle | null>(null);
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
   * The question the free-text field, and every waiting multi-select click,
   * belongs to, as its content identifies it.
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
   * On a multi-select that row is an inline field, and once it holds words
   * the CLI draws them in place of its label ("[✔] Mango"). The row keeps
   * FREE_TEXT_LABEL as its identity here all the same; the words and the box
   * come from the reading's `typed` and `typedChecked`, and the row shows
   * them.
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

  /** The question on screen is a multi-select, where a click toggles and stays. */
  const multi = (): boolean => question()?.multiSelect === true;

  /** Anything in flight: a request of this card's, or one TextView is holding. */
  const busy = (): boolean => props.busy || sending() !== null || flying() !== null;
  /** The clicks still waiting that were made for the question on screen. */
  const waiting = createMemo(() => queue().filter((t) => t.of === drawnKey()));
  /** Nothing in flight and nothing waiting to go, so the ticks on screen are final. */
  const settled = (): boolean => !busy() && waiting().length === 0;

  /**
   * Run one request that moves the dialog, marking the row it belongs to
   * while it is in flight.
   *
   * The mark is local because only the card knows WHICH row was clicked;
   * `props.busy` says only that something is in flight. A failure clears the
   * mark and nothing else: the caller reports it, and the card stays usable,
   * because there is no half-typed sequence left behind to protect the reader
   * from.
   */
  const run = (mark: string, go: () => Promise<void>) => {
    if (busy()) return;
    setSending(mark);
    void go()
      .catch(() => {})
      .finally(() => setSending(null));
  };

  /**
   * The option labels the READING says the question is holding, in the order
   * the CLI drew them. The free-text row is not among them: its box is
   * `typedPick` below.
   *
   * Read off the pane on every render rather than counted here. A card that
   * kept its own set would drift from the terminal the moment anything else
   * moved the dialog — a keystroke in the Terminal view, an Esc, a re-ask —
   * which is the class of local state the design removed.
   */
  const held = createMemo<string[]>(() =>
    optionRows()
      .filter((o) => o.checked === true && !isFreeText(o.label))
      .map((o) => o.label),
  );

  /** The words the pane shows in a multi-select's free-text row, "" while it reads "Type something". */
  const typedText = (): string => (question()?.typed ?? "").trim();
  /**
   * The free-text row as a PICK: its words when its box is ticked, else "".
   *
   * Both halves, because the CLI lets them part. Enter on that row toggles
   * the box and keeps the words ("[ ] Mango"), and Enter on the EMPTY row
   * ticks "[✔] Type something", which the CLI then drops at commit (CLI
   * 2.1.280, measured). Neither is an answer, and the request contract has
   * no way to say "words, unticked": a set that names the row carries its
   * words, and one that does not asks the server to clear them.
   */
  const typedPick = (): string => (question()?.typedChecked === true ? typedText() : "");

  /** A set for the wire: the options named, and the free-text row when it has words. */
  const wanted = (options: string[], words: string): Wanted =>
    words ? { choices: [...options, FREE_TEXT_LABEL], text: words } : { choices: options };

  /**
   * The set a queued click asks for, worked out NOW against the reading on
   * screen, or null when the click has nothing left to act on.
   *
   * A row click flips that one row and keeps every other box, the free-text
   * row included, as the reading shows it: the request is the question's
   * whole desired state, so leaving the free-text row out would ask the
   * server to clear its words. The field's Add keeps the ticked options and
   * sets the free-text row to what the field said.
   *
   * NOW rather than when clicked is the point. Two quick clicks computed at
   * click time would both be built from the screen before either landed, so
   * the second would ask for "Pear" alone and untick the Apple the first had
   * just ticked. That is not hypothetical: measured 2026-09-11, a request for
   * Pear alone against a question holding Apple planned a Space on Apple.
   */
  const toggled = (t: Toggle): Wanted | null => {
    if ("text" in t) return wanted(held(), t.text);
    const options = optionRows().filter((o) => !isFreeText(o.label));
    if (!options.some((o) => o.label === t.flip)) return null;
    const ticked = options
      .filter((o) => (o.label === t.flip ? o.checked !== true : o.checked === true))
      .map((o) => o.label);
    return wanted(ticked, typedPick());
  };

  /** A multi-select click for this row is in flight or waiting, so the row pulses. */
  const toggling = (label: string): boolean => {
    const mine = (t: Toggle | null): boolean =>
      t !== null && t.of === drawnKey() && ("flip" in t ? t.flip === label : isFreeText(label));
    return mine(flying()) || waiting().some(mine);
  };

  /**
   * Send one toggle and hold the next until its reply has landed.
   *
   * When it lands after the field's Add, the field closes if the pane now
   * holds exactly what was sent and the reader has not typed on since. Words
   * the pane did not take stay in the field, since retyping them is not the
   * reader's job.
   */
  const sendToggle = (t: Toggle) => {
    const want = toggled(t);
    if (!want) return;
    setFlying(t);
    void props
      .onToggle(header(), want.choices, want.text)
      .catch(() => {})
      .finally(() => {
        if ("text" in t && typing() && text().trim() === t.text && typedPick() === t.text) {
          setDraft(null);
        }
        setFlying(null);
      });
  };

  /**
   * The queue's pump: whenever nothing is in flight, send the oldest click
   * made for the question on screen.
   *
   * An effect rather than a loop in the click handler, because a click can
   * arrive while a request the card did not start is still in flight. The
   * card is rebuilt per call (TextView keys it), so `props.busy` can outlive
   * the card that raised it, and only watching it can tell when TextView's
   * `put` will take a request again. A reply lowers `props.busy` BEFORE it
   * hands over its reading, and `flying` clears only after, so this cannot
   * fire between the two and compute a click from the screen being replaced.
   *
   * Clicks stamped for another question are dropped here, all at once. The
   * pane moved under them, by a reply or by a keystroke in the Terminal, and
   * a click on "Apple" is not a click on whatever row carries that label now.
   */
  createEffect(() => {
    if (busy()) return;
    const all = queue();
    if (all.length === 0) return;
    const key = drawnKey();
    const [next, ...rest] = all.filter((t) => t.of === key);
    setQueue(rest);
    if (next) untrack(() => sendToggle(next));
  });

  /** Hold a multi-select click until the pump can send it. */
  const enqueue = (t: Toggle) => {
    // A commit or a step back is in flight, and a toggle made now would land
    // on whatever screen that leaves. The rows are disabled for the same
    // reason; this covers the field's Enter.
    if (sending() !== null) return;
    setQueue((q) => [...q, t]);
  };

  const choose = (label: string) => {
    if (isFreeText(label)) {
      if (!multi()) {
        setDraft({ of: drawnKey(), typed: "" });
        return;
      }
      // A multi-select's row may already hold words, and the field opens on
      // them so they can be changed or cleared. An open field is left alone:
      // a second click on the row must not wipe what is half-typed.
      if (!typing()) setDraft({ of: drawnKey(), typed: typedText() });
      return;
    }
    if (multi()) {
      enqueue({ of: drawnKey(), flip: label });
      return;
    }
    run(label, () => props.onChoose(header(), [label]));
  };

  const sendText = () => {
    const typed = text().trim();
    if (!typed) return;
    run(FREE_TEXT_LABEL, () => props.onChoose(header(), [FREE_TEXT_LABEL], typed));
  };

  /**
   * The field's Add, or Update: put its words into the CLI's inline row, or
   * take them out when it has been emptied. Either way it is one more toggle.
   * It presses no Enter; the commit button commits the words with the rest.
   *
   * Nothing to do when the field says what the pane already holds, and
   * nothing more to do while a change to that row is still on its way.
   */
  const canApplyText = (): boolean =>
    typing() && sending() === null && !toggling(FREE_TEXT_LABEL) && text().trim() !== typedPick();
  const applyText = () => {
    if (!canApplyText()) return;
    enqueue({ of: drawnKey(), text: text().trim() });
  };

  /**
   * The commit button's label: the text of the CLI's own commit row, since
   * pressing that row is what the button does.
   *
   * When there is no row to read, the call's shape stands in for it. That is
   * the usual state of a fresh question, not a corner: the watcher's reading
   * is withdrawn the moment the call's record lands, and the transcript
   * records no commit row, so until the first reply the card draws the
   * transcript's question. The CLI says "Next" on every question but the last
   * and "Submit" on the last (2.1.280, measured 2026-09-23), and a
   * one-question call's only question is its last. A plain "Next" fallback
   * labelled that call's button "Next" and then turned it into "Submit" under
   * the reader's first click, on the very call Viktor reported the bug from.
   */
  const commitLabel = (): string => {
    const drawn = (question()?.commit ?? "").trim();
    if (drawn) return drawn;
    const last = count() === 1 || (drawnAt() >= 0 && drawnAt() === count() - 1);
    return last ? "Submit" : "Next";
  };

  /**
   * What the commit button commits: the ticks the pane shows, and the
   * free-text words.
   *
   * The words are the OPEN FIELD's when it is open, and the pane's pick
   * otherwise. Typing and then pressing the commit button without Add is the
   * obvious slip, and a commit that ignored the field would send the answer
   * without the words while the reader watched them sit there. The server
   * applies whatever this differs from the pane by before it presses the
   * commit row, so nothing extra has to happen first.
   */
  const commitSet = (): Wanted => wanted(held(), typing() ? text().trim() : typedPick());

  /**
   * Nothing to commit, or the pane is still catching up.
   *
   * The CLI itself would take a commit with nothing ticked, and the question
   * would go unanswered: its review screen warns "You have not answered all
   * questions" and Claude reads "The user did not answer the questions."
   * (CLI 2.1.280, measured). A button that does that on purpose belongs in
   * the Terminal, not here, and the server refuses an empty commit anyway.
   *
   * While a click is in flight or waiting, the ticks on screen are not the
   * ones the reader asked for yet, and committing them would commit a set
   * that nobody chose.
   */
  const canCommit = (): boolean => settled() && commitSet().choices.length > 0;
  const commit = () => {
    if (!canCommit()) return;
    const want = commitSet();
    run("commit", () => props.onChoose(header(), want.choices, want.text));
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
                chip and the screen did not move, with no way to tell why.

                A chip also waits for every multi-select click to land. ←
                leaves the question, so a click still waiting would be dropped
                with it, and one in flight would land on the question the chip
                walks back to. */}
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
                        disabled={!reachable() || !settled()}
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
              <Show when={multi()}>
                {/* One sentence, naming the button by the label the pane gave
                    it. The wording it replaces, "Each tap answers the
                    question. Come back to add another pick", described the
                    bug: until 2026-09-23 every click committed, and a
                    one-question call reached the review screen on its first
                    click. */}
                <div class="tl-qcard-hint">
                  Tick every answer that applies, then press {commitLabel()}.
                </div>
              </Show>
              <div class="tl-qcard-options" data-full={full() ? "true" : undefined}>
                {/* <Index>, not <For>: a row is its POSITION, since the digit is
                    the key the CLI listens for, and every reply brings new
                    option objects. <For> keys on the object, so it rebuilt
                    every button on every reply, and a toggle, which leaves the
                    question on screen, took the reader's keyboard focus with
                    it. */}
                <Index each={optionRows()}>
                  {(option, i) => {
                    const label = () => option().label;
                    const free = () => isFreeText(label());
                    /* THE TICK IS THE PANE'S, not the card's. On a
                       multi-select a row is ticked only when the reading says
                       its box is filled: a click in flight or waiting pulses
                       the row and draws no tick, because what the pane will
                       draw is not known until it has drawn it. The set the
                       next click sends is built from these ticks, so showing
                       them is showing what will be kept.

                       A single-select row reads as chosen while its request is
                       in flight, and the free-text row while its field is
                       open, since there the click IS the answer. */
                    const ticked = () =>
                      multi() && (free() ? typedPick() !== "" : option().checked === true);
                    const marked = () =>
                      multi() ? ticked() : sending() === label() || (typing() && free());
                    const inFlight = () => (multi() ? toggling(label()) : sending() === label());
                    return (
                      <button
                        type="button"
                        class="tl-qcard-option"
                        data-multi={multi() ? "true" : undefined}
                        data-chosen={marked() ? "true" : undefined}
                        aria-pressed={multi() ? ticked() : undefined}
                        aria-busy={inFlight() ? "true" : undefined}
                        // A multi-select row stays clickable while a toggle is
                        // in flight, because a click then waits its turn in the
                        // queue. Only a request that moves the dialog holds it.
                        disabled={multi() ? sending() !== null : busy()}
                        onClick={() => choose(label())}
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
                            // a rule of its own: every row with a click on its
                            // way pulses, the waiting ones included.
                            animation: inFlight() ? "tl-pulse 1.1s ease-in-out infinite" : "none",
                          }}
                        >
                          {i + 1}
                        </span>
                        {/* A multi-select's free-text row shows the words it
                            holds, the way the CLI redraws "Type something" as
                            "[✔] Mango". */}
                        <span class="tl-qcard-label">
                          {multi() && free() && typedText() ? typedText() : label()}
                        </span>
                        <Show when={option().description}>
                          {/* Clamped to two lines, and the marked row expands
                              (see app.css). Every description stays on screen
                              because the difference between two options
                              usually lives in them, not in the labels. */}
                          <span class="tl-qcard-desc">{option().description}</span>
                        </Show>
                      </button>
                    );
                  }}
                </Index>
              </div>
              <Show when={typing()}>
                {/* The field, and on a multi-select its own Add beside it. That
                    Add sits here rather than in the actions row because the
                    commit button owns the right end of that row, and two
                    buttons there, one that adds words and one that leaves the
                    question, is a mis-click waiting to happen.

                    `.tl-qcard-back` is the card's neutral outlined button, as
                    Open Terminal uses it below. The inline styles lay out one
                    row rather than adding a rule to app.css for it. */}
                <div style={{ display: "flex", gap: "8px", "margin-top": "6px" }}>
                  <input
                    class="tl-qcard-other"
                    style={{ "margin-top": "0", flex: "1", "min-width": "0" }}
                    type="text"
                    placeholder={FREE_TEXT_LABEL}
                    aria-label="Your own answer"
                    value={text()}
                    onInput={(e) => setDraft({ of: drawnKey(), typed: e.currentTarget.value })}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      if (multi()) applyText();
                      else sendText();
                    }}
                  />
                  <Show when={multi()}>
                    <button
                      type="button"
                      class="tl-qcard-back"
                      style={{ "margin-right": "0", flex: "none" }}
                      disabled={!canApplyText()}
                      onClick={applyText}
                    >
                      {typedText() ? "Update" : "Add"}
                    </button>
                  </Show>
                </div>
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
          {/* `!props.review` as well as `typing()`, so the Show blocks here
              can never be open together. The review screen's only action is
              Submit, and an "Answer" beside it would be the free-text row of
              some earlier question wearing the review screen's header. Not on
              a multi-select either, where the field's words are one more pick
              and the commit button below is what sends them. */}
          <Show when={typing() && !props.review && !multi()}>
            <button
              type="button"
              class="tl-qcard-send"
              disabled={!text().trim() || busy()}
              onClick={sendText}
            >
              {sending() === FREE_TEXT_LABEL ? "Answering…" : "Answer"}
            </button>
          </Show>
          <Show when={props.review}>
            <button
              type="button"
              class="tl-qcard-send"
              disabled={busy()}
              onClick={() => run("submit", () => props.onSubmit())}
            >
              {sending() === "submit" ? "Submitting…" : "Submit"}
            </button>
          </Show>
          {/* The multi-select commit, at the right end of the row where the
              review screen's Submit sits. It presses the CLI's own commit row,
              so it carries that row's label, and it is outlined in the accent
              rather than filled: it moves through the dialog, and the filled
              Submit on the review screen is still the act that answers
              Claude. */}
          <Show when={multi() && !props.review && optionRows().length > 0}>
            <button
              type="button"
              class="tl-qcard-next"
              disabled={!canCommit()}
              aria-busy={sending() === "commit" ? "true" : undefined}
              onClick={commit}
            >
              {commitLabel()}
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
