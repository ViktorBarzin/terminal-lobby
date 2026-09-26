import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type Component,
  type JSX,
} from "solid-js";
import type { WorkingRow } from "./timeline.logic";
import { formatDuration } from "./rows";
import {
  lineState,
  roomFor,
  shortTarget,
  splitReason,
  type LineState,
  type Room,
} from "./statusline.logic";
import { EyeIcon, StopSquareIcon } from "./Icons";

/**
 * The composer's thin line: what the session is doing on the left, the mode,
 * model and context dials on the right.
 *
 * WHERE IT CAME FROM. The Quiet line composer, which Viktor chose on
 * 2026-09-24 from five prototypes. The session's state used to be a row at the
 * foot of the timeline, inside the scroll, 16px above a composer that measured
 * 124px at rest on a desktop and 127px on a phone (0.71.2, memory #13886). The
 * line is that row and the composer's control bar in one strip of small type,
 * and the whole composer measures 86px at rest on a desktop.
 *
 * WHAT IT SAYS is one function (statusline.logic `lineState`): watching first,
 * then the open turn, working or waiting, then background work the session
 * still owes, then nothing. The words are the old row's: the call in flight,
 * its target, how long it has run, and the step count once it is above one.
 *
 * STOP LIVES HERE, beside the work it stops, and only while something runs.
 * It sat beside Send until this change, and it showed while Claude waited as
 * well, because a turn parked on a question counted as open. Now the ways out
 * of a question are the card's own buttons, Send, and the terminal (spec risk
 * R5), and a watching device never sees Stop, since it types into the pane.
 *
 * THE CLOCK. One 1s interval, running only while a turn is open, owned here
 * now that the row it drove has gone from the timeline. The screen reader
 * hears the state change and nothing else: the live region is keyed on the
 * kind of state, so a ticking clock never speaks.
 */
