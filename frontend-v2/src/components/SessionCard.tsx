import {
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  type Component,
} from "solid-js";
import { sessionConfirmLabel, sessionLabel, sessionTitleDraft, type Session } from "../types/lobby";
import { MAX_TITLE_RUNES } from "../lib/title";
import type { LobbyStore } from "../store/lobby";
import { backgroundLabel, formatWorking, relativeTime, stateLabel } from "./lobby.logic";
import { createDismissableMenu, stopMenuActivationKey, stopMenuClick } from "./menu";
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
import { ACT_AS } from "../lib/config";

/**
 * A thin session row (inventory Cat.2 "Session card"): state dot + name (left),
 * live working timer / relative time (right), an optional foreign owner badge,
 * and a ⋯ actions menu. Own cards rename inline on double-click and are dragged
 * to reorder by the group's sortable (dnd/sidebar.ts), which owns every drag
 * gesture the row has; what is left here is the swipe and the long press.
 * Activate on click / Enter / Space.
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
  const titleAttr = () => (s().pane_title ? `${s().name} · ${s().pane_title}` : s().name);

  /** What the rename box opens on: the session's own title, "" when it has
   *  none. Never `label()` — offering `New session` for editing invites saving
   *  the placeholder as a real title, and a stamped title is what stops
   *  Claude's summary from ever landing (tmux-api/autotitle.go). */
  const titleDraft = () => sessionTitleDraft(s());

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
  // Placed: the popup is measured against the window rather than hung off the
  // bottom of this row, which is what a row near the end of a long list needs
  // (see .tl-menu-placed in sidebar.css).
  const menu = createDismissableMenu(() => props.store.hold(), { placed: true });
  let releaseHold: (() => void) | null = null;
  let inputEl: HTMLInputElement | undefined;

  // The rename box holds the poll and only its own end handler gives it back —
  // so a card that goes away while one is open (its group collapsing does
  // exactly that, and until the model was stabilized so did any poll) stranded
  // the sidebar: the hold count never returned to zero and nothing polled again
  // for the rest of the session. Same backstop ProjectGroup keeps on its add
  // box; a drag's own hold lives with the drag, in dnd/sidebar.ts.
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
    // The box edits the TITLE. The tmux name follows it server-side
    // (ADR-0022), which is what keeps `tmux ls` readable, but nothing here has
    // to know: the poll brings the new name back and the selection follows it
    // by session id. An empty one clears the title, handing the session back to
    // whatever summary lands next; the name stays where it is.
    if (next !== titleDraft()) await props.store.rename(s().name, next);
  };

  // ---- actions ----
  // Killing is unrecoverable, so it confirms here exactly as every sibling path
  // does (the kill chord, the palette action, Delete project).
  const kill = async () => {
    menu.close();
    const ask = props.confirm ?? ((m: string) => window.confirm(m));
    // Named by its id when it has no title: killing cannot be undone, and
    // `Kill session "New session"?` reads the same for every untitled session.
    if (!ask(`Kill session "${sessionConfirmLabel(s())}"?`)) return;
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
      // take the row with it. `holdFired` is what makes onPointerMove stop
      // treating the same press as a swipe; the origin stays recorded, because
      // that branch still needs to know how far the finger has since travelled.
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
  /** Which way the finger claimed: "x" is this row's, "y" is the list's. */
  let axis: "x" | "y" | null = null;

  const onPointerDown = (e: PointerEvent) => {
    onHoldStart(e);
    if (e.pointerType === "mouse") return;
    axis = null;
    swipeFrom = { x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!swipeFrom) return;
    const dx = e.clientX - swipeFrom.x;
    const dy = e.clientY - swipeFrom.y;
    // A finger that has moved is not holding still, whichever way it went.
    if (Math.abs(dx) > HOLD_SLOP_PX || Math.abs(dy) > HOLD_SLOP_PX) endHold();
    // The hold has fired, the menu is open, and the finger is moving. That is
    // the drag library lifting this row — it runs a press timer of its own on
    // the same 450ms (dnd/sidebar.ts), so one press does both, in the order
    // Viktor chose on 2026-08-22. The swipe is off the table for the rest of
    // this press, which is why this returns rather than falling through. The
    // menu closes when the drag actually begins, announced on the document,
    // because a touchscreen stops sending this row pointer events the moment it
    // hands the gesture over.
    if (holdFired) return;
    if (!axis && Math.max(Math.abs(dx), Math.abs(dy)) >= AXIS_LOCK_PX) {
      axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      // Down the list: this row is out of it, and it must not trail a scroll.
      if (axis === "y") cancelSwipe();
      // Across: the row is about to take an inline transform, and the actions
      // popup is a `position: fixed` child of it (.tl-menu-placed). A
      // transformed element becomes the containing block for its fixed
      // descendants, so the window coordinates placeMenu computed would stop
      // meaning window coordinates and start being measured from this row —
      // measured in Chrome, a popup sitting at top 300 in a 900px window landed
      // at 1084 the instant the card took a translateX, and .tl-card carries a
      // 160ms transform transition, so it stays wrong for that long after the
      // finger comes up. There is a live path to it: a hold opens the menu and
      // deliberately leaves it open when the finger lifts, so the next finger
      // down and across on the same row swipes underneath an open menu. Closing
      // is what a lift one branch up does, for the same reason and to the same
      // end — the gesture has taken the row, and the menu is not part of it.
      if (axis === "x") menu.close();
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
   * Only the swipe needs this now. A lifted row is held still by the drag
   * library, which cancels touchmove on the document for as long as one is in
   * the air.
   *
   * Registered by hand rather than as JSX, because Solid delegates touch
   * handlers to the document, where the browser makes them passive and
   * `preventDefault()` is ignored.
   */
  const onTouchMove = (e: TouchEvent) => {
    if (axis === "x" && e.cancelable) e.preventDefault();
  };

  const endSwipe = (e: PointerEvent) => {
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

  const cancelSwipe = () => {
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
        el.addEventListener("touchmove", onTouchMove, { passive: false });
        // Capture, and on the element rather than as JSX. The drag library
        // registers a `pointerup` of its own on every row it manages and calls
        // stopPropagation from it, which is fine for the library and fatal for
        // us: Solid DELEGATES pointer handlers to the document, so an
        // `onPointerUp` in the markup below would never be reached and a swipe
        // would trail the finger and then do nothing when it lifted (measured
        // in the swipe suite the moment the library went in). Capturing on the
        // row means this runs on the way down, before anything can stop the
        // event on the way up.
        el.addEventListener("pointerup", endSwipe as EventListener, true);
        onCleanup(() => {
          el.removeEventListener("touchmove", onTouchMove);
          el.removeEventListener("pointerup", endSwipe as EventListener, true);
        });
      }}
      class="tl-card"
      style={swipeDx() ? { transform: `translateX(${swipeDx()}px)` } : undefined}
      // What the row is offering to do while it trails, so a destructive
      // direction looks destructive before the finger comes up.
      data-swipe={swipeDx() === 0 ? undefined : swipeDx() > 0 ? "kill" : "open"}
      // The row's identity in the DOM: the drag library carries values, not
      // elements, and a test reads a row back by name.
      data-name={s().name}
      data-group={props.groupName}
      classList={{
        "tl-card-swiping": swipeDx() !== 0,
        "tl-card-active": isActive(),
        "tl-card-unseen": unseen(),
        "tl-card-foreign": foreign(),
      }}
      role="button"
      tabindex={0}
      aria-label={
        `session ${label()}` +
        (s().tool ? ", " + TOOL_LABELS[s().tool!] : "") +
        (s().state ? ", " + stateLabel(s().state, unseen(), s().bg) : "")
      }
      onClick={activate}
      onKeyDown={onKey}
      onDblClick={beginRename}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerCancel={cancelSwipe}
      onPointerLeave={cancelSwipe}
      onContextMenu={(e) => {
        // A long press raises the platform context menu on top of ours.
        if (holdFired) e.preventDefault();
      }}
    >
      <Show when={props.badge?.(s().name)} keyed>
        {(label) => (
          <span class="tl-kb-badge" aria-hidden="true">
            {label}
          </span>
        )}
      </Show>
      <StateDot state={s().state} unseen={unseen()} bg={s().bg} />
      <ToolIcon tool={s().tool} />
      <Show
        when={!editing()}
        fallback={
          <input
            ref={inputEl}
            class="tl-card-rename"
            value={titleDraft()}
            maxlength={MAX_TITLE_RUNES}
            onClick={(e) => e.stopPropagation()}
            onDblClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void commitRename();
              else if (e.key === "Escape") endRename();
            }}
            onBlur={endRename}
          />
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

      {/* What the session is waiting on, when it is waiting on something. It
          sits beside the timer rather than replacing it: the elapsed time is
          how long the wait has been, and the kind is what decides whether it
          is worth waiting — a background command is usually seconds, a
          workflow can be half an hour. */}
      <Show when={backgroundLabel(s().bg)}>
        {(what) => (
          <span class="tl-card-bg" title={`Still working: ${what()}`}>
            {what()}
          </span>
        )}
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
        <div
          class="tl-menu tl-menu-placed"
          role="menu"
          ref={menu.popup}
          style={menu.style()}
          onClick={stopMenuClick}
          onKeyDown={stopMenuActivationKey}
        >
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
