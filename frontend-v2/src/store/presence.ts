import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
} from "solid-js";
import { presenceUrl } from "../lib/config";
import type { WebSocketLike } from "../lib/browser-stream";
import { wsScheme } from "../terminal/wire";
import type { PresencePerson, SenderRecord } from "../components/presence.logic";

/**
 * The presence socket for one open session (ADR-0043, session-events
 * presence.go): who else has it open, the draft each of them is typing, and
 * who sent each prompt. Connected while `active` holds, which is while the
 * session is on screen, so being present means having it in front of you.
 */
export interface Presence {
  /** Everyone with the session open, this tab included. */
  people: Accessor<PresencePerson[]>;
  /** This tab's own id in `people`. */
  myId: Accessor<string>;
  /** Every prompt's sender the server knows of, oldest first. */
  senders: Accessor<SenderRecord[]>;
  /** The server's clock now, in ms: what a draft's `draftAt` is compared to. */
  serverNow: Accessor<number>;
  /** Publish this tab's unsent draft. Throttled; "" clears it. */
  setDraft: (text: string) => void;
}

export interface PresenceOptions {
  session: Accessor<string>;
  /** The session's owner when it is someone else's. */
  owner?: string;
  active: Accessor<boolean>;
  /** Injected in tests. */
  socket?: (url: string) => WebSocketLike;
  now?: () => number;
}

/** The least gap between two drafts on the wire. Each keystroke is a frame
 *  otherwise; this keeps a fast typist to ~12 a second and still reads live. */
export const DRAFT_THROTTLE_MS = 80;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15_000;
const OPEN = 1;

function realSocket(url: string): WebSocketLike {
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

function socketUrl(session: string, owner: string | undefined): string {
  const base = typeof location === "undefined" ? "http://localhost/" : location.href;
  const url = new URL(presenceUrl(session, owner), base);
  url.protocol = wsScheme(url.protocol);
  return url.toString();
}

interface Frame {
  t?: string;
  id?: string;
  now?: number;
  people?: PresencePerson[];
  senders?: SenderRecord[];
}

export function createPresence(opts: PresenceOptions): Presence {
  const now = opts.now ?? Date.now;
  const open = opts.socket ?? realSocket;
  const [people, setPeople] = createSignal<PresencePerson[]>([]);
  const [myId, setMyId] = createSignal("");
  const [senders, setSenders] = createSignal<SenderRecord[]>([]);
  // The server's clock minus ours, from the last room frame.
  let skew = 0;
  const [tick, setTick] = createSignal(0);
  const serverNow = (): number => {
    tick();
    return now() + skew;
  };

  let ws: WebSocketLike | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = RETRY_MIN_MS;
  let ticker: ReturnType<typeof setInterval> | undefined;

  // The draft: the newest text, what the server last got, and the trailing send.
  let draft = "";
  let sent = "";
  let lastSendAt = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    pending = undefined;
    if (!ws || ws.readyState !== OPEN || draft === sent) return;
    ws.send(JSON.stringify({ t: "draft", text: draft }));
    sent = draft;
    lastSendAt = now();
  };

  const setDraft = (text: string) => {
    draft = text;
    if (pending !== undefined) return;
    const wait = DRAFT_THROTTLE_MS - (now() - lastSendAt);
    // An empty draft goes at once: the message was sent or cleared, and the
    // others should stop seeing it now.
    if (wait <= 0 || text === "") flush();
    else pending = setTimeout(flush, wait);
  };

  const onFrame = (raw: unknown) => {
    if (typeof raw !== "string") return;
    let f: Frame;
    try {
      f = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    switch (f.t) {
      case "hello":
        setMyId(f.id ?? "");
        // A reconnect starts from a server that knows no draft of ours.
        sent = "";
        flush();
        break;
      case "room":
        if (typeof f.now === "number") skew = f.now - now();
        setPeople(f.people ?? []);
        break;
      case "senders":
        if (f.senders?.length) setSenders((all) => [...all, ...(f.senders ?? [])]);
        break;
    }
  };

  const connect = () => {
    retry = undefined;
    const sock = open(socketUrl(opts.session(), opts.owner));
    ws = sock;
    // The connect snapshot repeats every record, so start from nothing.
    setSenders([]);
    sock.onopen = () => {
      backoff = RETRY_MIN_MS;
    };
    sock.onmessage = (e) => onFrame(e.data);
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setPeople([]);
      setMyId("");
      if (opts.active()) {
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      }
    };
    sock.onerror = () => sock.close();
  };

  const disconnect = () => {
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    if (pending !== undefined) clearTimeout(pending);
    pending = undefined;
    const sock = ws;
    ws = null;
    sock?.close();
    setPeople([]);
    setMyId("");
  };

  createEffect(() => {
    const on = opts.active();
    // Reconnect under a new name after a rename.
    opts.session();
    disconnect();
    if (on) connect();
  });
  // Typing turns into a resting draft with time alone, so the view needs a
  // clock while anyone is present.
  ticker = setInterval(() => setTick((n) => n + 1), 1000);
  onCleanup(() => {
    disconnect();
    if (ticker !== undefined) clearInterval(ticker);
  });

  return { people, myId, senders, serverNow, setDraft };
}

/** The open session's presence and whose session it is, for the parts of the
 *  Text view that draw it (the draft previews, the sender labels). */
export interface PresenceView {
  presence: Presence;
  /** The session's owner (OS account): attribution labels nothing until
   *  someone other than them has sent. */
  owner: string;
  /** The viewer's own OS account. */
  me: string;
}

const PresenceContext = createContext<PresenceView | undefined>(undefined);

export const PresenceProvider = PresenceContext.Provider;

export function usePresence(): PresenceView | undefined {
  return useContext(PresenceContext);
}
