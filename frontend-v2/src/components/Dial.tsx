import { createSignal, For, onCleanup, onMount, Show, type Component, type JSX } from "solid-js";
import { isCoarsePointer } from "../mobile/pointer";
import { installDialogFocus, wrapTab } from "../lib/focus-trap";
import { ChevronsIcon, CloseIcon, LockIcon } from "./Icons";

/**
 * The labelled dials on the composer's thin line, and the floats they open.
 *
 * WHAT A DIAL IS. A setting the reader can see without opening anything,
 * named for what it sets: "mode Manual", "model Opus 5.5 · High", "context
 * 42%". The chips they replaced said "manual" and "claude-opus-5-5 · medium"
 * with nothing to say which was which, and on a phone the model chip ran under
 * Send (memory #13886). Every dial opens a list that explains each choice
 * (Quiet line composer, 2026-09-24). The new-session composer's project,
 * command and model pickers become dials of the same kind, so this file knows
 * nothing about modes or models: a caller hands it `DialSpec`s.
 *
 * TWO KINDS OF FLOAT, by pointer, decided when the dial is pressed. A fine
 * pointer gets a popover above the dial, lined up with its right edge and
 * held inside the line's width. A coarse one gets ONE bottom sheet with a tab
 * per dial, which is what keeps a dial the line folded away for room (the
 * model while Claude works on a phone) one tap from reach.
 *
 * ONE FLOAT AT A TIME. Pressing another dial moves the float to it, a press
 * anywhere outside closes it, and so does Escape, which also hands focus back
 * to the dial. The dismissal is written here rather than borrowed from
 * `createDismissableMenu`, whose Escape closes without saying so and so cannot
 * give the focus back, and which holds one menu rather than several dials.
 */

/** One dial: what it shows, and the list behind it. */
export interface DialSpec {
  /** Which dial: `data-dial`, and the float's class suffix. */
  id: string;
  /** The micro-label before the value on a wide line ("mode", "in"). */
  label: string;
  /** The sheet's tab for this dial ("Mode"). */
  tab: string;
  /** The float's accessible name ("Permission mode"). */
  title: string;
  /** What the dial shows: an icon and a value. */
  value: () => JSX.Element;
  ariaLabel: () => string;
  /** The dial's tooltip while it can act. */
  hint: () => string;
  /** Colours the dial's icon (`data-tone`). */
  tone?: () => string | undefined;
  /** Bypass and No ask: the hatched danger tab. */
  danger?: () => boolean;
  /** A change is being driven; the dial opens nothing until it lands. */
  busy?: () => boolean;
  /** Why the dial cannot act right now, "" or undefined when it can. The
   *  reason becomes its title, and a press opens nothing. */
  held?: () => string | undefined;
  /** Nothing is known yet, so the value is the dial's own name and the
   *  micro-label beside it would only repeat it. */
  unknown?: () => boolean;
  /** The mode dial carries its mode, for the stylesheet and for tests. */
  dataMode?: () => string | undefined;
  /** It opens a reading rather than a list to choose from (the context
   *  breakdown), so it draws no chevrons. */
  readout?: boolean;
  /** 1 folds with the model at the tightest width while the line is busy;
   *  2 folds with context while Claude works or someone watches. */
  fold?: 1 | 2;
  /**
   * The list behind the dial. `close` puts the float away and gives the focus
   * back to the dial, which is what a pick does; `sheet` says the list is in
   * the phone's sheet, where a caller may prefer to stay open after a pick.
   */
  panel: (ctx: { close: () => void; sheet: boolean }) => JSX.Element;
}

/**
 * Close a float on a press outside it, and on Escape.
 *
 * Capturing, on the document, for the same reasons the sidebar's menus do
 * (components/menu.ts): a press that lands on a control with a handler of its
 * own still has to reach this first, and Escape must not also reach whatever
 * sits under the float. Shared with the + tray, which is the other float the
 * composer opens.
 */
export function dismissFloat(o: {
  open: () => boolean;
  inside: (t: Node) => boolean;
  close: (why: "escape" | "outside") => void;
}): void {
  const onDown = (e: Event): void => {
    if (!o.open()) return;
    const t = e.target as Node | null;
    if (t && o.inside(t)) return;
    o.close("outside");
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!o.open() || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    o.close("escape");
  };
  onMount(() => {
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  });
}

