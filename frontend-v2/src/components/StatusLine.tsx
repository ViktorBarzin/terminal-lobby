import {
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
import { roomFor, splitReason, type Room } from "./statusline.logic";
import { EyeIcon, StopSquareIcon } from "./Icons";

/**
 * The composer's thin line, while the T3 pass replaces it
 * (docs/plans/2026-09-27-text-view-t3-pass.md): Stop while something runs,
 * background work once the turn has closed, the watching state with Take
 * control, and the dials on the right.
 *
 * WHERE THE TURN'S WORDS WENT. The line said "Working · tool · target ·
 * elapsed · N steps", "Waiting for you" and "Clearing context" from the Quiet
 * line composer (2026-09-24) until 2026-09-27. The T3 pass moved them into the
 * live group at the end of the conversation (MessagesTimeline, timeline.logic
 * `liveGroupState`), with the one clock and the screen reader's announcement
 * of the turn. What is left here goes too as the pass lands: Stop to the
 * composer's round button, background work to the header's subtitle, the
 * watching state to the pill, the dials to the model sheet.
 *
 * STOP shows only while something RUNS: a turn parked on a question counts as
 * open, and a red Stop beside a question read as an alarm. A watching device
 * never sees it, since it types into the pane.
 */
export const StatusLine: Component<{
  /** The open turn's live row, as `liveRow(shownRows())` finds it. */
  live?: WorkingRow;
  /** What the session still owes once its turn has closed ("2 agents"). */
  background?: string;
  /** Why this device cannot act on the session; watching. */
  inertReason?: string;
  onStop?: () => void;
  /** Hand the session back to this device, from the watching state. */
  onTakeControl?: () => void;
  /** The dials, which sit on the right of the same line. */
  children?: JSX.Element;
}> = (props) => {
  /** What the left side shows: watching first, then Stop while something
   *  runs, then background work once no turn is open, then nothing. */
  const kind = createMemo((): "watching" | "working" | "background" | "idle" => {
    if (props.inertReason) return "watching";
    if (props.live) return props.live.waiting ? "idle" : "working";
    if (props.background) return "background";
    return "idle";
  });

  // What a screen reader hears from the line: only what it still shows. The
  // turn's own states are the timeline's to announce.
  const announce = createMemo<string>(() => {
    switch (kind()) {
      case "background":
        return "Background work is still running";
      case "watching":
        return props.inertReason ?? "";
      default:
        return "";
    }
  });

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

  const background = () => (kind() === "background" ? props.background : undefined);
  const watching = () =>
    kind() === "watching" && props.inertReason ? splitReason(props.inertReason) : undefined;

  return (
    <div class="tl-statusline" ref={lineEl} data-room={room()} data-kind={kind()}>
      <div class="tl-status-state" data-kind={kind()}>
        <Switch>
          <Match when={kind() === "working" && props.onStop}>
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
