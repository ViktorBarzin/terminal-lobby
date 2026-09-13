import { createSignal, Show, type Accessor, type Component } from "solid-js";
import { sessionLabel, sessionTitleDraft, type Session } from "../types/lobby";
import { MAX_TITLE_RUNES } from "../lib/title";
import { StateDot } from "./StateDot";

/**
 * What a tile header needs to know about the session it names.
 *
 * A `Pick` rather than the whole `Session` because the narrow shape IS the
 * design's boundary written in types: the header carries the title, the state
 * dot, a watch marker and a close control, and nothing else. A component handed
 * the whole session could grow a spend figure or a context meter without anyone
 * noticing it had moved — those belong on the session bar, which shows the
 * FOCUSED tile and follows focus around, so they are written once there rather
 * than four times across a workspace.
 *
 * `pane_title` is in here for the hover text alone, never for display: it is
 * whatever is running in the pane describing itself, which is not the session's
 * **title**.
 */
export type TileSession = Pick<Session, "name" | "title" | "pane_title" | "state" | "bg">;

/**
 * The chrome a Tile wears: roughly 24px of title, state, watch marker and
 * close, above the session's own view.
 *
 * FOUR THINGS, AND THE DESIGN SAYS WHICH FOUR
 * (docs/plans/2026-09-12-multi-session-workspaces-design.md, "Everything else,
 * and what changes"; CONTEXT.md, "Tile"). A workspace of four tiles pays for
 * this strip four times over, in pixels taken from four live terminals, and
 * every one of those pixels comes out of somebody's columns and rows — the tile
 * IS the size of the session (`claimGrid`), so a header that grew a second row
 * would narrow four tmux windows for every device attached to them. The
 * context meter and the spend figure stay on the session bar for that reason
 * rather than by omission.
 *
 * A KILL BORROWS THE SLOT IT NEEDS RATHER THAN ADDING ONE. For the eight
 * seconds a member is dying (design, "Death and restore") the strip dims,
 * strikes its title through, and swaps the close control for the `↺` arrow with
 * the seconds beside it — the same swap a sidebar card makes when it gives up
 * its `⋯` button. It is four items in a 30px strip — 24px until 2026-09-13,
 * when Viktor asked for a title he could actually read. A focus change still
 * moves nothing: the height is the same whichever tile is focused, so no tile's
 * rect moves, no terminal refits and no `claimGrid` fires for a colour.
 *
 * TWO OF THE FOUR ARE BORROWED, NOT BUILT. The title comes from
 * `sessionLabel`, the ladder every user-facing surface in the app goes through,
 * and the dot is `StateDot`, which the sidebar draws. Both rules have moved
 * under this codebase's feet already — ADR-0019 made a session name an opaque
 * id that says nothing, ADR-0022 made the first title rename the session — and
 * a second copy of either would be the copy nobody remembered to move.
 *
 * WHAT THIS DOES NOT DO. It does not decide whether the tile is read-only, and
 * it does not remove anything. Both answers belong to callers that already hold
 * them: `SessionView` resolves the watch and publishes it
 * (`publishResolvedWatch`), because what the attach actually did is the only
 * honest answer and a second guess here could contradict the terminal on
 * screen; and closing a tile is a workspace edit, which is a write to two
 * stores and an entry on the undo stack. A kill is the same division: whether
 * one is running and when it lands arrive as props, and the arrow reports its
 * press rather than calling `store.takeBackKill` itself. This renders what it
 * is told and reports the press.
 */
