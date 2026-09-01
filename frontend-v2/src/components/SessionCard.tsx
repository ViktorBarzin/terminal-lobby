import {
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  type Component,
} from "solid-js";
import { sessionLabel, type Session } from "../types/lobby";
import { cleanTitle, MAX_TITLE_RUNES, nameForTitle } from "../lib/slug";
import type { LobbyStore } from "../store/lobby";
import { formatWorking, relativeTime, stateLabel } from "./lobby.logic";
import { createDismissableMenu } from "./menu";
import { StateDot } from "./StateDot";
import {
  resolveWatch,
  resolvedWatchFor,
  saveWatch,
  watchChoice,
  type WatchChoice,
} from "../store/watchmode";
import { ToolIcon, TOOL_LABELS } from "./ToolIcon";
import { lensTarget } from "../lib/act-as";
import { SWIPE_MIN_PX } from "../mobile/swipe";
import { dropSide, edgeScroll } from "../mobile/reorder";
import { hasFinePointer } from "../mobile/pointer";
import { ACT_AS } from "../lib/config";

/**
 * A thin session row (inventory Cat.2 "Session card"): state dot + name (left),
 * live working timer / relative time (right), an optional foreign owner badge,
 * and a ⋯ actions menu. Own cards are draggable (fine pointer) and rename inline
 * on double-click. Activate on click / Enter / Space.
 */
