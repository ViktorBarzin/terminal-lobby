import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import { browserStreamUrl } from "./config";
import { wsScheme } from "../terminal/wire";
import type { PageRect, Size } from "../components/browser.logic";

/**
 * The lobby's end of a Session browser's viewer stream
 * (docs/plans/2026-10-01-session-browser-design.md, "The viewer protocol").
 *
 * session-events relays the host's unix socket as a WebSocket, one JSON
 * message per text frame, and writes the viewer's own hello (who is watching,
 * whether they may drive) before anything from here reaches the host. So this
 * side never says who it is: it subscribes, sends input, and draws what comes
 * back.
 *
 * One stream per surface. A Browser card and the Browser panel each hold their
 * own, because each watches its own tab (the card always follows the agent's)
 * and each has its own reason to be connected. Both connect only while
 * `active` says somebody can see them, and a card never wakes a Frozen
 * browser: subscribing is what wakes one, so a card on a frozen browser stays
 * connected and quiet until the host says it is live again.
 */

export type BrowserState = "live" | "frozen";

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

export interface BrowserControl {
  /** Who drives the browser, by the name the lobby knows them by, or null
   *  while the agent does. A name, for showing; never for deciding. */
  holder: string | null;
  /** The connection that holds control. A viewer holds it exactly when this
   *  is its own `you`, so one person's laptop and phone are told apart. */
  holderId: string | null;
  since: number | null;
  /** When control lapses with no further input from the holder. */
  lapseAt: number | null;
}

/** One picture of a tab, ready for an <img>. */
export interface BrowserFrame {
  tab: string;
  src: string;
  w: number;
  h: number;
}

type MouseButton = "left" | "middle" | "right";

export interface SelectOption {
  value: string;
  label: string;
  selected: boolean;
  disabled: boolean;
}

export type DialogType = "alert" | "confirm" | "prompt" | "beforeunload";

/**
 * A native widget the screencast cannot show, which the host reports to the
 * person in control so the panel can draw its own (design, "What a headless
 * frame does not show"). One per tab.
 */
export type BrowserPopup =
  | { kind: "select"; tab: string; options: SelectOption[]; multiple: boolean; rect: PageRect }
  | { kind: "dialog"; tab: string; type: DialogType; message: string; defaultValue: string }
  | { kind: "filechooser"; tab: string };

/** What a viewer may send (tl-browser/host/lib/protocol.mjs ViewerMessage). */
export type ViewerMessage =
  | { t: "subscribe"; tab: string | null }
  | { t: "unsubscribe" }
  | { t: "selectTab"; tab: string }
  | {
      t: "mouse";
      type: "move" | "down" | "up" | "click";
      x: number;
      y: number;
      button: MouseButton;
      clickCount: number;
    }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "key"; type: "down" | "up" | "press"; key: string }
  | { t: "insertText"; text: string }
  | { t: "navigate"; url: string }
  | { t: "back" }
  | { t: "forward" }
  | { t: "reload" }
  | { t: "copy" }
  | { t: "takeControl" }
  | { t: "handBack" }
  | { t: "resume"; prev: string }
  | { t: "choose"; value: string; tab: string }
  | { t: "choose"; values: string[]; tab: string }
  | { t: "dialog"; accept: boolean; text?: string; tab: string };

/** The part of WebSocket this module uses, so a test can stand in for it. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

const OPEN = 1;

/**
 * How long a socket outlives the surface going out of sight. Frames stop at
 * once (unsubscribe); the connection waits a little, so scrolling a card out
 * and back in, or flicking to another tab and back, does not reconnect.
 */
const LINGER_MS = 15_000;
/** Reconnect backoff while active: doubling from the first, capped. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 15_000;
/** How long the host's latest complaint stays on screen. */
const ERROR_SHOWN_MS = 5_000;
/**
 * A resume names the previous connection, and the host refuses it while that
 * connection is still open on its side, which a phone that changed networks
 * can leave behind until the relay's next ping fails. So while the host still
 * says the old connection holds control, the resume is sent again: doubling
 * from the first wait, this many times (about a minute in all).
 */
const RESUME_RETRY_FIRST_MS = 2_000;
const RESUME_TRIES = 5;

