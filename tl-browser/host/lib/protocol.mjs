// The viewer protocol: newline-delimited JSON on the host's unix socket, one
// message per line, field "t" is the type. session-events writes the first
// line (the viewer hello) and relays the rest from the lobby. Everything the
// viewer side sends is checked here, field by field, before the host acts on
// it; a message that does not fit is dropped.

import path from "node:path";

/**
 * @typedef {{ user: string, canControl: boolean }} ViewerHello
 * @typedef {"left" | "middle" | "right"} MouseButton
 * @typedef {{ t: "subscribe", tab: string | null }
 *   | { t: "unsubscribe" }
 *   | { t: "selectTab", tab: string }
 *   | { t: "mouse", type: "move" | "down" | "up" | "click", x: number, y: number, button: MouseButton, clickCount: number }
 *   | { t: "wheel", x: number, y: number, dx: number, dy: number }
 *   | { t: "key", type: "down" | "up" | "press", key: string }
 *   | { t: "insertText", text: string }
 *   | { t: "navigate", url: string }
 *   | { t: "back" } | { t: "forward" } | { t: "reload" } | { t: "copy" }
 *   | { t: "takeControl" } | { t: "handBack" }
 *   | { t: "choose", value: string, tab?: string }
 *   | { t: "choose", values: string[], tab?: string }
 *   | { t: "dialog", accept: boolean, text?: string, tab?: string }} ViewerMessage
 *   choose answers a select popup, dialog a JavaScript dialog; both name the
 *   popup's tab, or mean the viewer's own tab when they do not
 *
 * @typedef {import("./tabs.mjs").TabInfo} TabInfo
 * @typedef {import("./control.mjs").ControlSnapshot} ControlSnapshot
 * @typedef {"live" | "frozen"} BrowserState
 * @typedef {{ t: "hello", state: BrowserState, tabs: TabInfo[], agentTab: string | null, control: ControlSnapshot, viewport: { w: number, h: number } }
 *   | { t: "frame", tab: string, jpeg: string, w: number, h: number }
 *   | { t: "tabs", tabs: TabInfo[], agentTab: string | null }
 *   | ({ t: "control" } & ControlSnapshot)
 *   | { t: "state", state: BrowserState | "closed" }
 *   | { t: "activity", tool: string, summary: string }
 *   | { t: "copied", text: string }
 *   | { t: "error", message: string }
 *   | PopupMessage} HostMessage what the host sends a viewer
 *
 * @typedef {{ value: string, label: string, selected: boolean, disabled: boolean }} SelectOption
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect in the page's CSS pixels
 * @typedef {"alert" | "confirm" | "prompt" | "beforeunload"} DialogType
 * @typedef {{ t: "popup", kind: "select", tab: string, options: SelectOption[], multiple: boolean, rect: Rect }
 *   | { t: "popup", kind: "dialog", tab: string, type: DialogType, message: string, defaultValue: string }
 *   | { t: "popup", kind: "filechooser", tab: string }
 *   | { t: "popup", kind: "none", tab: string }} PopupMessage
 *   a native widget the screencast cannot show, drawn by the panel instead;
 *   sent only to the person in control. "none" means the tab's popup is gone.
 */

/** A paste is capped at about a megabyte of text. */
const MAX_TEXT = 1_000_000;
/** Long enough for any KeyboardEvent.key value, short enough to be one. */
const MAX_KEY = 64;
const MAX_URL = 8192;
const MAX_ID = 64;
/** More options than any real select offers in one list. */
const MAX_CHOICES = 10_000;

const MOUSE_TYPES = new Set(["move", "down", "up", "click"]);
const KEY_TYPES = new Set(["down", "up", "press"]);
const BUTTONS = new Set(["left", "middle", "right"]);
const BARE = new Set([
  "unsubscribe",
  "back",
  "forward",
  "reload",
  "copy",
  "takeControl",
  "handBack",
]);

/**
 * @param {string} line
 * @returns {Record<string, unknown> | null}
 */
