import { Show, type Accessor, type Component } from "solid-js";
import { sessionLabel, type Session } from "../types/lobby";
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
 * its `⋯` button. It is still four items and still 24px: no row is added, the
 * header's height does not change, so no tile's rect moves, no terminal refits
 * and no `claimGrid` fires for a colour.
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
   * to a shell. It doubles as the way to read a title the 24px strip clipped.
   */
  const titleAttr = () =>
    props.session.pane_title
      ? `${props.session.name} · ${props.session.pane_title}`
      : props.session.name;

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

      <span class="tl-tile-title" title={titleAttr()}>
        {label()}
      </span>

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
