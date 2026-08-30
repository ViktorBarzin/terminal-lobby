import { For, Show, type Accessor, type Component } from "solid-js";
import { createDismissableMenu } from "./menu";
import {
  SESSION_ORDER_TEXT,
  SESSION_ORDERS,
  type SessionOrder,
} from "./order.logic";

/**
 * The session list's ordering picker, in the sidebar header.
 *
 * Deliberately NOT in Settings: on a phone the list IS the screen, and the
 * question "why is this session not where I expect it" is asked while looking
 * at the list, not two overlays away. It sits with ↻ and the bell as a third
 * header button — a glyph on a narrow screen, a glyph plus the current
 * ordering's word wherever there is room for one.
 *
 * The popup is the sidebar's own ⋯ menu (`createDismissableMenu` + `.tl-menu`),
 * so it dismisses on Escape and on an outside press, and holds the lobby poll
 * while open exactly as the card and group menus do.
 */
export const OrderMenu: Component<{
  order: Accessor<SessionOrder>;
  onPick: (order: SessionOrder) => void;
  /** the store's poll hold, threaded in so the menu can pause the poll. */
  hold: () => () => void;
}> = (props) => {
  const menu = createDismissableMenu(props.hold);
  const current = () => SESSION_ORDER_TEXT[props.order()];

  const pick = (order: SessionOrder) => {
    menu.close();
    if (order !== props.order()) props.onPick(order);
  };

  return (
    <span class="tl-order" ref={menu.anchor}>
      <button
        class="tl-head-btn tl-order-btn"
        type="button"
        aria-label="Order sessions"
        aria-haspopup="menu"
        aria-expanded={menu.open()}
        // The button says which ordering is on. On a phone the word is gone and
        // this is the only place left that answers it without a tap.
        title={`Order sessions: ${current().label.toLowerCase()}, ${current().hint}`}
        onClick={() => menu.toggle()}
      >
        <span class="tl-order-glyph" aria-hidden="true">
          ⇅
        </span>
        <span class="tl-order-label">{current().short}</span>
      </button>
      <Show when={menu.open()}>
        <div class="tl-menu tl-order-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <div class="tl-menu-label">Order sessions</div>
          <For each={SESSION_ORDERS}>
            {(order) => (
              <button
                class="tl-menu-item tl-order-item"
                role="menuitemradio"
                aria-checked={props.order() === order}
                onClick={() => pick(order)}
              >
                {/* The tick keeps its column whether or not it is drawn, so the
                    three labels stay on one left edge. */}
                <span class="tl-order-tick" aria-hidden="true">
                  {props.order() === order ? "✓" : ""}
                </span>
                {SESSION_ORDER_TEXT[order].label}
                <span class="tl-order-hint">{SESSION_ORDER_TEXT[order].hint}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </span>
  );
};
