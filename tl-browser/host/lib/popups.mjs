// The popups a headless frame does not show (design, "What a headless frame
// does not show"). Chrome draws a <select>'s list, alert/confirm/prompt and a
// file chooser outside the page, so the screencast never carries them. While
// a person holds control the host tells the panel about them and the panel
// draws its own; the person's answer comes back as `choose` or `dialog`.
//
// This module holds the parts that need no browser: which popup each tab has
// open, which one an answer means, and whether a choice is one the list
// offers. The function that reads the focused select runs in the page.

/**
 * @typedef {import("./protocol.mjs").PopupMessage} PopupMessage
 * @typedef {import("./protocol.mjs").SelectOption} SelectOption
 * @typedef {import("./protocol.mjs").ViewerMessage} ViewerMessage
 * @typedef {{ kind: "select" | "dialog", msg: PopupMessage & { tab: string } }} Popup
 */

/** A select longer than this shows its first options only. */
export const MAX_OPTIONS = 2000;
/** An option's label is cut to this many characters. */
export const MAX_LABEL = 200;

/**
 * The popups open now, one per tab: a newer one on the same tab replaces the
 * older (a dialog a select's change handler raised, say).
 * @template {Popup} P
 */
export class PopupBoard {
  /** @type {Map<string, P>} */
  #byTab = new Map();

  /**
   * @param {P} popup
   * @returns {P | null} the popup it replaced, for the caller to let go of
   */
  set(popup) {
    const prev = this.#byTab.get(popup.msg.tab) ?? null;
    this.#byTab.set(popup.msg.tab, popup);
    return prev;
  }

  /**
   * @param {string} tab
   * @returns {P | null}
   */
  get(tab) {
    return this.#byTab.get(tab) ?? null;
  }

  /**
   * The popup an answer means: the one of that kind on the tab, or, when that
   * tab has none, the only one of that kind anywhere. An answer that could
   * mean two popups means none.
   * @param {Popup["kind"]} kind
   * @param {string | null} tab
   * @returns {P | null}
   */
  find(kind, tab) {
    const here = tab === null ? undefined : this.#byTab.get(tab);
    if (here?.kind === kind) return here;
    const ofKind = this.all().filter((p) => p.kind === kind);
    return ofKind.length === 1 ? ofKind[0] : null;
  }

  /**
   * Removes a popup if it is still the one on its tab.
   * @param {P} popup
   * @returns {boolean} whether it was there
   */
  take(popup) {
    if (this.#byTab.get(popup.msg.tab) !== popup) return false;
    this.#byTab.delete(popup.msg.tab);
    return true;
  }

  /**
   * @param {Popup["kind"]} kind
   * @returns {P[]} the popups of that kind, now removed
   */
  drop(kind) {
    return this.#remove((p) => p.kind === kind);
  }

  /**
   * @param {Set<string>} tabs the tabs still open
   * @returns {P[]} the popups of closed tabs, now removed
   */
  prune(tabs) {
    return this.#remove((p) => !tabs.has(p.msg.tab));
  }

  /** @returns {P[]} */
  all() {
    return [...this.#byTab.values()];
  }

  /**
   * @param {(p: P) => boolean} match
   * @returns {P[]}
   */
  #remove(match) {
    const gone = this.all().filter(match);
    for (const p of gone) this.#byTab.delete(p.msg.tab);
    return gone;
  }
}

/**
 * The values a `choose` sets, or null when it is not a choice the list offers:
 * every value must be an enabled option, and a single list takes exactly one.
 * @param {{ options: SelectOption[], multiple: boolean }} list
 * @param {ViewerMessage & { t: "choose" }} msg
 * @returns {string[] | null}
 */
export function checkChoice(list, msg) {
  const values = "value" in msg ? [msg.value] : msg.values;
  if (!list.multiple && values.length !== 1) return null;
  const enabled = new Set(list.options.filter((o) => !o.disabled).map((o) => o.value));
  return values.every((v) => enabled.has(v)) ? values : null;
}

/**
 * Whether a person's input may have opened a select's list: Chrome opens it
 * on a left press, which a desktop sends as "down" and a phone's tap as
 * "click".
 * @param {ViewerMessage} msg
 * @returns {boolean}
 */
export function selectOpens(msg) {
  return msg.t === "mouse" && msg.button === "left" && (msg.type === "down" || msg.type === "click");
}

/**
 * Runs in the page: the focused element when it is a select whose list Chrome
 * draws outside the page, otherwise null. Looks through open shadow roots. A
 * list box (size above 1, single choice) is drawn in the page and needs no
 * popup; a multiple select is offered one, since choosing several there takes
 * a modifier key a phone does not have.
 * @returns {HTMLSelectElement | null}
 */
export function focusedSelectInPage() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!(el instanceof HTMLSelectElement) || el.disabled) return null;
  if (!el.multiple && el.size > 1) return null;
  return el;
}

/**
 * Runs in the page: what the panel needs to draw a select's list.
 * @param {HTMLSelectElement} el
 * @param {{ maxOptions: number, maxLabel: number }} limits
 * @returns {{ options: SelectOption[], multiple: boolean, rect: { x: number, y: number, w: number, h: number } }}
 */
export function describeSelectInPage(el, { maxOptions, maxLabel }) {
  const r = el.getBoundingClientRect();
  const options = [...el.options].slice(0, maxOptions).map((o) => ({
    value: o.value,
    label: (o.label || o.text).slice(0, maxLabel),
    selected: o.selected,
    disabled: o.disabled || (o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled),
  }));
  return {
    options,
    multiple: el.multiple,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
}
