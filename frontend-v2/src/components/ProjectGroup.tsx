import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
  type Component,
} from "solid-js";
import type { RenderGroup } from "./lobby.logic";
import {
  countStates,
  groupSeqTokens,
  groupToken,
  sessionsByName,
  visibleGroupSeqTokens,
} from "./lobby.logic";
import type { LobbyStore } from "../store/lobby";
import { UNGROUPED_KEY } from "../store/collapse";
import { createDismissableMenu, stopMenuActivationKey, stopMenuClick } from "./menu";
import { track } from "../telemetry/track";
import { SessionCard } from "./SessionCard";
import { StateDot } from "./StateDot";
import {
  attachSessionList,
  GROUP_ATTR,
  sessionDragActive,
  liveOrder,
  TOKEN_ATTR,
} from "../dnd/sidebar";

/**
 * One sidebar group — a project or the Ungrouped section (inventory Cat.2/3):
 * a collapsible header (chevron/title/count/+/⋯) over its session cards. The
 * body is a sortable list of cards and the header is the handle the group
 * itself is dragged by, both of them registered with the drag library in
 * `dnd/sidebar.ts`; move-up/down go through the store's whole-layout
 * transforms. A collapsed group springs open when a dragged session hovers its
 * header, which is how a session reaches a group whose cards are not on screen.
 */