/** The rows the arrow keys walk: list rows, and the effort control's buttons. */
const NAV = ".tl-pick-row, .tl-effort-seg button";

const usable = (el: HTMLElement): boolean =>
  el.getAttribute("aria-disabled") !== "true" && !(el as HTMLButtonElement).disabled;

/**
 * ↑ and ↓ walk a list's rows, ← and → walk the effort control. Into and out of
 * the effort control the vertical walk stops only on its chosen button, so it
 * reads as one stop in the list, the way a radio group does.
 */
function walkRows(e: KeyboardEvent): void {
  const vertical = e.key === "ArrowDown" || e.key === "ArrowUp";
  const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
  if (!vertical && !horizontal) return;
  const box = e.currentTarget as HTMLElement;
  const from = e.target as HTMLElement;
  const seg = from.closest<HTMLElement>(".tl-effort-seg");
  if (horizontal && !seg) return;
  const scope = horizontal ? seg! : box;
  let items = Array.from(scope.querySelectorAll<HTMLElement>(NAV)).filter(usable);
  if (vertical) {
    items = items.filter(
      (b) =>
        !b.closest(".tl-effort-seg") || b.getAttribute("aria-checked") === "true" || b === from,
    );
  }
  const i = items.indexOf(from);
  if (i < 0) return;
  e.preventDefault();
  const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
  items[(i + step + items.length) % items.length]!.focus();
}

/** The chosen row in a list, or its first usable row. */
function focusChosen(box: HTMLElement | undefined): void {
  if (!box) return;
  const rows = Array.from(box.querySelectorAll<HTMLElement>(NAV)).filter(usable);
  (rows.find((r) => r.getAttribute("aria-checked") === "true") ?? rows[0])?.focus();
}

export const DialBar: Component<{
  dials: DialSpec[];
  /** The phone sheet's heading ("This session", "New session"). */
  sheetTitle: string;
}> = (props) => {
  const [open, setOpen] = createSignal<string | null>(null);
  const [sheet, setSheet] = createSignal(false);
  const [place, setPlace] = createSignal<JSX.CSSProperties>({});
  let root: HTMLDivElement | undefined;
  let popEl: HTMLDivElement | undefined;
  const buttons = new Map<string, HTMLButtonElement>();

  const current = (): DialSpec | undefined => props.dials.find((d) => d.id === open());

  const close = (refocus: boolean): void => {
    const was = open();
    if (!was) return;
    setOpen(null);
    if (refocus) buttons.get(was)?.focus();
  };

  dismissFloat({
    open: () => open() !== null,
    inside: (t) => !!root?.contains(t),
    close: (why) => close(why === "escape"),
  });

  const press = (d: DialSpec, e: MouseEvent): void => {
    if (d.held?.() || d.busy?.()) return;
    if (open() === d.id) {
      close(false);
      return;
    }
    const phone = isCoarsePointer();
    setSheet(phone);
    setOpen(d.id);
    // A keyboard activation is a click with no pointer detail. The list takes
    // the focus then, or the arrows would have nothing to walk. A pointer
    // leaves the focus where it was, as a menu does. Solid has inserted the
    // popover by the time the setter above returns.
    if (!phone && e.detail === 0) focusChosen(popEl);
  };

  /**
   * Line the popover's right edge up with its dial, keep it inside the line,
   * and cap its height at the room above it.
   *
   * Measured once it is in the document, which is the only time its width is
   * known. The cap matters in a workspace tile, where the pane above a dial can
   * be shorter than the mode list's 386px, and in the new-session composer,
   * whose own scroller would otherwise cut the list off under the session bar.
   */
  const placePop = (): void => {
    const d = open();
    const btn = d ? buttons.get(d) : undefined;
    const cb = popEl?.offsetParent as HTMLElement | null | undefined;
    if (!popEl || !btn || !cb) return;
    const box = cb.getBoundingClientRect();
    const at = btn.getBoundingClientRect();
    const w = popEl.offsetWidth;
    let right = Math.max(0, box.right - at.right - 4);
    if (box.width - right - w < 0) right = Math.max(0, box.width - w);
    const view = root?.closest(".tl-textview, .tl-new-composer");
    const top = view ? view.getBoundingClientRect().top : 0;
    setPlace({ right: `${right}px`, "max-height": `${Math.max(160, at.top - top - 12)}px` });
  };

  return (
    <div class="tl-dials" ref={root}>
      <For each={props.dials}>
        {(d, i) => (
          <>
            <Show when={i() > 0}>
              <span
                class="tl-dial-div"
                aria-hidden="true"
                data-fold={d.fold === 1 ? "" : undefined}
                data-fold2={d.fold === 2 ? "" : undefined}
              />
            </Show>
            <button
              type="button"
              class="tl-dial"
              ref={(el) => buttons.set(d.id, el)}
              data-dial={d.id}
              data-mode={d.dataMode?.()}
              data-tone={d.tone?.()}
              data-danger={d.danger?.() ? "" : undefined}
              data-busy={d.busy?.() ? "" : undefined}
              data-unknown={d.unknown?.() ? "" : undefined}
              data-fold={d.fold === 1 ? "" : undefined}
              data-fold2={d.fold === 2 ? "" : undefined}
              aria-haspopup="dialog"
              aria-expanded={open() === d.id}
              aria-disabled={d.held?.() ? "true" : undefined}
              aria-label={d.ariaLabel()}
              title={d.held?.() || d.hint()}
              onClick={(e) => press(d, e)}
            >
              <span class="tl-dial-label">{d.label}</span>
              {d.value()}
              <Show when={!d.readout}>
                <ChevronsIcon />
              </Show>
              <Show when={d.held?.()}>
                <LockIcon />
              </Show>
            </button>
          </>
        )}
      </For>
      <Show when={!sheet() && current()}>
        {(d) => (
          <div
            class={`tl-dial-pop tl-dial-pop-${d().id}`}
            role="dialog"
            aria-label={d().title}
            style={place()}
            ref={(el) => {
              popEl = el;
              queueMicrotask(() => {
                if (popEl === el) placePop();
              });
            }}
            onKeyDown={walkRows}
          >
            {d().panel({ close: () => close(true), sheet: false })}
          </div>
        )}
      </Show>
      <Show when={sheet() && current()}>
        {(d) => (
          <DialSheet
            dials={props.dials}
            current={d()}
            title={props.sheetTitle}
            onTab={(id) => setOpen(id)}
            onClose={() => close(false)}
          />
        )}
      </Show>
    </div>
  );
};

