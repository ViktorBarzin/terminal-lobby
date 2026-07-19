import { For, Match, Show, Switch, onMount, type Component } from "solid-js";
import type { PaletteController } from "../keybindings/palette-controller";

/**
 * The command-palette overlay (feature-inventory Cat.2 "Command palette"). A thin
 * view over the reactive PaletteController: a backdrop + query input + grouped,
 * keyboard-navigable result list. All ranking/filtering/selection state lives in
 * the controller (palette-controller.ts + palette.logic.ts); this only paints and
 * routes keys. Rendered inside a <Show when={ctrl.isOpen()}> by the shell.
 */
export const CommandPalette: Component<{ controller: PaletteController }> = (props) => {
  const c = props.controller;
  let inputEl: HTMLInputElement | undefined;
  onMount(() => queueMicrotask(() => inputEl?.focus()));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      c.close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      c.moveSel(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      c.moveSel(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      c.runSelected();
    }
  };

  return (
    <div
      class="tl-cmdpalette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) c.close(true);
      }}
      onKeyDown={onKey}
    >
      <div class="tl-cmdpalette" role="dialog" aria-label="Command palette">
        <input
          ref={inputEl}
          class="tl-cp-input"
          type="text"
          placeholder="Search sessions…  (start with > for actions)"
          aria-label="Command palette"
          value={c.query()}
          onInput={(e) => c.setQuery(e.currentTarget.value)}
        />
        <div class="tl-cp-list" role="listbox">
          <For each={c.rows()}>
            {(row) => (
              <Switch>
                <Match when={row.kind === "label" ? row : false} keyed>
                  {(r) => <div class="tl-cp-group-label">{r.label}</div>}
                </Match>
                <Match when={row.kind === "note" ? row : false} keyed>
                  {(r) => <div class="tl-cp-note">{r.note}</div>}
                </Match>
                <Match when={row.kind === "item" ? row : false} keyed>
                  {(r) => (
                    <div
                      class="tl-cp-item"
                      classList={{
                        "tl-cp-sel": c.selIdx() === r.index,
                        "tl-cp-danger": !!r.item.danger,
                      }}
                      role="option"
                      aria-selected={c.selIdx() === r.index}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => c.setSel(r.index)}
                      onClick={() => c.runItem(r.item)}
                    >
                      <span class="tl-cp-title">{r.item.title}</span>
                      <Show when={r.item.meta}>
                        <span class="tl-cp-meta">{r.item.meta}</span>
                      </Show>
                    </div>
                  )}
                </Match>
              </Switch>
            )}
          </For>
        </div>
      </div>
    </div>
  );
};