export const ProjectGroup: Component<{
  store: LobbyStore;
  group: RenderGroup;
  tick: Accessor<number>;
  /** Alt-hold chip label lookup, threaded down to each session card. */
  badge?: (name: string) => string | null;
  /** finished since you last looked (see Sidebar.unseenOf). */
  isUnseen?: (s: { name: string; state?: string }) => boolean;
  /** confirm seam, threaded down to each session card (tests inject it). */
  confirm?: (message: string) => boolean;
  /** the roamed `sidebar.showLastActive` pref, threaded down to each card. */
  showLastActive?: Accessor<boolean>;
  /** Show the new-session composer, preset to this project. The group used to
   *  hold its own name box; a prompt needs more room than a sidebar row has. */
  onNewSession?: (group: string) => void;
}> = (props) => {
  const isUngrouped = () => props.group.kind === "ungrouped";
  const token = () => groupToken(props.group);
  const collapseKey = () => (isUngrouped() ? UNGROUPED_KEY : props.group.name);
  const collapsed = () => props.store.collapse.isCollapsed(collapseKey());

  const [dragOver, setDragOver] = createSignal(false);

  // Bounds are measured in VISIBLE space. An empty Ungrouped keeps its slot in
  // the layout (the capture/reorder contract needs it) but renders nothing, so
  // counting it here offered the edge group a neighbour the user cannot see:
  // "Move up" came up enabled, the click only shifted the hidden sentinel, and
  // the item then greyed out having moved nothing.
  const visibleSeq = createMemo(() => visibleGroupSeqTokens(props.store.model()));
  const seqPos = createMemo(() => {
    const vis = visibleSeq();
    return { pos: vis.indexOf(token()), len: vis.length };
  });
  const canUp = () => seqPos().pos > 0;
  const canDown = () => seqPos().pos >= 0 && seqPos().pos < seqPos().len - 1;

  // Placed against the window, same as a session card's ⋯: a collapsed project
  // sitting low in the sidebar had the same popup running off the bottom of it.
  const menu = createDismissableMenu(() => props.store.hold(), { placed: true });
  /** How many of this group's finished sessions have not been read. */
  const unseenCount = (): number =>
    props.isUnseen ? props.group.sessions.filter((sn) => props.isUnseen!(sn)).length : 0;

  const counts = () => countStates(props.group.sessions);

  const toggleCollapse = () => props.store.collapse.toggle(collapseKey());
  const onHeaderKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleCollapse();
    }
  };

  // ---- new session in this group ----
  // The composer opens preset to this project, which is also what starts the
  // speculative pre-warm: it owns the warmed slot now, because the directory it
  // guesses on is the one showing in its own project selector.
  //
  // The group is expanded on the way, so the card that arrives is on screen
  // rather than inside something the user then has to open.
  const beginAdd = (e: Event) => {
    e.stopPropagation();
    menu.close();
    props.store.collapse.expand(collapseKey());
    props.onNewSession?.(isUngrouped() ? "" : props.group.name);
    // Pairs with session.created to give the window the guess had to run in.
    track("session.create_opened", { "tl.to": isUngrouped() ? "ungrouped" : props.group.name });
  };

  // ---- project actions ----
  const rename = async () => {
    menu.close();
    const next = window.prompt("Rename project", props.group.name);
    if (next) await props.store.renameProjectAction(props.group.name, next);
  };
  const del = async () => {
    menu.close();
    const n = props.group.sessions.length;
    const msg = n > 0 ? `Delete project "${props.group.name}"? Its ${n} session(s) move to Ungrouped (not killed).` : `Delete project "${props.group.name}"?`;
    if (window.confirm(msg)) await props.store.deleteProjectAction(props.group.name);
  };
  // One click, one VISIBLE slot: land on the seat of the neighbour the user can
  // see, rather than stepping one raw token (which an invisible sentinel eats).
  // With Ungrouped on screen the two are the same move, so it still reorders
  // past it exactly as before.
  const moveBy = async (dir: -1 | 1) => {
    menu.close();
    const pos = seqPos().pos;
    if (pos < 0) return;
    const neighbour = visibleSeq()[pos + dir];
    if (neighbour === undefined) return;
    const tokens = groupSeqTokens(props.store.layout());
    const from = tokens.indexOf(token());
    const to = tokens.indexOf(neighbour);
    if (from < 0 || to < 0) return;
    await props.store.reorderGroupsTo(from, to);
  };
  const moveUp = () => moveBy(-1);
  const moveDown = () => moveBy(1);

  // ---- drag ----
  // A collapsed group has no card list to aim at, so hovering its header with a
  // session in hand opens it and hands the drop to the ordinary sortable
  // underneath. Springing open beats the old "drop on the header to append"
  // because it lands the card WHERE the pointer is rather than at the end, and
  // it is the same gesture on a mouse and a finger — the synthetic drag moves a
  // clone that takes no pointer events, so `pointermove` still reaches whatever
  // is under the finger.
  const SPRING_MS = 550;
  let springTimer: ReturnType<typeof setTimeout> | undefined;
  let headerEl: HTMLElement | undefined;
  const cancelSpring = () => {
    if (springTimer) clearTimeout(springTimer);
    springTimer = undefined;
    setDragOver(false);
  };
  /**
   * Left the header, or only crossed something inside it?
   *
   * `dragleave` fires on the way into a CHILD as well as on the way out, and
   * the header is four of them — a chevron, a title, a count and the ⋯ button.
   * Cancelling on each restarted the timer under a pointer that had not gone
   * anywhere, so the group never opened and the highlight flickered. A finger
   * needs no such check: `pointerleave` does not fire for a child.
   */
  const leaveHeader = (e: { relatedTarget: EventTarget | null }) => {
    const to = e.relatedTarget;
    if (to instanceof Node && headerEl?.contains(to)) return;
    cancelSpring();
  };
  const overHeader = () => {
    if (!sessionDragActive()) return;
    setDragOver(true);
    if (!collapsed() || springTimer) return;
    springTimer = setTimeout(() => {
      springTimer = undefined;
      props.store.collapse.expand(collapseKey());
    }, SPRING_MS);
  };
  onCleanup(cancelSpring);

  /** The cards to draw: the model's order, or the one the pointer has now. */
  const rendered = createMemo(() => {
    const order = liveOrder(isUngrouped() ? "" : props.group.name);
    if (!order) return props.group.sessions;
    const all = sessionsByName(props.store.model());
    return order.flatMap((n) => {
      const s = all.get(n);
      return s ? [s] : [];
    });
  });

  return (
    <div
      class="tl-group"
      // Read by the sidebar's own sortable: a group the layout can place says
      // which slot it holds, and the read-only "Shared with me" group says
      // nothing, which is what keeps it out of the sequence.
      {...{ [TOKEN_ATTR]: token() }}
      classList={{
        "tl-group-collapsed": collapsed(),
        "tl-group-dragover": dragOver(),
      }}
    >
      <div
        ref={(el) => {
          headerEl = el;
        }}
        class="tl-group-header"
        role="button"
        tabindex={0}
        aria-expanded={!collapsed()}
        aria-label={`${isUngrouped() ? "Ungrouped" : props.group.name} group`}
        onClick={toggleCollapse}
        onKeyDown={onHeaderKey}
        onDragOver={overHeader}
        onDragLeave={leaveHeader}
        onDrop={cancelSpring}
        onPointerMove={overHeader}
        onPointerLeave={cancelSpring}
        onPointerUp={cancelSpring}
      >
        <span class="tl-chev">▾</span>
        <span class="tl-group-title">{isUngrouped() ? "Ungrouped" : props.group.name}</span>
        {/* The count is unconditional (as the vanilla header is): the chips
            only cover members that HAVE a Claude state, so a collapsed group
            that showed chips alone hid both its total and every member
            without one. */}
        <span class="tl-group-badges">
          <span class="tl-group-count">{props.group.sessions.length}</span>
          <Show when={collapsed()}>
            <Show when={counts().running > 0}>
              <span class="tl-chip"><StateDot state="running" size={7} title={false} />{counts().running}</span>
            </Show>
            {/* Of those running, how many are waiting on background work
                rather than talking. Its own chip for the same reason unread
                has one: the running chip counts both, so a collapsed group
                could not say whether anything inside it was going to keep
                going after you looked away. The dot is deliberately the
                running one — this is a subset of running, not a state. */}
            <Show when={counts().background > 0}>
              <span
                class="tl-chip tl-chip-bg"
                title={`${counts().background} waiting on background work`}
              >
                <StateDot state="running" size={7} title={false} />
                {counts().background}
              </span>
            </Show>
            <Show when={counts().awaiting > 0}>
              <span class="tl-chip"><StateDot state="awaiting" size={7} title={false} />{counts().awaiting}</span>
            </Show>
            <Show when={counts().done > 0}>
              <span class="tl-chip"><StateDot state="done" size={7} title={false} />{counts().done}</span>
            </Show>
            {/* Unread, as its own chip. The done chip counts every finished
                session and renders dimmed, which is the inverse of what a card
                does, so a collapsed group could not say whether anything inside
                it was still waiting to be read — and that is the half of the
                app-icon count a person is most likely to be hunting for. */}
            <Show when={unseenCount() > 0}>
              <span class="tl-chip" title={`${unseenCount()} not seen yet`}>
                <StateDot state="done" unseen size={7} title={false} />
                {unseenCount()}
              </span>
            </Show>
          </Show>
        </span>
        <span class="tl-group-actions" ref={menu.anchor}>
          <Show when={!isUngrouped()}>
            <button class="tl-icon-btn" aria-label="New session in project" title="New session in project" draggable={false} onClick={beginAdd}>
              +
            </button>
          </Show>
          <button
            class="tl-icon-btn"
            aria-label="Group actions"
            title="Group actions"
            draggable={false}
            onClick={(e) => {
              e.stopPropagation();
              menu.toggle();
            }}
          >
            ⋯
          </button>
          <Show when={menu.open()}>
            <div
              class="tl-menu tl-menu-placed"
              role="menu"
              ref={menu.popup}
              style={menu.style()}
              onClick={stopMenuClick}
              onKeyDown={stopMenuActivationKey}
            >
              <Show when={!isUngrouped()}>
                <button class="tl-menu-item" role="menuitem" onClick={() => void rename()}>Rename project</button>
              </Show>
              <button class="tl-menu-item" role="menuitem" disabled={!canUp()} onClick={() => void moveUp()}>Move up</button>
              <button class="tl-menu-item" role="menuitem" disabled={!canDown()} onClick={() => void moveDown()}>Move down</button>
              <Show when={!isUngrouped()}>
                <button class="tl-menu-item tl-menu-danger" role="menuitem" onClick={() => void del()}>Delete project</button>
              </Show>
            </div>
          </Show>
        </span>
      </div>

      <Show when={!collapsed()}>
        <div
          class="tl-group-body"
          // The sortable list of this group's cards, and the name a drop reads
          // back off to say where it landed. "" is Ungrouped.
          {...{ [GROUP_ATTR]: isUngrouped() ? "" : props.group.name }}
          ref={(el) =>
            attachSessionList(el, {
              group: () => (isUngrouped() ? "" : props.group.name),
              names: () => props.group.sessions.map((s) => s.name),
              move: (name, group, anchor) => props.store.move(name, group, anchor),
              hold: () => props.store.hold(),
            })
          }
        >
          <For each={rendered()}>
            {(s) => (
              <SessionCard
                isUnseen={props.isUnseen}
                store={props.store}
                session={s}
                groupName={isUngrouped() ? "" : props.group.name}
                tick={props.tick}
                badge={props.badge}
                confirm={props.confirm}
                showLastActive={props.showLastActive}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