/**
 * The phone's settings sheet: one sheet for every dial, a tab each.
 *
 * Modal while it is up. It takes the focus, which is also what puts the
 * phone's keyboard away when the message field had it; Tab cannot walk out
 * behind the scrim; and closing hands the focus back to whatever held it
 * (lib/focus-trap). A pick applies and leaves the sheet where the caller's
 * panel says: the live composer closes it, the new-session composer keeps it
 * open so two choices take one visit.
 */
const DialSheet: Component<{
  dials: DialSpec[];
  current: DialSpec;
  title: string;
  onTab: (id: string) => void;
  onClose: () => void;
}> = (props) => {
  let sheetEl: HTMLDivElement | undefined;
  installDialogFocus(() => sheetEl);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Tab" && sheetEl) wrapTab(e, sheetEl);
  };
  return (
    <div class="tl-sheet-layer">
      <button
        type="button"
        class="tl-sheet-scrim"
        aria-label="Close"
        tabindex={-1}
        onClick={() => props.onClose()}
      />
      <div
        class="tl-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabindex={-1}
        ref={sheetEl}
        onKeyDown={onKeyDown}
      >
        <div class="tl-sheet-grab" aria-hidden="true" />
        <div class="tl-sheet-head">
          <span class="tl-sheet-title">{props.title}</span>
          <button
            type="button"
            class="tl-sheet-x"
            aria-label="Close"
            onClick={() => props.onClose()}
          >
            <CloseIcon />
          </button>
        </div>
        <div
          class="tl-sheet-tabs"
          role="tablist"
          style={{ "grid-template-columns": `repeat(${props.dials.length}, 1fr)` }}
        >
          <For each={props.dials}>
            {(d) => (
              <button
                type="button"
                role="tab"
                aria-selected={d.id === props.current.id}
                onClick={() => props.onTab(d.id)}
              >
                {d.tab}
              </button>
            )}
          </For>
        </div>
        <div
          class="tl-sheet-body"
          role="tabpanel"
          aria-label={props.current.title}
          onKeyDown={walkRows}
        >
          {props.current.panel({ close: () => props.onClose(), sheet: true })}
        </div>
      </div>
    </div>
  );
};
