import {
  createSignal,
  For,
  Show,
  type Accessor,
  type Component,
} from "solid-js";
import type { Session } from "../types/lobby";
import type { LobbyStore } from "../store/lobby";
import { formatWorking, relativeTime, stateLabel } from "./lobby.logic";
import { createDismissableMenu } from "./menu";
import { StateDot } from "./StateDot";
import { ToolIcon, TOOL_LABELS } from "./ToolIcon";

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
}> = (props) => {
  const s = () => props.session;
  const foreign = () => !!s().owner && s().owner !== props.store.me();
  const isActive = () =>
    props.store.selected()?.name === s().name &&
    (props.store.selected()?.owner ?? "") === (foreign() ? s().owner ?? "" : "");

  const [editing, setEditing] = createSignal(false);
  const menu = createDismissableMenu(() => props.store.hold());
  const [dropEdge, setDropEdge] = createSignal<"above" | "below" | null>(null);
  let releaseHold: (() => void) | null = null;
  let inputEl: HTMLInputElement | undefined;

  const rightText = () => {
    props.tick(); // re-run every second
    if (s().state === "running") {
      const since = props.store.workingSince(s().name);
      return since ? formatWorking(Date.now() - since) : "working";
    }
    return relativeTime(s().lastActivity);
  };

  // ---- activation ----
  const activate = (e: Event) => {
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
    if (next && next !== s().name) await props.store.rename(s().name, next);
  };

  // ---- actions ----
  // Killing is unrecoverable, so it confirms here exactly as every sibling path
  // does (the kill chord, the palette action, Delete project).
  const kill = async () => {
    menu.close();
    const ask = props.confirm ?? ((m: string) => window.confirm(m));
    if (!ask(`Kill session "${s().name}"?`)) return;
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

  return (
    <div
      // the ⋯ button and its popup both live in here, so the row is the menu's
      // anchor: a press anywhere else on the page dismisses it.
      ref={menu.anchor}
      class="tl-card"
      classList={{
        "tl-card-active": isActive(),
        "tl-card-foreign": foreign(),
        "tl-drop-above": dropEdge() === "above",
        "tl-drop-below": dropEdge() === "below",
      }}
      role="button"
      tabindex={0}
      draggable={draggable()}
      aria-label={
        `session ${s().name}` +
        (s().tool ? ", " + TOOL_LABELS[s().tool!] : "") +
        (s().state ? ", " + stateLabel(s().state) : "")
      }
      onClick={activate}
      onKeyDown={onKey}
      onDblClick={beginRename}
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
          <input
            ref={inputEl}
            class="tl-card-rename"
            value={s().name}
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
        <span class="tl-card-name" title={s().pane_title || s().name}>
          {s().name}
        </span>
      </Show>

      <Show when={foreign()}>
        <span class="tl-card-owner" title={`${s().owner} · ${s().access === "rw" ? "read-write" : "read-only"}`}>
          {s().access === "rw" ? "✎" : "👁"} {s().owner}
        </span>
      </Show>

      <span
        class="tl-card-time"
        classList={{ "tl-card-time-running": s().state === "running" }}
      >
        {rightText()}
      </span>

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