// ---- the last frame of each card ------------------------------------------
//
// Kept in the page's memory only (design: "Last frame"), so a card scrolled
// out of the mounted window, or whose run ended, still shows the picture it
// held. A reload loses it, and the card keeps its text. Bounded, oldest out.

const KEEP_MAX = 32;
const kept = new Map<string, BrowserFrame>();

function keep(key: string, frame: BrowserFrame): void {
  kept.delete(key);
  kept.set(key, frame);
  while (kept.size > KEEP_MAX) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    kept.delete(oldest);
  }
}

/** The newest frame kept under `key`, if this page has seen one. */
export function keptFrame(key: string): BrowserFrame | undefined {
  return kept.get(key);
}

// ---- reading the host -----------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

function tabsOf(v: unknown): BrowserTab[] {
  if (!Array.isArray(v)) return [];
  const out: BrowserTab[] = [];
  for (const t of v) {
    if (!isObj(t) || typeof t.id !== "string") continue;
    out.push({
      id: t.id,
      url: typeof t.url === "string" ? t.url : "",
      title: typeof t.title === "string" ? t.title : "",
    });
  }
  return out;
}

function controlOf(v: unknown): BrowserControl {
  const o = isObj(v) ? v : {};
  return {
    holder: strOrNull(o.holder),
    holderId: strOrNull(o.holderId),
    since: numOrNull(o.since),
    lapseAt: numOrNull(o.lapseAt),
  };
}

const DIALOG_TYPES = new Set<string>(["alert", "confirm", "prompt", "beforeunload"]);
const isDialogType = (v: unknown): v is DialogType => typeof v === "string" && DIALOG_TYPES.has(v);

function optionsOf(v: unknown): SelectOption[] {
  if (!Array.isArray(v)) return [];
  const out: SelectOption[] = [];
  for (const o of v) {
    if (!isObj(o) || typeof o.value !== "string") continue;
    out.push({
      value: o.value,
      label: typeof o.label === "string" ? o.label : o.value,
      selected: o.selected === true,
      disabled: o.disabled === true,
    });
  }
  return out;
}

function rectOf(v: unknown): PageRect | null {
  if (!isObj(v)) return null;
  const x = numOrNull(v.x);
  const y = numOrNull(v.y);
  const w = numOrNull(v.w);
  const h = numOrNull(v.h);
  return x === null || y === null || w === null || h === null ? null : { x, y, w, h };
}

/** A popup message from the host: a popup, "none" for its tab, or unreadable. */
function popupOf(
  msg: Record<string, unknown>,
): BrowserPopup | { kind: "none"; tab: string } | null {
  const tab = msg.tab;
  if (typeof tab !== "string") return null;
  switch (msg.kind) {
    case "select": {
      const rect = rectOf(msg.rect);
      if (!rect) return null;
      return {
        kind: "select",
        tab,
        options: optionsOf(msg.options),
        multiple: msg.multiple === true,
        rect,
      };
    }
    case "dialog":
      if (!isDialogType(msg.type)) return null;
      return {
        kind: "dialog",
        tab,
        type: msg.type,
        message: typeof msg.message === "string" ? msg.message : "",
        defaultValue: typeof msg.defaultValue === "string" ? msg.defaultValue : "",
      };
    case "filechooser":
      return { kind: "filechooser", tab };
    case "none":
      return { kind: "none", tab };
    default:
      return null;
  }
}

const NOBODY: BrowserControl = { holder: null, holderId: null, since: null, lapseAt: null };
const DEFAULT_VIEWPORT: Size = { w: 1280, h: 800 };

export interface BrowserStreamOptions {
  session: string;
  /** The session's owner when it is somebody else's (a share). */
  owner?: string;
  /** Connect, and receive frames, only while this is true. */
  active: Accessor<boolean>;
  /** The tab to watch; null, or absent, follows the agent's tab. */
  tab?: Accessor<string | null>;
  /** Whether subscribing may wake a Frozen browser. The panel may; a card
   *  may not. */
  wake: boolean;
  /** Keep the newest frame under this key for after the stream is gone. */
  keep?: string;
  /** The host answered a `copy` with the page's selected text. */
  onCopied?: (text: string) => void;
  /** Opens the socket. Tests pass a fake; the page uses WebSocket. */
  socket?: (url: string) => WebSocketLike;
}

