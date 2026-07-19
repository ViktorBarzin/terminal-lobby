import {
  createMemo,
  createSignal,
  For,
  Show,
  type Accessor,
  type Component,
} from "solid-js";
import type { RenderGroup } from "./lobby.logic";
import { countStates, groupSeqTokens } from "./lobby.logic";
import type { LobbyStore } from "../store/lobby";
import { UNGROUPED_KEY } from "../store/collapse";
import { SessionCard } from "./SessionCard";
import { StateDot } from "./StateDot";

const isCoarse = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

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
}> = (props) => {
  const isUngrouped = () => props.group.kind === "ungrouped";
  const token = () => (isUngrouped() ? "u" : "p:" + props.group.name);
  const collapseKey = () => (isUngrouped() ? UNGROUPED_KEY : props.group.name);
  const collapsed = () => props.store.collapse.isCollapsed(collapseKey());

  const [adding, setAdding] = createSignal(false);
  const [dragOver, setDragOver] = createSignal(false);
  let addInput: HTMLInputElement | undefined;

  const seqPos = createMemo(() => {
    const tokens = groupSeqTokens(props.store.layout());
    return { pos: tokens.indexOf(token()), len: tokens.length };
  });
  const canUp = () => seqPos().pos > 0;
  const canDown = () => seqPos().pos >= 0 && seqPos().pos < seqPos().len - 1;

  const [menuOpen, setMenuOpen] = createSignal(false);
  const counts = () => countStates(props.group.sessions);

  const toggleCollapse = () => props.store.collapse.toggle(collapseKey());
  const onHeaderKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleCollapse();
    }
  };

  // ---- new session in this group ----
  const beginAdd = (e: Event) => {
    e.stopPropagation();
    setAdding(true);
    props.store.collapse.expand(collapseKey());
    queueMicrotask(() => addInput?.focus());
  };
  const commitAdd = async () => {
    const name = addInput?.value.trim() ?? "";
    if (!name) {
      setAdding(false);
      return;
    }
    const ok = await props.store.create(name, isUngrouped() ? "" : props.group.name);
    if (ok) setAdding(false);
  };

  // ---- project actions ----
  const rename = async () => {
    setMenuOpen(false);
    const next = window.prompt("Rename project", props.group.name);
    if (next) await props.store.renameProjectAction(props.group.name, next);
  };
  const del = async () => {
    setMenuOpen(false);
    const n = props.group.sessions.length;
    const msg = n > 0 ? `Delete project "${props.group.name}"? Its ${n} session(s) move to Ungrouped (not killed).` : `Delete project "${props.group.name}"?`;
    if (window.confirm(msg)) await props.store.deleteProjectAction(props.group.name);
  };
  const moveUp = async () => {
    setMenuOpen(false);
    await props.store.moveGroupBy(isUngrouped() ? "" : props.group.name, -1);
  };
  const moveDown = async () => {
    setMenuOpen(false);
    await props.store.moveGroupBy(isUngrouped() ? "" : props.group.name, 1);
  };

  // ---- session drop target (append into this group) + header drag reorder ----
  const headerDraggable = () => !isCoarse();
  const onHeaderDragStart = (e: DragEvent) => {
    if (!headerDraggable()) return;
    props.store.setDragGroup(token());
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };
  const onHeaderDragEnd = () => {
    props.store.setDragGroup(null);
    setDragOver(false);
  };
  const onDragOver = (e: DragEvent) => {
    if (props.store.dragName() || props.store.dragGroup()) {
      e.preventDefault();
      setDragOver(true);
    }
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = async (e: DragEvent) => {
    setDragOver(false);
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
    <div class="tl-group" classList={{ "tl-group-collapsed": collapsed(), "tl-group-dragover": dragOver() }}>
      <div
        class="tl-group-header"
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
        <span class="tl-group-badges">
          <Show when={collapsed()} fallback={<span class="tl-group-count">{props.group.sessions.length}</span>}>
            <Show when={counts().running > 0}>
              <span class="tl-chip"><StateDot state="running" size={7} title={false} />{counts().running}</span>
            </Show>
            <Show when={counts().awaiting > 0}>
              <span class="tl-chip"><StateDot state="awaiting" size={7} title={false} />{counts().awaiting}</span>
            </Show>
            <Show when={counts().done > 0}>
              <span class="tl-chip"><StateDot state="done" size={7} title={false} />{counts().done}</span>
            </Show>
            <Show when={counts().running + counts().awaiting + counts().done === 0}>
              <span class="tl-group-count">{props.group.sessions.length}</span>
            </Show>
          </Show>
        </span>
        <span class="tl-group-actions">
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
              setMenuOpen(!menuOpen());
            }}
          >
            ⋯
          </button>
          <Show when={menuOpen()}>
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
                store={props.store}
                session={s}
                groupName={isUngrouped() ? "" : props.group.name}
                tick={props.tick}
              />
            )}
          </For>
          <Show when={adding()}>
            <input
              ref={addInput}
              class="tl-add-input"
              placeholder="new session name…"
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitAdd();
                else if (e.key === "Escape") setAdding(false);
              }}
              onBlur={() => setAdding(false)}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
};