export const TileHeader: Component<{
  session: TileSession;
  /**
   * TRUE while this tile is the one taking keystrokes.
   *
   * It is the whole answer to "where does what I type go", so the treatment is
   * deliberately loud (src/tiles.css). The attribute is what the stylesheet
   * keys on; `lib/ownwhile.ts` gates the `window.__tl*` handles on the same
   * boolean, so the highlight and the paste target cannot disagree about which
   * tile is live.
   */
  focused?: boolean;
  /**
   * TRUE when this tile is attached READ-ONLY — a Watch-mode choice, or a
   * foreign session shared `ro`.
   *
   * A watching tile never claims its session's Grid, which is what keeps Watch
   * mode's promise that a second device cannot reflow the desktop driving a
   * session. The visible consequence is a terminal that does not fill its tile,
   * and this marker is what explains it.
   */
  watching?: boolean;
  /**
   * Take this tile out of the workspace. The session keeps running and keeps
   * its place in the sidebar — a close is not a kill, and the two are opposite
   * enough that the strip never offers both: for the eight seconds a kill is
   * running, this control gives its slot to the arrow that takes the kill back
   * (`onUndoKill`), the way a card hands the same slot from `⋯` to `↺`. Nothing
   * in "remove this tile and keep the session" applies to a session that is
   * about to stop existing, and the press worth having in those eight seconds
   * is the other one.
   */
  onClose: () => void;
  /**
   * Give this session a new title, from the box a double click opens on the
   * strip.
   *
   * TITLE, not name: a session's tmux name is an opaque id minted at creation
   * that never moves again (ADR-0019), and the title is the only thing anyone
   * reads. The server follows one into the other on its own, which is what
   * keeps `tmux ls` readable, and nothing here has to know.
   *
   * The same call the sidebar card's own double-click makes, deliberately: two
   * ways to rename one session that disagreed about what an empty box means
   * would be worse than one. Empty clears the title and hands the session back
   * to whatever summary Claude writes next.
   *
   * Absent on a session that is not the caller's to retitle, which is what
   * hides the gesture rather than letting it fail at the server.
   */
  onRename?: (title: string) => void;
  /**
   * TRUE while this session is inside its kill window: the eight seconds
   * (store/lobby.ts GRACE_MS) in which the DELETE has not gone out and the
   * arrow below takes the whole thing back.
   *
   * The design says a killed member "dims its tile and strikes it through with
   * the `↺` arrow and the seconds counting down, exactly as a sidebar card
   * does" ("Death and restore"), and *exactly* is the load-bearing word — the
   * same fade, the same strike, the same glyph, the same rounding. A tile that
   * showed nothing would leave the one surface the person is actually looking
   * at saying nothing about the window they have: the kill is reachable from
   * the tile, so the tile is where they are when it starts.
   *
   * A PROP RATHER THAN A STORE READ. `store.killing(name)` is a few lines away
   * in App.tsx and this still does not call it. The shell already decides which
   * tiles exist and what each one is; a header that answered the same question
   * from a second source could disagree with it about a tile mid-kill, and
   * "which of these four is dying" is not a question worth having two answers
   * to.
   */
  killing?: boolean;
  /**
   * When this kill lands, as `store.killingUntil(name)` reports it: epoch
   * milliseconds, or absent for a kill with no deadline.
   *
   * THE DEADLINE, NOT THE SECONDS. A seconds count would have to be pushed
   * every second by something; a deadline is a constant, and `tick` below is
   * what makes this subtract from it again. Absent is a real answer rather than
   * a bug — it is the shape an older build had — and it draws no number instead
   * of guessing one, exactly as the card does.
   */
  killingUntil?: number;
  /**
   * The sidebar's existing 1Hz tick, read by the countdown alone.
   *
   * NO SECOND TIMER, and in a workspace that is not just tidiness. Four tiles
   * each running their own interval would be four more wakeups a second on a
   * page already drawing four live terminals, and four intervals started at
   * four mount times count in four phases — so one kill would read 5 on two
   * tiles and 4 on two others at the same instant. Reading the clock the
   * sidebar already runs is what keeps every surface saying the same number.
   */
  tick?: Accessor<number>;
  /**
   * Take the kill back. This is the arrow's press, and on a phone it is the
   * only way back there is — no Cmd+Z on a touch screen.
   *
   * Reported rather than done, like `onClose`: the retraction is
   * `store.takeBackKill(name)`, which presses THIS kill's own entry rather than
   * whatever is on top of the undo stack, and the toast that explains a refusal
   * belongs to the caller (store/undo.ts `UndoResult`). Both live with the
   * shell. A caller that passes `killing` owes this handler — the arrow is the
   * whole reason the window is visible.
   */
  onUndoKill?: () => void;
}> = (props) => {
  /** What this header SHOWS: the title, or what stands in for one. */
  const label = () => sessionLabel(props.session);
  /**
   * Hover text, the same pair a sidebar card offers. The tmux name is otherwise
   * invisible now that every surface shows titles, and it is what `tmux ls` and
   * the status bar print — so it stays reachable for anyone mapping a tile back
   * to a shell. It doubles as the way to read a title the strip clipped.
   */
  const titleAttr = () =>
    props.session.pane_title
      ? `${props.session.name} · ${props.session.pane_title}`
      : props.session.name;

  // ---- renaming -------------------------------------------------------------
  // A double click on the title opens a box over it. The SIDEBAR CARD'S
  // GESTURE, moved onto the surface a person is actually looking at while a
  // workspace is up (SessionCard `beginRename`): same double click, same Enter,
  // same Escape, same blur that abandons, same "empty clears the title".
  let inputEl: HTMLInputElement | undefined;
  const [editing, setEditing] = createSignal(false);
  /**
   * What the box opened with, held rather than read live.
   *
   * The card pauses the store's poll for the length of an edit (`store.hold`)
   * so the row cannot be rebuilt under the typing. A header has no store, and
   * does not need one: capturing the draft is what stops a poll landing a new
   * title in the middle of the box. Solid keeps `value` bound, so reading
   * `sessionTitleDraft(props.session)` there would overwrite what a person had
   * half-typed the moment Claude retitled the session they were renaming.
   *
   * It is also the value a commit compares against, which is what makes
   * "opened it, changed nothing, pressed Enter" send no request.
   */
  const [draft, setDraft] = createSignal("");

  const renameable = () => !!props.onRename && !props.killing;

  const beginRename = (e?: Event) => {
    // Not a title on a session that is leaving, and not one on a session that
    // is somebody else's — the card refuses on the same two grounds.
    if (!renameable()) return;
    e?.stopPropagation();
    setDraft(sessionTitleDraft(props.session));
    setEditing(true);
    // Two microtasks, as the card does it: the input does not exist until the
    // `Show` has re-run, and selecting before focus leaves nothing selected.
    queueMicrotask(() => inputEl?.focus());
    queueMicrotask(() => inputEl?.select());
  };

  const endRename = () => setEditing(false);

  const commitRename = () => {
    const next = inputEl?.value ?? "";
    const was = draft();
    endRename();
    // The TITLE, not the name. The tmux name is an opaque id minted at creation
    // (ADR-0019) and the server moves it to follow a title on its own
    // (ADR-0022); the poll brings the result back. An empty one clears the
    // title and hands the session to whatever summary lands next.
    if (next !== was) props.onRename?.(next);
  };

  /**
   * Whole seconds until this kill lands, or 0 when there is nothing to count.
   *
   * THE CARD'S ARITHMETIC, DELIBERATELY THE SAME ONE (SessionCard
   * `secondsLeft`). The same kill is on screen twice while a workspace is up —
   * once on the sidebar row and once on the tile — and two surfaces counting
   * the same eight seconds differently is worse than either of them being
   * wrong, because the person reads the disagreement as the app not knowing.
   *
   * Rounded UP: at 2.5s left this says 3. Rounding down would show 2 with two
   * and a half seconds still to go, which is the direction that costs somebody
   * a session they were still deciding about. It also means the last number
   * seen is 1 rather than 0, and 0 draws nothing — a zero would sit on the
   * strip for the gap between the deadline and the store clearing `killing`,
   * reading as a countdown that stalled.
   */
  const secondsLeft = () => {
    if (!props.killing) return 0;
    // Read for its dependency, not its value: this is what re-runs the
    // subtraction once a second, and the only clock involved.
    props.tick?.();
    const until = props.killingUntil;
    if (until === undefined) return 0;
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  };

  return (
    <div
      class="tl-tile-header"
      data-focused={props.focused ? "" : undefined}
      // On its way out, for the eight seconds before the DELETE goes out. The
      // presence of the attribute is the whole message, so it carries no value
      // — the same contract `.tl-card[data-killing]` has in the sidebar, and
      // src/tiles.css hangs the fade and the strike-through off it.
      data-killing={props.killing ? "" : undefined}
    >
      {/* No `unseen` here, and that is not an omission. The sidebar's unseen
          mark means "finished since you last looked at it", which a tile you
          are looking at cannot be: every visible tile counts as open, and the
          same visible set is what suppresses a push about it. Passing it would
          mark a session as unread on the very screen that is reading it. */}
      <StateDot state={props.session.state} bg={props.session.bg} />

      {/* The title, or the box that is replacing it. The box takes the span's
          own place in the flex row (src/tiles.css) so the strip does not jump
          under the cursor that opened it, and every other item on the strip
          stays exactly where it was. */}
      <Show
        when={!editing()}
        fallback={
          <input
            ref={inputEl}
            class="tl-tile-rename"
            value={draft()}
            // The cap Go enforces on the way in (lib/title.ts, mirroring
            // slug.CleanTitle) — refused at the keyboard rather than truncated
            // after the fact.
            maxlength={MAX_TITLE_RUNES}
            aria-label={`Rename ${label()}`}
            // A press in the box is the box's. The slot's capture-phase
            // pointerdown (App.tsx) declines it too, which is what stops a drag
            // across the text from lifting the tile; this stops the rest.
            onClick={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // The app's own bindings live on the document: Escape closes a
              // workspace and single letters reach a terminal, so a title with
              // an "n" in it must not open a new session.
              e.stopPropagation();
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") endRename();
            }}
            // Clicking away abandons rather than commits, which is the card's
            // answer and the safer one: a half-typed title should not become a
            // session's name because somebody looked at another tile.
            onBlur={endRename}
          />
        }
      >
        {/* TWO TITLES, and which one is drawn is whether this session is the
            reader's to retitle. They look identical — same class, same clamp,
            same hover text — and differ in what they are: one is a control that
            opens the box, the other is a label.

            Written as a branch rather than as one span with conditional
            attributes because a `role="button"` that is sometimes a lie is
            worse than no role at all: a screen reader would announce a foreign
            tile's title as a button, and pressing it would do nothing. */}
        <Show
          when={renameable()}
          fallback={
            <span class="tl-tile-title" title={titleAttr()}>
              {label()}
            </span>
          }
        >
          <span
            class="tl-tile-title"
            title={titleAttr()}
            // The only thing advertising the gesture is the cursor, so the
            // stylesheet gets told which titles actually have it.
            data-rename=""
            // A KEYBOARD PATH, not decoration to satisfy a lint rule. A double
            // click is the gesture Viktor asked for and it is the only one this
            // strip had: with no tab stop and no key, a rename from a workspace
            // was mouse-only. `role="button"` is what the click-to-edit pattern
            // resolves to — there is no ARIA role for an editable label — and
            // it is the same pair a sidebar card's row wears.
            role="button"
            tabindex={0}
            aria-label={`Rename ${label()}`}
            onDblClick={beginRename}
            onKeyDown={(e) => {
              // F2 as well as Enter: it is the rename key in every file
              // manager and in VS Code, and it costs one comparison.
              if (e.key !== "Enter" && e.key !== "F2") return;
              e.preventDefault();
              beginRename(e);
            }}
          >
            {label()}
          </span>
        </Show>
      </Show>

      {/* Shown whenever the tile is read-only, which is one rule rather than
          the card's two: a sidebar row suppresses this eye on a foreign session
          because its owner badge already carries one, and a tile header has no
          owner badge to say it twice. */}
      <Show when={props.watching}>
        <span
          class="tl-tile-watch"
          title="Watching: this tile does not type, and does not size the session"
          aria-label="read-only, this tile is a viewer"
        >
          👁
        </span>
      </Show>

      {/* How long there is, immediately left of the way out, so the pair reads
          as "three seconds, and here is the button".

          `aria-hidden` for the reason it is hidden on a card, which only gets
          stronger here: a live number in the accessible tree announces itself
          every second, and a workspace can have four of these strips. The arrow
          beside it carries the one label worth reading, and that label does not
          change as the clock runs. */}
      <Show when={secondsLeft() > 0}>
        <span class="tl-tile-countdown" aria-hidden="true">
          {secondsLeft()}
        </span>
      </Show>

      {/* ONE CONTROL, and which one it is depends on what is happening to the
          session. Swapping in place rather than showing both keeps the strip at
          four items and 24px — a fifth control would be pixels taken from four
          live terminals (see the head of this file) — and it means the two
          presses never sit side by side, which is what a control that removes a
          tile and a control that rescues a session should never do.

          Either way it is a real `<button>`, and App.tsx's tile drag depends on
          that: its capture-phase `pointerdown` refuses to lift a tile when the
          press landed on a button, so neither of these can start a drag by
          wobbling. */}
      <Show
        when={props.killing}
        fallback={
          <button
            class="tl-tile-close"
            type="button"
            aria-label={`Close ${label()}`}
            title="Close this tile — the session keeps running"
            onClick={() => props.onClose()}
          >
            ✕
          </button>
        }
      >
        <button
          class="tl-tile-undo"
          type="button"
          aria-label={`Undo kill of ${label()}`}
          title="Undo kill — this session is closing in a few seconds"
          onClick={() => props.onUndoKill?.()}
        >
          ↺
        </button>
      </Show>
    </div>
  );
};