function object(line) {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/** @param {unknown} v */
const num = (v) => typeof v === "number" && Number.isFinite(v);
/**
 * @param {unknown} v
 * @param {number} max
 * @returns {v is string}
 */
const text = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

/**
 * @param {unknown} v
 * @returns {v is string}
 */
const optionValue = (v) => typeof v === "string" && v.length <= MAX_TEXT;

/**
 * The optional tab a popup answer names: absent, or a tab id.
 * @param {Record<string, unknown>} m
 * @returns {{ tab?: string } | null} null when the field is there but not a tab id
 */
function popupTab(m) {
  if (!("tab" in m)) return {};
  return text(m.tab, MAX_ID) ? { tab: m.tab } : null;
}

/**
 * @param {string} line
 * @returns {ViewerHello | null}
 */
export function parseViewerHello(line) {
  const m = object(line);
  if (!m || m.t !== "hello" || !text(m.user, 256) || typeof m.canControl !== "boolean") return null;
  return { user: m.user, canControl: m.canControl };
}

/**
 * @param {string} line
 * @returns {ViewerMessage | null}
 */
export function parseViewerMessage(line) {
  const m = object(line);
  if (!m || typeof m.t !== "string") return null;
  const t = m.t;
  if (BARE.has(t)) return /** @type {ViewerMessage} */ ({ t });
  switch (t) {
    case "subscribe":
      if (m.tab === null) return { t, tab: null };
      return text(m.tab, MAX_ID) ? { t, tab: m.tab } : null;
    case "selectTab":
      return text(m.tab, MAX_ID) ? { t, tab: m.tab } : null;
    case "mouse": {
      const type = m.type;
      if (typeof type !== "string" || !MOUSE_TYPES.has(type) || !num(m.x) || !num(m.y)) return null;
      const button = m.button ?? "left";
      const clickCount = m.clickCount ?? 1;
      if (typeof button !== "string" || !BUTTONS.has(button)) return null;
      if (
        !Number.isInteger(clickCount) ||
        /** @type {number} */ (clickCount) < 0 ||
        /** @type {number} */ (clickCount) > 3
      )
        return null;
      return /** @type {ViewerMessage} */ ({
        t,
        type,
        x: m.x,
        y: m.y,
        button,
        clickCount,
      });
    }
    case "wheel":
      if (!num(m.x) || !num(m.y) || !num(m.dx) || !num(m.dy)) return null;
      return /** @type {ViewerMessage} */ ({ t, x: m.x, y: m.y, dx: m.dx, dy: m.dy });
    case "key":
      if (typeof m.type !== "string" || !KEY_TYPES.has(m.type) || !text(m.key, MAX_KEY))
        return null;
      return /** @type {ViewerMessage} */ ({ t, type: m.type, key: m.key });
    case "insertText":
      return text(m.text, MAX_TEXT) ? { t, text: m.text } : null;
    case "navigate":
      return text(m.url, MAX_URL) ? { t, url: m.url } : null;
    case "choose": {
      const tab = popupTab(m);
      if (!tab || ("value" in m) === ("values" in m)) return null;
      if ("value" in m) return optionValue(m.value) ? { t, value: m.value, ...tab } : null;
      const values = m.values;
      if (!Array.isArray(values) || values.length > MAX_CHOICES || !values.every(optionValue))
        return null;
      return { t, values: /** @type {string[]} */ (values), ...tab };
    }
    case "dialog": {
      const tab = popupTab(m);
      if (!tab || typeof m.accept !== "boolean") return null;
      if (!("text" in m)) return { t, accept: m.accept, ...tab };
      return optionValue(m.text) ? { t, accept: m.accept, text: m.text, ...tab } : null;
    }
    default:
      return null;
  }
}

/**
 * Turns what a person typed in the URL bar into a URL the browser may load.
 * Only the web: no file:, javascript:, data: or chrome: pages, since a person
 * driving through a share must not reach the owner's files this way.
 * @param {string} input
 * @returns {string | null}
 */
export function normalizeUrl(input) {
  const s = input.trim();
  if (!s) return null;
  if (s === "about:blank") return s;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d+(\/|$)/.test(s);
  let url;
  try {
    url = new URL(hasScheme ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}

/**
 * The socket's file name: the tmux session id without its "$", prefixed "s"
 * (s12), or pid-<pid> outside tmux or when the id is not a plain one.
 * @param {string | null} sessionId e.g. "$12"
 * @param {number} pid
 * @returns {string}
 */
export function socketName(sessionId, pid) {
  const m = sessionId ? /^\$(\d+)$/.exec(sessionId) : null;
  return m ? `s${m[1]}` : `pid-${pid}`;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {number} uid
 * @returns {string}
 */
export function socketDir(env, uid) {
  return env.XDG_RUNTIME_DIR
    ? path.join(env.XDG_RUNTIME_DIR, "tl-browser")
    : `/tmp/tl-browser-${uid}`;
}

/**
 * @param {HostMessage} msg
 * @returns {string}
 */
export function encode(msg) {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Splits a byte stream into lines. A line longer than the limit throws, so a
 * peer that never sends a newline cannot grow the buffer without bound.
 */
export class LineSplitter {
  #buf = "";
  #decoder = new TextDecoder();
  #max;

  /** @param {number} maxLine longest line accepted, in UTF-16 units */
  constructor(maxLine) {
    this.#max = maxLine;
  }

  /**
   * @param {Buffer | string} chunk
   * @returns {string[]}
   */
  push(chunk) {
    this.#buf += typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    const parts = this.#buf.split("\n");
    this.#buf = /** @type {string} */ (parts.pop());
    if (this.#buf.length > this.#max) throw new Error("line too long");
    const lines = [];
    for (const p of parts) {
      const line = p.endsWith("\r") ? p.slice(0, -1) : p;
      if (line.length > this.#max) throw new Error("line too long");
      if (line) lines.push(line);
    }
    return lines;
  }
}