export const StatusLine: Component<{
  /** The open turn's live row, as `liveRow(shownRows())` finds it. */
  live?: WorkingRow;
  /** What the session still owes once its turn has closed ("2 agents"). */
  background?: string;
  /** Why this device cannot act on the session; watching. */
  inertReason?: string;
  /** This device's plan answer is clearing the context (statusline.logic). */
  clearing?: boolean;
  onStop?: () => void;
  /** Hand the session back to this device, from the watching state. */
  onTakeControl?: () => void;
  /** The dials, which sit on the right of the same line. */
  children?: JSX.Element;
}> = (props) => {
  const state = createMemo<LineState>(() =>
    lineState({
      live: props.live,
      background: props.background,
      inertReason: props.inertReason,
      clearing: props.clearing,
    }),
  );

  // One clock for the line, running only while a turn is open.
  const [now, setNow] = createSignal(Date.now());
  const ticking = createMemo(() => props.live !== undefined);
  createEffect(() => {
    if (!ticking()) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  /** How long the thing the row is about has gone on: the call in flight, or
   *  the wait, or the turn when neither has a time of its own. */
  const elapsed = (r: WorkingRow): string => {
    const from = r.toolStartedAt ?? r.startedAt;
    return from ? formatDuration(now() - from) : "";
  };

  // What a screen reader hears, once per change of state. Keyed on the KIND,
  // so the clock above never reaches it. Arriving at an idle session says
  // nothing; a turn that ends says so.
  let spoken = false;
  const announce = createMemo<string>((was) => {
    const s = state();
    switch (s.kind) {
      case "working":
        spoken = true;
        return "Claude is working";
      case "waiting":
        spoken = true;
        return "Claude is waiting for you";
      case "background":
        spoken = true;
        return "Claude finished; background work is still running";
      case "watching":
        spoken = true;
        return s.reason;
      case "clearing":
        spoken = true;
        return "Clearing context, then Claude starts on the plan";
      case "idle":
        return spoken ? "Claude finished" : was;
    }
  }, "");

  // How much the line keeps, measured rather than queried: container queries
  // would be the natural tool and Safari 15.6 has none (statusline.logic
  // `roomFor`). The callback reads the element itself rather than the entries,
  // because nothing promises it entries: a test's stand-in observer, for one,
  // calls it with none.
  const [room, setRoom] = createSignal<Room>("wide");
  let lineEl: HTMLDivElement | undefined;
  onMount(() => {
    if (!lineEl || typeof ResizeObserver === "undefined") return;
    const measure = () => setRoom(roomFor(lineEl ? lineEl.getBoundingClientRect().width : 0));
    const ro = new ResizeObserver(measure);
    ro.observe(lineEl);
    measure();
    onCleanup(() => ro.disconnect());
  });

  const working = () => {
    const s = state();
    return s.kind === "working" ? s.row : undefined;
  };
  const waiting = () => {
    const s = state();
    return s.kind === "waiting" ? s.row : undefined;
  };
  const background = () => {
    const s = state();
    return s.kind === "background" ? s.label : undefined;
  };
  const watching = () => {
    const s = state();
    return s.kind === "watching" ? splitReason(s.reason) : undefined;
  };

  return (
    <div class="tl-statusline" ref={lineEl} data-room={room()} data-kind={state().kind}>
      <div class="tl-status-state" data-kind={state().kind}>
        <Switch>
          <Match when={working()}>
            {(r) => (
              <>
                <span class="tl-line-dot" aria-hidden="true" />
                <span class="tl-status-word">Working</span>
                <Show when={r().tool}>
                  <span class="tl-status-tool">{r().tool}</span>
                </Show>
                <Show when={r().toolLabel}>
                  {(label) => (
                    <span class="tl-status-target" title={label()}>
                      {shortTarget(label())}
                    </span>
                  )}
                </Show>
                <Show when={elapsed(r())}>
                  {(t) => (
                    <>
                      <span class="tl-status-sep" aria-hidden="true">
                        ·
                      </span>
                      <span class="tl-status-num">{t()}</span>
                    </>
                  )}
                </Show>
                <Show when={r().steps > 1}>
                  <span class="tl-status-steps">
                    <span class="tl-status-sep" aria-hidden="true">
                      ·
                    </span>
                    <span class="tl-status-num">{r().steps} steps</span>
                  </span>
                </Show>
                <Show when={props.onStop}>
                  <button
                    type="button"
                    class="tl-stop"
                    aria-label="Stop Claude"
                    title="Stop: interrupts this turn"
                    onClick={() => props.onStop?.()}
                  >
                    <StopSquareIcon />
                    <span>Stop</span>
                  </button>
                </Show>
              </>
            )}
          </Match>
          <Match when={waiting()}>
            {(r) => (
              <>
                <span class="tl-line-dot" aria-hidden="true" />
                <span class="tl-status-word">Waiting for you</span>
                <Show when={elapsed(r())}>
                  {(t) => (
                    <>
                      <span class="tl-status-sep" aria-hidden="true">
                        ·
                      </span>
                      <span class="tl-status-num">{t()}</span>
                    </>
                  )}
                </Show>
              </>
            )}
          </Match>
          <Match when={state().kind === "clearing"}>
            <span class="tl-line-dot" aria-hidden="true" />
            <span class="tl-status-word">Clearing context · starting on the plan</span>
          </Match>
          <Match when={background()}>
            {(label) => (
              <>
                <span class="tl-line-dot" aria-hidden="true" />
                <span class="tl-status-word">
                  <span class="tl-status-long">Still working in the background:</span>
                  <span class="tl-status-short">Background:</span>
                </span>
                <span class="tl-status-target" title={label()}>
                  {label()}
                </span>
              </>
            )}
          </Match>
          <Match when={watching()}>
            {(w) => (
              <>
                <span class="tl-status-eye" aria-hidden="true">
                  <EyeIcon size={15} />
                </span>
                <span class="tl-status-word">{w().head}</span>
                <span class="tl-status-reason" title={w().rest}>
                  <span class="tl-status-sep" aria-hidden="true">
                    ·
                  </span>{" "}
                  {w().rest}
                </span>
                <Show when={props.onTakeControl}>
                  <button
                    type="button"
                    class="tl-take"
                    title="Stop watching, and type into this session from here"
                    onClick={() => props.onTakeControl?.()}
                  >
                    Take control
                  </button>
                </Show>
              </>
            )}
          </Match>
        </Switch>
      </div>
      <span class="tl-sr-only" aria-live="polite">
        {announce()}
      </span>
      <div class="tl-dials-slot">{props.children}</div>
    </div>
  );
};