export interface BrowserStream {
  /** Where the connection is: not wanted, on its way, open, refused (no
   *  browser to relay to, or the relay is down). */
  status: Accessor<"idle" | "connecting" | "open" | "unavailable">;
  /** The browser's own state, from the host. `closed` is final for this host. */
  state: Accessor<BrowserState | "closed" | null>;
  tabs: Accessor<BrowserTab[]>;
  agentTab: Accessor<string | null>;
  /** This connection's id, from the host's hello; null between connections. */
  you: Accessor<string | null>;
  /** The host has said hello on the open socket, so what is sent now reaches
   *  it. False while connecting and between connections. */
  greeted: Accessor<boolean>;
  control: Accessor<BrowserControl>;
  viewport: Accessor<Size>;
  frame: Accessor<BrowserFrame | null>;
  /** The latest agent tool call, in words ("Loading wikipedia.org"). */
  activity: Accessor<string | null>;
  /** The host's latest complaint, for a few seconds. */
  error: Accessor<string | null>;
  /** The popups open in the page, which the host sends only to the person in
   *  control. One per tab, newest last. */
  popups: Accessor<BrowserPopup[]>;
  /** Stop drawing a tab's popup here: the person closed it in the panel. */
  dismissPopup: (tab: string) => void;
  /** Send one message; dropped unless the socket is open. */
  send: (msg: ViewerMessage) => void;
  /** Try again now: the session list says a browser is there again. */
  retry: () => void;
}

/** A real WebSocket behind the narrow interface above. */
function browserSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  const like: WebSocketLike = {
    get readyState() {
      return ws.readyState;
    },
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => like.onopen?.();
  ws.onmessage = (e) => like.onmessage?.({ data: e.data });
  ws.onclose = () => like.onclose?.();
  ws.onerror = () => like.onerror?.();
  return like;
}

/** The stream URL with a WebSocket scheme, resolved against the page. */
function socketUrl(session: string, owner: string | undefined): string {
  const base = typeof location === "undefined" ? "http://localhost/" : location.href;
  const url = new URL(browserStreamUrl(session, owner), base);
  url.protocol = wsScheme(url.protocol);
  return url.toString();
}

