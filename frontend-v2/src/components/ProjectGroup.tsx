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
import { countStates, groupSeqTokens, groupToken, visibleGroupSeqTokens } from "./lobby.logic";
import type { LobbyStore } from "../store/lobby";
import { UNGROUPED_KEY } from "../store/collapse";
import { createDismissableMenu } from "./menu";
import { track } from "../telemetry/track";
import { SessionCard } from "./SessionCard";
import { StateDot } from "./StateDot";
import { hasFinePointer } from "../mobile/pointer";

/**
 * One sidebar group — a project or the Ungrouped section (inventory Cat.2/3):
 * a collapsible header (chevron/title/count/+/⋯) over its session cards. The
 * header is a drop target for a dragged session (append into this group) and,
 * for reordering, is itself draggable + accepts a dragged header. Reorder and
 * move-up/down go through the store's whole-layout transforms.
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

  const menu = createDismissableMenu(() => props.store.hold());
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

  // ---- session drop target (append into this group) + header drag reorder ----
  // Same rule as a session card: a mouse is present, so native drag is usable.
  const headerDraggable = () => hasFinePointer();
  // A drag lives in the DOM node being dragged, so the poll must not rebuild
  // the group set underneath it — the same hold the add box, the menu and a
  // card drag take. Without it a poll mid-drag detaches the source (the browser
  // then fires neither drop nor dragend, and the move is silently swallowed) or
  // reflows a different group under the cursor (the move persists into the
  // wrong slot, and saveLayout only toasts in its catch, so nothing says so).
  let releaseHeaderDrag: (() => void) | null = null;
  const endHeaderDrag = () => {
    releaseHeaderDrag?.();
    releaseHeaderDrag = null;
  };
  // dragend is not guaranteed: the drop's own reorder re-creates every header,
  // and a source that is already detached never receives it. Unmount is the
  // backstop so a missed dragend cannot strand the poll for good.
  onCleanup(endHeaderDrag);
  const onHeaderDragStart = (e: DragEvent) => {
    if (!headerDraggable()) return;
    // Guarded like beginAdd above: one drag, one hold, never a second.
    if (!releaseHeaderDrag) releaseHeaderDrag = props.store.hold();
    props.store.setDragGroup(token());
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };
  const onHeaderDragEnd = () => {
    props.store.setDragGroup(null);
    setDragOver(false);
    endHeaderDrag();
  };
  const onDragOver = (e: DragEvent) => {
    if (props.store.dragName() || props.store.dragGroup()) {
      e.preventDefault();
      setDragOver(true);
    }
  };
  const onDragLeave = () => setDragOver(false);
  /** A FINGER-dragged row is over this header, which means "into this group".
   *  The mouse gets its highlight from dragover; a touch drag has no such
   *  event, so it publishes where it is instead (store.dropSpot). */
  const fingerOver = () => {
    const spot = props.store.dropSpot();
    return (
      !!spot && !spot.anchor && spot.group === (isUngrouped() ? "" : props.group.name)
    );
  };
  const onDrop = async (e: DragEvent) => {
    setDragOver(false);
    // Covers the drop that lands back on the header it started from: no
    // reorder, so nothing re-creates this node and no unmount follows.
    endHeaderDrag();
    const sessionName = props.store.dragName() || e.dataTransfer?.getData("text/tl-session");
    const grp = props.store.dragGroup();
    if (grp) {
      e.preventDefault();
      const tokens = groupSeqTokens(props.store.layout());
      const from = tokens.indexOf(grp);
      const to = tokens.indexOf(token());
      if (from >= 0 && to >= 0 && from !== to) await props.store.reorderGroupsTo(from, to);
      return;
    }
    if (sessionName) {
      e.preventDefault();
      await props.store.move(sessionName, isUngrouped() ? "" : props.group.name);
    }
  };

  return (
    <div
      class="tl-group"
      classList={{
        "tl-group-collapsed": collapsed(),
        "tl-group-dragover": dragOver() || fingerOver(),
      }}
    >
      <div
        class="tl-group-header"
        // Read by a finger dragging a row over it: dropping here means "into
        // this group", and "" is Ungrouped.
        data-group={isUngrouped() ? "" : props.group.name}
        role="button"
        tabindex={0}
        aria-expanded={!collapsed()}
        aria-label={`${isUngrouped() ? "Ungrouped" : props.group.name} group`}
        draggable={headerDraggable()}
        onClick={toggleCollapse}
        onKeyDown={onHeaderKey}
        onDragStart={onHeaderDragStart}
        onDragEnd={onHeaderDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
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
            <div class="tl-menu" role="menu" onClick={(e) => e.stopPropagation()}>
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
        <div class="tl-group-body">
          <For each={props.group.sessions}>
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
