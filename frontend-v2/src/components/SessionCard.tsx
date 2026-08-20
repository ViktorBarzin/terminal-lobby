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
import { watchLockedFor } from "../lib/act-as";
import { swipeDirection } from "../mobile/swipe";
import { ACT_AS } from "../lib/config";

const isCoarse = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

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
  /** confirm seam (window.confirm by default; injectable for tests). */
  confirm?: (message: string) => boolean;
  /** The roamed `sidebar.showLastActive` pref. Absent means hidden — the safe
   *  direction for a setting that is off by default, so a call site that
   *  forgets to pass it errs towards showing less rather than more. */
  showLastActive?: Accessor<boolean>;
}> = (props) => {
  const s = () => props.session;
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

  const choice = () => watchChoice(s().name);
  /** TRUE while this tab acts as another user: every session in it opens as a
   *  viewer, so Attach as has nothing left to choose. Derived from the store's
   *  own /whoami rather than passed down, so the sidebar and the session bar
   *  cannot disagree about it. */
  const locked = () => watchLockedFor(props.store.whoami(), ACT_AS);
  const willWatch = () =>
    resolvedWatchFor(s().name) ??
    resolveWatch(choice(), s().driven === true, locked());

  const setChoice = (c: WatchChoice) => {
    if (locked()) return;
    saveWatch(s().name, c);
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
  const draggable = () => !foreign() && !isCoarse();
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
      menu.toggle();
    }, HOLD_MS);
  };

  onCleanup(endHold);

  /**
   * Swipe the row left to open the session (Viktor, 2026-08-20).
   *
   * The second way in on a phone, where the list is the whole screen and the
   * first way is a tap on a 40px row. Leftward is the direction the session view
   * already uses to move forward (mobile/swipe.ts), and the same classifier
   * decides here: too slow, too short, or more vertical than horizontal is the
   * list scrolling rather than a swipe.
   *
   * A rightward drag does nothing. It is what an iOS reader reaches for to go
   * back, and a row that opened a session on either direction would be a row you
   * could not scroll past.
   */
  /** How far the row follows the finger before it stops moving. */
  const SWIPE_TRAIL_PX = 96;
  /** Movement past this is a drag, so the long-press must not fire behind it. */
  const HOLD_SLOP_PX = 8;
  const [swipeDx, setSwipeDx] = createSignal(0);
  let swipeFrom: { x: number; y: number; at: number } | null = null;

  const onPointerDown = (e: PointerEvent) => {
    onHoldStart(e);
    if (e.pointerType === "mouse") return;
    swipeFrom = { x: e.clientX, y: e.clientY, at: Date.now() };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!swipeFrom) return;
    const dx = e.clientX - swipeFrom.x;
    const dy = e.clientY - swipeFrom.y;
    // A finger that has moved is not holding still, whichever way it went.
    if (Math.abs(dx) > HOLD_SLOP_PX || Math.abs(dy) > HOLD_SLOP_PX) endHold();
    // Follow the finger leftward only, and stop trailing well before the row
    // leaves the screen: this shows the gesture landing, it is not a reveal.
    setSwipeDx(dx < 0 ? Math.max(dx, -SWIPE_TRAIL_PX) : 0);
  };

  const endSwipe = (e: PointerEvent) => {
    endHold();
    const from = swipeFrom;
    swipeFrom = null;
    setSwipeDx(0);
    if (!from) return;
    const dir = swipeDirection({
      dx: e.clientX - from.x,
      dy: e.clientY - from.y,
      ms: Date.now() - from.at,
    });
    // "next" is the leftward one — the same word the session view uses for it.
    if (dir !== "next" || editing()) return;
    menu.close();
    props.store.select(s().name, foreign() ? s().owner : undefined);
  };

  const cancelSwipe = () => {
    endHold();
    swipeFrom = null;
    setSwipeDx(0);
  };

  return (
    <div
      // the ⋯ button and its popup both live in here, so the row is the menu's
      // anchor: a press anywhere else on the page dismisses it.
      ref={menu.anchor}
      class="tl-card"
      style={swipeDx() ? { transform: `translateX(${swipeDx()}px)` } : undefined}
      classList={{
        "tl-card-swiping": swipeDx() !== 0,
        "tl-card-active": isActive(),
        "tl-card-foreign": foreign(),
        "tl-drop-above": dropEdge() === "above",
        "tl-drop-below": dropEdge() === "below",
      }}
      role="button"
      tabindex={0}
      draggable={draggable()}
      aria-label={
        `session ${label()}` +
        (s().tool ? ", " + TOOL_LABELS[s().tool!] : "") +
        (s().state ? ", " + stateLabel(s().state) : "")
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
      <StateDot state={s().state} unseen={s().state === "done"} />
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
          {/* Attach as. In a tab acting as another user the three rows are
              disabled and Watch only reads as the standing answer: the choice
              was made by being in a lens, and a control that re-navigated to
              the same read-only attach would only look broken. */}
          <div class="tl-menu-label">
            {locked()
              ? "Attach as — watching (acting as another user)"
              : "Attach as"}
          </div>
          <button
            class="tl-menu-item"
            role="menuitemradio"
            aria-checked={!locked() && choice() === undefined}
            disabled={locked()}
            onClick={() => setChoice(undefined)}
          >
            {!locked() && choice() === undefined ? "✓ " : "\u2007 "}Auto — watch if busy
          </button>
          <button
            class="tl-menu-item"
            role="menuitemradio"
            aria-checked={locked() || choice() === true}
            disabled={locked()}
            onClick={() => setChoice(true)}
          >
            {locked() || choice() === true ? "✓ " : "\u2007 "}Watch only
          </button>
          <button
            class="tl-menu-item"
            role="menuitemradio"
            aria-checked={!locked() && choice() === false}
            disabled={locked()}
            onClick={() => setChoice(false)}
          >
            {!locked() && choice() === false ? "✓ " : "\u2007 "}Take control
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