export function createBrowserStream(opts: BrowserStreamOptions): BrowserStream {
  const open = opts.socket ?? browserSocket;
  const [status, setStatus] = createSignal<"idle" | "connecting" | "open" | "unavailable">("idle");
  const [state, setState] = createSignal<BrowserState | "closed" | null>(null);
  const [tabs, setTabs] = createSignal<BrowserTab[]>([]);
  const [agentTab, setAgentTab] = createSignal<string | null>(null);
  const [you, setYou] = createSignal<string | null>(null);
  const [greeted, setGreeted] = createSignal(false);
  const [control, setControl] = createSignal<BrowserControl>(NOBODY);
  const [viewport, setViewport] = createSignal<Size>(DEFAULT_VIEWPORT);
  const [frame, setFrame] = createSignal<BrowserFrame | null>(null);
  const [activity, setActivity] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [popups, setPopups] = createSignal<BrowserPopup[]>([]);
  const dismissPopup = (tab: string): void => {
    setPopups((all) => (all.some((p) => p.tab === tab) ? all.filter((p) => p.tab !== tab) : all));
  };

  let ws: WebSocketLike | null = null;
  let subscribed = false;
  /** The `you` of the last connection the host greeted, kept across
   *  reconnects so the next one can name it in a resume. */
  let lastYou: string | null = null;
  /** The previous connection a resume on this socket named, while the host
   *  still says that one holds control. */
  let resuming: string | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = RETRY_FIRST_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lingerTimer: ReturnType<typeof setTimeout> | undefined;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const tab = (): string | null => opts.tab?.() ?? null;
  const isOpen = (): boolean => ws !== null && ws.readyState === OPEN;

  const send = (msg: ViewerMessage): void => {
    if (!ws || !isOpen()) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* a socket closing under us; its onclose follows */
    }
  };

  /** Subscribe if the surface is active and the browser may be woken. */
  const maybeSubscribe = (): void => {
    if (!untrack(greeted) || subscribed || !untrack(opts.active)) return;
    if (untrack(state) === "closed") return;
    if (untrack(state) === "frozen" && !opts.wake) return;
    subscribed = true;
    send({ t: "subscribe", tab: untrack(tab) });
  };

  const drop = (sock: WebSocketLike): void => {
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    try {
      sock.close(1000);
    } catch {
      /* already closed */
    }
  };

  const stopResuming = (): void => {
    clearTimeout(resumeTimer);
    resumeTimer = undefined;
    resuming = null;
  };

  /** The socket is gone: nothing sent now would reach the host. */
  const forget = (): void => {
    setGreeted(false);
    subscribed = false;
    setYou(null);
    stopResuming();
  };

  /**
   * Ask the host to move control held by `prev`, this viewer's previous
   * connection, to this one; again later while the host still names `prev`.
   */
  const resume = (prev: string, holderId: string | null): void => {
    send({ t: "resume", prev });
    if (holderId !== prev) return;
    resuming = prev;
    let wait = RESUME_RETRY_FIRST_MS;
    let tries = 1;
    const again = (): void => {
      resumeTimer = undefined;
      if (resuming !== prev || untrack(control).holderId !== prev) return;
      send({ t: "resume", prev });
      if (++tries >= RESUME_TRIES) return;
      wait *= 2;
      resumeTimer = setTimeout(again, wait);
    };
    resumeTimer = setTimeout(again, wait);
  };

  const disconnect = (): void => {
    clearTimeout(lingerTimer);
    lingerTimer = undefined;
    if (ws) drop(ws);
    ws = null;
    forget();
  };

  const scheduleRetry = (): void => {
    clearTimeout(retryTimer);
    if (disposed || !untrack(opts.active) || untrack(state) === "closed") return;
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  const onMessage = (data: unknown): void => {
    if (typeof data !== "string") return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObj(msg)) return;
    switch (msg.t) {
      case "hello": {
        setGreeted(true);
        retryMs = RETRY_FIRST_MS;
        setState(msg.state === "frozen" ? "frozen" : "live");
        setTabs(tabsOf(msg.tabs));
        setAgentTab(strOrNull(msg.agentTab));
        const me = strOrNull(msg.you);
        setYou(me);
        const ctl = controlOf(msg.control);
        setControl(ctl);
        // Right after the hello, before anything else: control this viewer
        // held on its last connection moves here (tl-browser acc9709f). The
        // host checks the rest, so this goes whether or not control was held.
        stopResuming();
        if (lastYou !== null && me !== null && lastYou !== me) resume(lastYou, ctl.holderId);
        if (me !== null) lastYou = me;
        // The host sends a new connection the popups it should draw.
        setPopups([]);
        if (isObj(msg.viewport)) {
          const w = numOrNull(msg.viewport.w);
          const h = numOrNull(msg.viewport.h);
          if (w && h) setViewport({ w, h });
        }
        setError(null);
        maybeSubscribe();
        return;
      }
      case "frame": {
        if (typeof msg.tab !== "string" || typeof msg.jpeg !== "string") return;
        const f: BrowserFrame = {
          tab: msg.tab,
          src: `data:image/jpeg;base64,${msg.jpeg}`,
          w: numOrNull(msg.w) ?? untrack(viewport).w,
          h: numOrNull(msg.h) ?? untrack(viewport).h,
        };
        setFrame(f);
        if (opts.keep) keep(opts.keep, f);
        return;
      }
      case "tabs":
        setTabs(tabsOf(msg.tabs));
        setAgentTab(strOrNull(msg.agentTab));
        return;
      case "control": {
        const next = controlOf(msg);
        // A popup is the holding connection's: when control changes hands,
        // even between one person's two devices, the host sends the new
        // holder what is still open.
        if (next.holderId !== untrack(control).holderId) setPopups([]);
        setControl(next);
        if (resuming !== null && next.holderId !== resuming) stopResuming();
        return;
      }
      case "popup": {
        const p = popupOf(msg);
        if (!p) return;
        dismissPopup(p.tab);
        if (p.kind !== "none") setPopups((all) => [...all, p]);
        return;
      }
      case "state":
        if (msg.state === "live" || msg.state === "frozen" || msg.state === "closed") {
          setState(msg.state);
          if (msg.state === "closed") setPopups([]);
          if (msg.state === "live") maybeSubscribe();
        }
        return;
      case "activity":
        if (typeof msg.summary === "string") setActivity(msg.summary);
        return;
      case "copied":
        if (typeof msg.text === "string") opts.onCopied?.(msg.text);
        return;
      case "error":
        if (typeof msg.message !== "string") return;
        setError(msg.message);
        // A complaint is about the last thing tried ("Take control of the
        // browser first"), so it goes once it has been read.
        clearTimeout(errorTimer);
        errorTimer = setTimeout(() => setError(null), ERROR_SHOWN_MS);
        return;
    }
  };

  function connect(): void {
    clearTimeout(retryTimer);
    if (disposed || ws || !untrack(opts.active) || untrack(state) === "closed") return;
    setStatus("connecting");
    let sock: WebSocketLike;
    try {
      sock = open(socketUrl(opts.session, opts.owner));
    } catch {
      setStatus("unavailable");
      scheduleRetry();
      return;
    }
    ws = sock;
    let opened = false;
    sock.onopen = () => {
      opened = true;
      setStatus("open");
    };
    sock.onmessage = (e) => onMessage(e.data);
    sock.onerror = () => {
      /* onclose follows and decides */
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      forget();
      setStatus(opened ? "idle" : "unavailable");
      scheduleRetry();
    };
  }

  createEffect(
    on(opts.active, (active) => {
      if (active) {
        clearTimeout(lingerTimer);
        lingerTimer = undefined;
        if (ws) maybeSubscribe();
        else connect();
        return;
      }
      clearTimeout(retryTimer);
      if (subscribed) {
        send({ t: "unsubscribe" });
        subscribed = false;
      }
      if (ws && lingerTimer === undefined) {
        lingerTimer = setTimeout(() => {
          lingerTimer = undefined;
          disconnect();
          setStatus("idle");
        }, LINGER_MS);
      }
    }),
  );

  // A new tab to watch: tell the host, if it is already sending this stream
  // frames. A stream not yet subscribed sends the tab when it subscribes.
  createEffect(
    on(
      tab,
      (t) => {
        if (subscribed) send({ t: "subscribe", tab: t });
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    disposed = true;
    clearTimeout(retryTimer);
    clearTimeout(errorTimer);
    disconnect();
  });

  return {
    status,
    state,
    tabs,
    agentTab,
    you,
    greeted,
    control,
    viewport,
    frame,
    activity,
    error,
    popups,
    dismissPopup,
    send,
    retry: () => {
      retryMs = RETRY_FIRST_MS;
      if (untrack(state) === "closed") setState(null);
      if (!ws) connect();
    },
  };
}