export const SessionCard: Component<{
  store: LobbyStore;
  session: Session;
  groupName: string; // "" = ungrouped
  tick: Accessor<number>;
  /** Alt-hold chip label for this card ("1".."9","0"), or null when inactive. */
  badge?: (name: string) => string | null;
  /** finished since you last looked (see Sidebar.unseenOf). */
  isUnseen?: (s: { name: string; state?: string }) => boolean;
  /** confirm seam (window.confirm by default; injectable for tests). */
  confirm?: (message: string) => boolean;
  /** The roamed `sidebar.showLastActive` pref. Absent means hidden — the safe
   *  direction for a setting that is off by default, so a call site that
   *  forgets to pass it errs towards showing less rather than more. */
  showLastActive?: Accessor<boolean>;
}> = (props) => {
  const s = () => props.session;
  /**
   * Finished since you last looked at it. The card used to answer this with
   * `state === "done"`, so every finished session wore the unread treatment and
   * the dimmed "seen" dot in sidebar.css was unreachable — the app-icon badge
   * counted a set the list had no way to point at. The real answer comes from
   * the visit store, via Sidebar.
   */
  const unseen = (): boolean => props.isUnseen?.(s()) ?? false;
  const foreign = () => !!s().owner && s().owner !== props.store.me();

  // --- Watch mode ---------------------------------------------------------
  // What this device would do on opening this session. For a session a view is
  // already OPEN on, that view's resolved decision wins: `driven` counts our own
  // client, so a session we are driving reads as driven and this would otherwise
  // claim we are about to watch it.
  /** What this card SHOWS: the session's title, or its name when it has none. */
  const label = () => sessionLabel(s());
  /** Hover text. The pane's own title first (what is running in there), then
   *  the tmux name — which is otherwise invisible now that cards show titles,
   *  and is what someone working in a shell needs to map a card to `tmux ls`. */
  const titleAttr = () => s().pane_title || s().name;

  /** The user this tab is acting as, "" in an ordinary tab. It decides that a
   *  session here opens WATCHING, and which namespace the choice is kept under
   *  — the key is otherwise the bare session name, shared with your own session
   *  of that name. Derived from the store's own /whoami rather than passed down,
   *  so the sidebar and the session bar cannot disagree about it. */
  const lens = () => lensTarget(props.store.whoami(), ACT_AS);
  const choice = () => watchChoice(s().name, lens());
  const willWatch = () =>
    resolvedWatchFor(s().name) ??
    resolveWatch(choice(), s().driven === true, !!lens());

  const setChoice = (c: WatchChoice) => {
    saveWatch(s().name, c, lens());
    menu.close();
  };
  const isActive = () =>
    props.store.selected()?.name === s().name &&
    (props.store.selected()?.owner ?? "") === (foreign() ? s().owner ?? "" : "");

  const [editing, setEditing] = createSignal(false);
  const menu = createDismissableMenu(() => props.store.hold());
  const [dropEdge, setDropEdge] = createSignal<"above" | "below" | null>(null);
  let releaseHold: (() => void) | null = null;
  let inputEl: HTMLInputElement | undefined;

  // The rename box and a drag both hold the poll, and only their own end
  // handlers give it back — so a card that goes away while one is open (its
  // group collapsing does exactly that, and until the model was stabilized so
  // did any poll) stranded the sidebar: the hold count never returned to zero
  // and nothing polled again for the rest of the session. Same backstop
  // ProjectGroup keeps on its add box and header drag.
  onCleanup(() => {
    releaseHold?.();
    releaseHold = null;
  });

  // Two different numbers share this slot. The live working timer is progress
  // on the turn in flight; the relative time is a TIMESTAMP, and only that one
  // answers to `sidebar.showLastActive`. Turning the setting off on a running
  // session would take away the one number worth watching while you wait.
  //
  // tick() is read only on the paths that actually need re-running every
  // second, so a card with the time hidden and nothing running stops
  // re-rendering on the clock entirely.
  const rightText = () => {
    if (s().state === "running") {
      props.tick();
      const since = props.store.workingSince(s().name);
      return since ? formatWorking(Date.now() - since) : "working";
    }
    if (!props.showLastActive?.()) return "";
    props.tick();
    // lastDrive, never lastActivity: tmux bumps session_activity on any attach
    // (read-only included), so the old number reset itself whenever somebody
    // opened the session to WATCH it. No stamp yet — a server predating the
    // field — shows nothing, which beats showing a number that means something
    // else.
    return s().lastDrive ? relativeTime(s().lastDrive!) : "";
  };

  // ---- activation ----
  const activate = (e: Event) => {
    // A long press has already opened the actions menu; the click that ends it
    // must not also open the session.
    if (holdFired) {
      holdFired = false;
      return;
    }
    menu.close(); // a click on the row is a click away from the menu
    if (editing()) return;
    if ((e as MouseEvent).detail > 1) return; // dblclick → rename, not activate
    props.store.select(s().name, foreign() ? s().owner : undefined);
  };
  const onKey = (e: KeyboardEvent) => {
    if (editing()) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.store.select(s().name, foreign() ? s().owner : undefined);
    }
  };

  // ---- inline rename ----
  const beginRename = (e?: Event) => {
    if (foreign()) return;
    e?.stopPropagation();
    releaseHold = props.store.hold();
    setEditing(true);
    menu.close();
    queueMicrotask(() => inputEl?.focus());
    queueMicrotask(() => inputEl?.select());
  };
  const endRename = () => {
    setEditing(false);
    releaseHold?.();
    releaseHold = null;
  };
  const commitRename = async () => {
    const next = inputEl?.value ?? "";
    endRename();
    // The box edits the TITLE. An empty one clears back to the session's name,
    // which store.rename handles — so unlike before, "" is a real instruction
    // rather than a no-op.
    if (next !== label()) await props.store.rename(s().name, next);
  };

  /** What the derived name will be, shown under the box as the person types. */
  const [draft, setDraft] = createSignal("");
  const derivedName = () => nameForTitle(cleanTitle(draft()), new Set());

  // ---- actions ----
  // Killing is unrecoverable, so it confirms here exactly as every sibling path
  // does (the kill chord, the palette action, Delete project).
  const kill = async () => {
    menu.close();
    const ask = props.confirm ?? ((m: string) => window.confirm(m));
    if (!ask(`Kill session "${label()}"?`)) return;
    await props.store.kill(s().name);
  };
  const moveTo = async (group: string) => {
    menu.close();
    await props.store.move(s().name, group);
  };
  const targets = () => {
    const out: { label: string; group: string }[] = [];
    if (props.groupName !== "") out.push({ label: "Ungrouped", group: "" });
    for (const p of props.store.layout().projects) {
      if (p.name !== props.groupName) out.push({ label: p.name, group: p.name });
    }
    return out;
  };
  const toggleMenu = (e: Event) => {
    e.stopPropagation();
    menu.toggle();
  };

  // ---- drag reorder ----
  // Armed when a mouse, trackpad or stylus is present — NOT when the primary
  // pointer happens to be fine. On a touchscreen laptop the primary pointer is
  // coarse while the person drags with a mouse, and the old test left that
  // machine unable to reorder at all: no native drag, and onPointerDown ignores
  // a mouse. A phone still answers no here and keeps the touch path.
  const draggable = () => !foreign() && hasFinePointer();
  const onDragStart = (e: DragEvent) => {
    if (!draggable()) return;
    releaseHold = props.store.hold();
    props.store.setDragName(s().name);
    e.dataTransfer?.setData("text/tl-session", s().name);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };
  const onDragEnd = () => {
    props.store.setDragName(null);
    setDropEdge(null);
    releaseHold?.();
    releaseHold = null;
  };
  const onDragOver = (e: DragEvent) => {
    const dragging = props.store.dragName();
    if (!dragging || dragging === s().name) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropEdge(e.clientY < rect.top + rect.height / 2 ? "above" : "below");
  };
  const onDragLeave = () => setDropEdge(null);
  const onDrop = async (e: DragEvent) => {
    const dragging = props.store.dragName() || e.dataTransfer?.getData("text/tl-session");
    const edge = dropEdge();
    setDropEdge(null);
    if (!dragging || dragging === s().name) return;
    e.preventDefault();
    e.stopPropagation();
    // Hand the store the CARD the drop landed on, never a rendered index: the
    // render is a filtered view of the layout, so the two coordinate systems
    // disagree wherever a dead ref or a leftover sits.
    await props.store.move(dragging, props.groupName, {
      name: s().name,
      side: edge ?? "below",
    });
  };

  /**
   * Long-press opens the actions menu on a touch screen.
   *
   * The ⋯ button is a 40px target living inside a 40px row, so on a phone a
   * thumb aiming at the row's right half opens the menu instead of the session.
   * Holding anywhere on the row gets the same menu, which lets the button hide
   * on coarse pointers (see .tl-card-actions in sidebar.css) and hands the whole
   * row back to "open this session".
   */
  const HOLD_MS = 450;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let holdFired = false;

  const endHold = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  const onHoldStart = (e: PointerEvent) => {
    if (e.pointerType === "mouse" || foreign()) return;
    holdFired = false;
    endHold();
    holdTimer = setTimeout(() => {
      holdFired = true;
      holdTimer = undefined;
      // The finger has stopped being a swipe and become a hold. It may now do
      // either of two things: come up, and leave the menu open, or move, and
      // take the row with it (see startDrag).
      armed = true;
      swipeFrom = null;
      menu.toggle();
    }, HOLD_MS);
  };

  onCleanup(endHold);

  /**
   * Swipe the row to act on the session: left opens it (Viktor, 2026-08-20),
   * right kills it behind the same confirm the ⋯ menu asks (Viktor, 2026-08-21).
   *
   * On a phone the list is the whole screen and the other way in is a tap on a
   * 40px row. Leftward is the direction the session view already uses to move
   * forward (mobile/swipe.ts), and the same classifier decides here: too slow,
   * too short, or more vertical than horizontal is the list scrolling rather
   * than a swipe.
   *
   * Rightward is also the platform back gesture, so it will sometimes be eaten
   * by the OS before the page sees it. That is a safe way to fail — nothing
   * happens — and the confirm is what makes the other direction safe: a swipe
   * cannot kill a session on its own, it can only ask.
   *
   * Someone else's session does not trail rightward at all. The whole actions
   * menu is hidden for a shared row, so a gesture that looked like it would
   * kill one would be promising something this row cannot do.
   */
  /** How far the row follows the finger before it stops moving. */
  const SWIPE_TRAIL_PX = 96;
  /** Movement past this is a drag, so the long-press must not fire behind it. */
  const HOLD_SLOP_PX = 8;
  /** Travel that settles which gesture this is. Small, because the browser
   *  stops listening once it has started scrolling. */
  const AXIS_LOCK_PX = 10;
  const [swipeDx, setSwipeDx] = createSignal(0);
  let swipeFrom: { x: number; y: number } | null = null;
  /** the row itself, for the non-passive listener and the scroller lookup. */
  let cardEl: HTMLElement | undefined;
  /** where the finger is across the screen, for the drag's fallback aim. */
  let lastX = 0;
  /** Which way the finger claimed: "x" is this row's, "y" is the list's. */
  let axis: "x" | "y" | null = null;

  const onPointerDown = (e: PointerEvent) => {
    onHoldStart(e);
    if (e.pointerType === "mouse") return;
    axis = null;
    armed = false;
    liftFrom = e.clientY;
    lastX = e.clientX;
    swipeFrom = { x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: PointerEvent) => {
    lastX = e.clientX;
    if (lifted()) {
      trackDrag(e.clientY);
      return;
    }
    if (armed) {
      // The hold has fired and the finger is moving: that is a drag, not a tap
      // on the menu that just opened.
      if (Math.abs(e.clientY - liftFrom) >= DRAG_START_PX) startDrag(e.clientY);
      return;
    }
    if (!swipeFrom) return;
    const dx = e.clientX - swipeFrom.x;
    const dy = e.clientY - swipeFrom.y;
    // A finger that has moved is not holding still, whichever way it went.
    if (Math.abs(dx) > HOLD_SLOP_PX || Math.abs(dy) > HOLD_SLOP_PX) endHold();
    if (!axis && Math.max(Math.abs(dx), Math.abs(dy)) >= AXIS_LOCK_PX) {
      axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      // Down the list: this row is out of it, and it must not trail a scroll.
      if (axis === "y") cancelSwipe();
    }
    if (axis !== "x") return;
    // Follow the finger, and stop trailing well before the row leaves the
    // screen: this shows the gesture landing, it is not a reveal.
    if (dx < 0) setSwipeDx(Math.max(dx, -SWIPE_TRAIL_PX));
    else setSwipeDx(foreign() ? 0 : Math.min(dx, SWIPE_TRAIL_PX));
  };

  /**
   * Hold the page still for a swipe this row has claimed.
   *
   * A browser accepts a refusal to scroll only while it is still deciding: once
   * it has committed, touchmove stops being cancelable and it sends
   * `pointercancel` instead, which is exactly what a thumb that hesitated
   * downward produced on the deployed build. `touch-action: pan-y` alone was
   * not enough, because it leaves the vertical scroll on the table.
   *
   * Registered by hand rather than as JSX, because Solid delegates touch
   * handlers to the document, where the browser makes them passive and
   * `preventDefault()` is ignored.
   */
  const onTouchMove = (e: TouchEvent) => {
    if ((axis === "x" || lifted()) && e.cancelable) e.preventDefault();
  };

  const endSwipe = (e: PointerEvent) => {
    if (lifted()) {
      void drop();
      return;
    }
    armed = false;
    endHold();
    const from = swipeFrom;
    const claimed = axis === "x";
    swipeFrom = null;
    axis = null;
    setSwipeDx(0);
    if (!from || !claimed || editing()) return;
    // Distance alone, since the axis was settled at the start: the row has been
    // following the finger the whole way, so releasing it is the decision and
    // how long the finger took is not this gesture's business. A finger that
    // comes back to where it started has undone it.
    const dx = e.clientX - from.x;
    if (Math.abs(dx) < SWIPE_MIN_PX) return;
    if (dx < 0) {
      menu.close();
      props.store.select(s().name, foreign() ? s().owner : undefined);
    } else if (!foreign()) {
      void kill(); // asks first, exactly as the menu's Kill does
    }
  };

  /**
   * Drag the row to reorder it, once the long press has armed one.
   *
   * The mouse reorders with HTML5 drag-and-drop (above), which a touch screen
   * never fires — so before this a phone could reorder sessions only by not
   * being a phone. Viktor asked for both from the one press (2026-08-22) and
   * chose the order: the hold opens the menu as it always has, and moving the
   * finger afterwards closes it and takes the row along.
   *
   * The lifted row publishes where it would land rather than deciding alone,
   * because the indicator belongs to the row being dropped ON — which is a
   * different component, and often in a different group (store.dropSpot).
   */
  /** Movement after the hold that means "drag", not a wobbling thumb. */
  const DRAG_START_PX = 4;
  const [lifted, setLifted] = createSignal(false);
  const [liftDy, setLiftDy] = createSignal(0);
  /** the hold fired and the finger is still down: a drag may start. */
  let armed = false;
  let liftFrom = 0;
  let lastY = 0;
  let scroller: HTMLElement | null = null;
  /** The list's scroll position when the row was lifted. `liftDy` is a
   *  `translateY`, which is relative to the row's own LAYOUT box — and that box
   *  lives inside the scroller, so it moves whenever the list does. Without this
   *  baseline the transform is a client-space delta measured against an origin
   *  that has since slid: every pixel scrolled is a pixel the row falls behind
   *  the finger. Measured on a phone: drift equalled the scroll exactly, in both
   *  directions, and never recovered. */
  let scrollFrom = 0;
  /**
   * How far the list could scroll when the row was lifted — the end of the
   * list, and where the auto-scroll has to stop.
   *
   * It needs recording because the answer changes DURING a drag: the lifted
   * row's own `translateY` counts toward its scroller's scrollable overflow, so
   * a row that has travelled past the list's bottom makes the list longer, and
   * the auto-scroll below would then have somewhere new to go — and would
   * extend it again. Measured in a browser: scrollHeight - clientHeight climbed
   * from 255 to 1,356 while a thumb rested still at the edge, carrying the list
   * 952px past its end. `store.hold()` freezes the rows for the duration of the
   * drag, so the reading taken at lift is good until it ends.
   */
  let scrollMax = 0;
  let scrollRaf: number | undefined;

  const startDrag = (y: number) => {
    armed = false;
    menu.close();
    setLifted(true);
    props.store.setDragName(s().name);
    // Same hold the mouse drag takes: a poll that rebuilt the list mid-drag
    // would move the rows out from under the finger.
    if (!releaseHold) releaseHold = props.store.hold();
    scroller = cardEl?.closest<HTMLElement>(".tl-sidebar-scroll") ?? null;
    // After the closest() above, not at pointerdown: that is where the scroller
    // becomes known. (`endDrag` leaves the reference in place, so reading it any
    // earlier would take the previous drag's list.)
    scrollFrom = scroller?.scrollTop ?? 0;
    scrollMax = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
    trackDrag(y);
  };

  /**
   * Put the lifted row under the finger: how far the finger has travelled, plus
   * how far the list has travelled beneath it.
   *
   * The scroll term is read LIVE and compared against the lift-time baseline
   * rather than accumulated from tickScroll's own steps — so a scroll from any
   * source is absorbed (a momentum fling, a programmatic scroll), and the row
   * stops moving when the list clamps at either end instead of running past it.
   */
  const place = () => setLiftDy(lastY - liftFrom + (scroller?.scrollTop ?? 0) - scrollFrom);

  const trackDrag = (y: number) => {
    lastY = y;
    place();
    aim(y);
    tickScroll();
  };

  /** What the finger is over, published for whoever has to draw it. */
  const aim = (y: number) => {
    // Aimed down the middle of the list rather than at the finger's own x: a
    // thumb drifts sideways as it travels, and the rows it is dragging past do
    // not move.
    const box = scroller?.getBoundingClientRect();
    const x = box && box.width > 0 ? box.left + box.width / 2 : lastX;
    const under = document.elementFromPoint?.(x, y) as HTMLElement | null;
    const card = under?.closest?.(".tl-card") as HTMLElement | null;
    const overName = card?.dataset.name;
    if (overName && overName !== s().name) {
      const r = card!.getBoundingClientRect();
      props.store.setDropSpot({
        group: card!.dataset.group ?? "",
        anchor: { name: overName, side: dropSide(y, r.top, r.height) },
      });
      return;
    }
    // A group's header means "into this group", and lets the layout place it.
    const header = under?.closest?.(".tl-group-header") as HTMLElement | null;
    const group = header?.dataset.group;
    if (group !== undefined) {
      props.store.setDropSpot({ group });
      return;
    }
    // Over nothing: the empty space past the last row, or a gap between
    // groups. The last place the indicator showed STAYS showing, because the
    // list scrolls itself near its edges — the last row climbs away from the
    // finger, and a drag aimed at it lands just below it. Measured on the
    // deployed build: 2px past the end, and the drop went nowhere.
  };

  /**
   * Scroll the list while the finger rests near its edge, so a session can be
   * moved past the eight or so rows a phone shows at once.
   */
  const tickScroll = () => {
    if (scrollRaf !== undefined || !scroller) return;
    const step = () => {
      scrollRaf = undefined;
      const box = scroller?.getBoundingClientRect();
      if (!scroller || !lifted() || !box || box.height <= 0) return;
      const by = edgeScroll(lastY, box.top, box.bottom);
      if (by === 0) return;
      // Clamped to where the list ended when the row was lifted, not to where
      // it ends now — see scrollMax. Without this the row extends the list as
      // it travels and the scroll never arrives anywhere.
      const to = Math.max(0, Math.min(scroller.scrollTop + by, scrollMax));
      if (to === scroller.scrollTop) return;
      scroller.scrollTop = to;
      // Both of these, for the same reason: the rows moved under a finger that
      // did not. `place()` has to be called rather than left to reactivity —
      // `liftDy` is a signal and `scrollTop` is a plain DOM property with
      // nothing reactive behind it, so a scroll on its own re-renders nothing.
      // This loop is the only thing that moves the list without a pointer event,
      // and before this call the row simply stayed where the last move left it.
      place();
      aim(lastY);
      scrollRaf = requestAnimationFrame(step);
    };
    scrollRaf = requestAnimationFrame(step);
  };

  const drop = async () => {
    const spot = props.store.dropSpot();
    endDrag();
    if (!spot) return;
    await props.store.move(s().name, spot.group, spot.anchor);
  };

  const endDrag = () => {
    armed = false;
    setLifted(false);
    setLiftDy(0);
    props.store.setDragName(null);
    props.store.setDropSpot(null);
    if (scrollRaf !== undefined) cancelAnimationFrame(scrollRaf);
    scrollRaf = undefined;
    releaseHold?.();
    releaseHold = null;
  };

  // A row can be unmounted mid-drag (a rename landing, a session dying), and a
  // held poll or a stale indicator would outlive it.
  onCleanup(() => {
    if (lifted() || props.store.dragName() === s().name) endDrag();
  });

  /** Where the FINGER says this row's own indicator goes, if anywhere. */
  const dropFromTouch = () => {
    const spot = props.store.dropSpot();
    return spot?.anchor?.name === s().name ? spot.anchor.side : null;
  };

  const cancelSwipe = () => {
    if (lifted()) {
      endDrag();
      return;
    }
    armed = false;
    endHold();
    swipeFrom = null;
    setSwipeDx(0);
  };

  return (
    <div
      // the ⋯ button and its popup both live in here, so the row is the menu's
      // anchor: a press anywhere else on the page dismisses it. The touchmove
      // listener rides along, since it has to be non-passive (see onTouchMove).
      ref={(el) => {
        menu.anchor(el);
        cardEl = el;
        el.addEventListener("touchmove", onTouchMove, { passive: false });
        onCleanup(() => el.removeEventListener("touchmove", onTouchMove));
      }}
      class="tl-card"
      style={
        lifted()
          ? { transform: `translateY(${liftDy()}px)` }
          : swipeDx()
            ? { transform: `translateX(${swipeDx()}px)` }
            : undefined
      }
      // What the row is offering to do while it trails, so a destructive
      // direction looks destructive before the finger comes up.
      data-swipe={swipeDx() === 0 ? undefined : swipeDx() > 0 ? "kill" : "open"}
      // Read by a finger dragging another row: elementFromPoint hands back a
      // DOM node, and this is how that node says which session it is.
      data-name={s().name}
      data-group={props.groupName}
      classList={{
        "tl-card-swiping": swipeDx() !== 0,
        "tl-card-lifted": lifted(),
        "tl-card-active": isActive(),
        "tl-card-unseen": unseen(),
        "tl-card-foreign": foreign(),
        "tl-drop-above": dropEdge() === "above" || dropFromTouch() === "above",
        "tl-drop-below": dropEdge() === "below" || dropFromTouch() === "below",
      }}
      role="button"
      tabindex={0}
      draggable={draggable()}
      aria-label={
        `session ${label()}` +
        (s().tool ? ", " + TOOL_LABELS[s().tool!] : "") +
        (s().state ? ", " + stateLabel(s().state, unseen()) : "")
      }
      onClick={activate}
      onKeyDown={onKey}
      onDblClick={beginRename}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endSwipe}
      onPointerCancel={cancelSwipe}
      onPointerLeave={cancelSwipe}
      onContextMenu={(e) => {
        // A long press raises the platform context menu on top of ours.
        if (holdFired) e.preventDefault();
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <Show when={props.badge?.(s().name)} keyed>
        {(label) => (
          <span class="tl-kb-badge" aria-hidden="true">
            {label}
          </span>
        )}
      </Show>
      <StateDot state={s().state} unseen={unseen()} />
      <ToolIcon tool={s().tool} />
      <Show
        when={!editing()}
        fallback={
          <span class="tl-card-rename-wrap">
            <input
              ref={inputEl}
              class="tl-card-rename"
              value={label()}
              maxlength={MAX_TITLE_RUNES}
              onClick={(e) => e.stopPropagation()}
              onDblClick={(e) => e.stopPropagation()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") void commitRename();
                else if (e.key === "Escape") endRename();
              }}
              onBlur={endRename}
            />
            {/* The derived name, shown only while it differs from what was
                typed — otherwise it is the same string twice. This is the one
                place the slug is visible, and it is what makes a "that name is
                taken" message make sense. */}
            <Show when={derivedName() !== draft() && draft() !== ""}>
              <span class="tl-card-rename-hint" aria-hidden="true">
                {derivedName()}
              </span>
            </Show>
          </span>
        }
      >
        <span class="tl-card-name" title={titleAttr()}>
          {label()}
        </span>
      </Show>

      <Show when={foreign()}>
        <span class="tl-card-owner" title={`${s().owner} · ${s().access === "rw" ? "read-write" : "read-only"}`}>
          {s().access === "rw" ? "✎" : "👁"} {s().owner}
        </span>
      </Show>

      {/* Watch marker. Deliberately only shown when this device WOULD watch:
          driving is the ordinary case and does not need a mark. Suppressed on a
          foreign session, whose owner badge already carries 👁 for a read-only
          share — two eyes on one row would say the same thing twice. */}
      <Show when={!foreign() && willWatch()}>
        <span
          class="tl-card-watch"
          title={
            choice() === true
              ? "Watch only: set for this session on this device"
              : "Someone is driving this session — you will join as a viewer"
          }
          aria-label="opens as a viewer"
        >
          👁
        </span>
      </Show>

      {/* Omitted entirely rather than rendered empty: the row is a flex
          container with a gap, so an empty span would leave a hole where the
          time used to be. */}
      <Show when={rightText()}>
        {(text) => (
          <span
            class="tl-card-time"
            classList={{ "tl-card-time-running": s().state === "running" }}
          >
            {text()}
          </span>
        )}
      </Show>

      <Show when={!foreign()}>
        <button
          class="tl-card-actions"
          aria-label="Session actions"
          title="Session actions"
          onClick={toggleMenu}
        >
          ⋯
        </button>
      </Show>

      <Show when={menu.open()}>
        {/* Rename and Kill lead the menu: they are the actions actually
            reached for (Viktor, 2026-08-02). Rename stays first so the
            destructive one is not the item under the opening cursor. */}
        <div class="tl-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button class="tl-menu-item" role="menuitem" onClick={() => beginRename()}>
            Rename
          </button>
          <button class="tl-menu-item tl-menu-danger" role="menuitem" onClick={() => void kill()}>
            Kill
          </button>
          {/* Attach as. In a tab acting as another user the same three rows
              apply to THEIR session, and Auto means watch rather than "watch if
              busy": `driven` there counts their clients, and a session nobody
              is driving is still theirs. The label names whose account the rows
              are about, because the answer is remembered per target. */}
          <div class="tl-menu-label">
            {lens() ? `Attach as — in ${lens()}'s account` : "Attach as"}
          </div>
          <button
            class="tl-menu-item"
            role="menuitemradio"
            aria-checked={choice() === undefined}
            onClick={() => setChoice(undefined)}
          >
            {choice() === undefined ? "✓ " : "\u2007 "}
            {lens() ? "Auto — watch" : "Auto — watch if busy"}
          </button>
          <button
            class="tl-menu-item"
            role="menuitemradio"
            aria-checked={choice() === true}
            onClick={() => setChoice(true)}
          >
            {choice() === true ? "✓ " : "\u2007 "}Watch only
          </button>
          <button
            class="tl-menu-item"
            role="menuitemradio"
            aria-checked={choice() === false}
            onClick={() => setChoice(false)}
          >
            {choice() === false ? "✓ " : "\u2007 "}Take control
          </button>
          <Show when={targets().length > 0}>
            <div class="tl-menu-label">Move to</div>
            <For each={targets()}>
              {(t) => (
                <button class="tl-menu-item" role="menuitem" onClick={() => void moveTo(t.group)}>
                  {t.label}
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
};