/**
 * Whether an element can be seen: it intersects the viewport, and the tab is
 * visible. The two inputs `streamWanted` (components/browser.logic.ts) needs
 * besides the surface's own reasons. A slot the lobby keeps mounted behind
 * another session is `display: none`, which the observer reports as not
 * intersecting, so a hidden session's card stops too.
 *
 * Where the page has no IntersectionObserver (jsdom), every element counts as
 * intersecting, and the document gate still applies.
 */
export function createVisibility(el: Accessor<Element | undefined>): {
  intersecting: Accessor<boolean>;
  documentVisible: Accessor<boolean>;
} {
  const documentVisible = createDocumentVisible();
  const [intersecting, setIntersecting] = createSignal(typeof IntersectionObserver === "undefined");
  if (typeof IntersectionObserver !== "undefined") {
    createEffect(() => {
      const node = el();
      if (!node) return;
      const io = new IntersectionObserver((entries) => {
        const last = entries.at(-1);
        if (last) setIntersecting(last.isIntersecting);
      });
      io.observe(node);
      onCleanup(() => io.disconnect());
    });
  }
  return { intersecting, documentVisible };
}

/**
 * Whether the lobby's page is visible (document.visibilityState), the one
 * input the Browser panel takes from the page besides its session being on
 * screen (browser.logic `panelStreamWanted`).
 */
export function createDocumentVisible(): Accessor<boolean> {
  const docVisible = (): boolean =>
    typeof document === "undefined" || document.visibilityState !== "hidden";
  const [visible, setVisible] = createSignal(docVisible());
  if (typeof document !== "undefined") {
    const onVis = (): void => {
      setVisible(docVisible());
    };
    document.addEventListener("visibilitychange", onVis);
    onCleanup(() => document.removeEventListener("visibilitychange", onVis));
  }
  return visible;
}
