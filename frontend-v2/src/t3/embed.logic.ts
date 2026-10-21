/**
 * The lobby's half of the T3 view's embed contract (t3-view/EMBED.md): where
 * the frame is served, which thread it shows, which messages the lobby accepts
 * from it, and which chords it hands back. Pure, so every rule is testable
 * without a frame; components/T3Host.tsx is the DOM around it.
 *
 * The frame is T3 Code's own web client on its own origin (ADR-0044), so
 * everything that crosses between the two documents is a postMessage, and the
 * lobby trusts a message only when it comes from that origin AND from the one
 * frame it made.
 */

import type { ResolvedBinding } from "../keybindings/bindings.logic";
import { lsGet, lsSet } from "../lib/storage";
import type { SessionTool } from "../types/lobby";

// ---- where the frame is served -------------------------------------------

/**
 * T3's host name, beside the lobby's own: where the lobby frames the T3 view
 * and where T3's own apps pair (ADR-0045 decision 6). `t3view` serves the same
 * sidecar as a fallback, so rolling the frame back is this one constant, and
 * it moves pairing links along with it.
 */
const T3_LABEL = "t3";

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";

const isIp = (host: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");

/**
 * The domain the lobby and the T3 view share: the lobby's host without its
 * first label (terminal.example.com -> example.com), or the host itself when
 * it is already two labels. Null on a loopback, an address or a bare name,
 * where there is no sibling host to name.
 */
function sharedDomain(hostname: string): string | null {
  const h = hostname.toLowerCase();
  if (isLoopback(h) || isIp(h)) return null;
  const labels = h.split(".");
  if (labels.length < 2 || labels.some((l) => !l)) return null;
  return labels.length === 2 ? h : labels.slice(1).join(".");
}

/**
 * Where T3 lives in production: `t3.` on the lobby's own domain, so a deploy
 * on another domain needs no rebuild. The T3 view frames it, and Settings →
 * T3 apps points pairing links at it. Null where the lobby runs on loopback
 * (a dev server), which offers no T3 view unless `?t3view=` names one, and
 * shows a pairing code without a link.
 */
export function defaultT3Origin(lobbyHostname: string): string | null {
  const d = sharedDomain(lobbyHostname);
  return d ? `https://${T3_LABEL}.${d}` : null;
}

/**
 * An override the lobby will frame, as a bare origin, or null.
 *
 * This decides which page the lobby frames AND whose key messages it replays
 * as lobby commands, so a link carrying `?t3view=` must not be able to point
 * it at a page someone else controls: http on loopback, for a local sidecar,
 * and nothing else. Other pages on the lobby's own site are refused too,
 * since anyone with a space on pages.viktorbarzin.me could publish one.
 * Anything with a path, a query or credentials is refused rather than
 * trimmed, because it was not written as an origin.
 */
export function allowedT3Origin(candidate: string): string | null {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  return u.protocol === "http:" && isLoopback(u.hostname.toLowerCase()) ? u.origin : null;
}

/**
 * The T3 view's origin for this page: `?t3view=<origin>` when that is allowed
 * (the local check against a dev sidecar), else the default beside the lobby.
 */
export function t3ViewOrigin(loc: { hostname: string; search: string }): string | null {
  let override = "";
  try {
    override = new URLSearchParams(loc.search).get("t3view") ?? "";
  } catch {
    override = "";
  }
  const allowed = override ? allowedT3Origin(override) : null;
  return allowed ?? defaultT3Origin(loc.hostname);
}

/**
 * The frame's `allow` attribute: clipboard access for the production T3 view
 * beside the lobby, and nothing for a dev override. A permission the person
 * granted the lobby carries into a frame it delegates to.
 */
export function t3FrameAllow(origin: string, lobbyHostname: string): string | undefined {
  return origin === defaultT3Origin(lobbyHostname) ? "clipboard-read; clipboard-write" : undefined;
}

// ---- which thread it shows ------------------------------------------------

/**
 * The T3 thread id for a session, from its keepalive key (store/keepalive.ts
 * `keyOf`): the session's BIRTH NAME, which a rename leaves alone (ADR-0022).
 * The sidecar maps it to the session's current name before every call.
 *
 * Only your own sessions have one. A key with an owner in front of the NUL is
 * somebody else's session, which the T3 view does not serve.
 */
export function t3ThreadId(key: string): string | null {
  const nul = key.indexOf("\u0000");
  if (nul !== 0) return null;
  const name = key.slice(1);
  return name ? name : null;
}

/**
 * The frame's URL. With the environment id known it is T3's own thread route,
 * `/{environmentId}/{threadId}`; without it, or with no thread (a preload),
 * the root, and the thread follows by `tl-open` once the frame has said which
 * environment it is. `embed` turns on the patch.
 *
 * The lobby's origin does not travel in the URL: the frame reads its parent's
 * origin from the browser (`location.ancestorOrigins`, or the referrer), which
 * the page that frames it cannot choose.
 */
export function t3FrameUrl(o: {
  origin: string;
  environmentId: string | null;
  threadId: string | null;
}): string {
  if (!o.environmentId || !o.threadId) return `${o.origin}/?embed`;
  return `${o.origin}/${encodeURIComponent(o.environmentId)}/${encodeURIComponent(o.threadId)}?embed`;
}

// ---- the environment id cache ----------------------------------------------

const ENV_PREFIX = "tl:t3view:env:v1:";

/** The environment id a frame from this origin last announced, if any. */
export function loadEnvironmentId(origin: string): string | null {
  return lsGet(ENV_PREFIX + origin);
}

export function saveEnvironmentId(origin: string, id: string): void {
  lsSet(ENV_PREFIX + origin, id);
}

// ---- messages --------------------------------------------------------------

/** One chord the frame hands back to the lobby instead of acting on it. */
export interface FrameChord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** lowercased `KeyboardEvent.key` identity ("1", "[", "enter", "escape"). */
  key: string;
  /** the physical `KeyboardEvent.code` that also matches, where the key has
   *  one: a modifier can change `key` (Mac Option+1 is "¡"), never `code`. */
  code?: string;
  /** keep the key in the frame while its focus is in a text field. */
  notWhileEditing?: true;
  /** forward only when T3 left it unhandled, and do not preventDefault. */
  passive?: true;
}

/** Lobby -> frame. */
export type HostMessage =
  | { type: "tl-bindings"; v: 1; chords: FrameChord[] }
  | { type: "tl-open"; v: 1; threadId: string };

/** Frame -> lobby: the frame has booted and knows its environment. */
export interface TlReadyMessage {
  type: "tl-ready";
  v: 1;
  environmentId: string;
  /** the thread it is showing now, null on any other route. */
  threadId: string | null;
}

/** Frame -> lobby: a chord from the list was pressed inside the frame. */
export interface TlKeyMessage {
  type: "tl-key";
  v: 1;
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
}

/** The session the sidecar says a T3 thread is, as the lobby keys it. */
export interface RouteSession {
  /** the lobby key's name: the session's birth name, else its name now. */
  key: string;
  /** the session's tmux name now. */
  name: string;
}

/**
 * Frame -> lobby: the frame moved to another route on its own (T3's palette,
 * New thread). `threadId` is null on a route that is no thread (a draft, the
 * index); `session` is null when no session of the caller's is that thread.
 */
export interface TlRouteMessage {
  type: "tl-route";
  v: 1;
  threadId: string | null;
  session: RouteSession | null;
}

export type FrameMessage = TlReadyMessage | TlKeyMessage | TlRouteMessage;

/** `key` and `code` are short names ("Backspace", "BracketLeft"); anything
 *  longer is not a key. */
const MAX_KEY_LEN = 32;
const MAX_ID_LEN = 256;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const shortString = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max;

const parseRouteSession = (v: unknown): RouteSession | null | undefined => {
  if (v === null) return null;
  if (!isRecord(v)) return undefined;
  const { key, name } = v;
  if (!shortString(key, MAX_ID_LEN) || !key || !shortString(name, MAX_ID_LEN) || !name) {
    return undefined;
  }
  return { key, name };
};

/**
 * A message from the frame, or null. Exactly the shapes the contract has, at
 * version 1: a key is replayed as a keydown and nothing more, and a route
 * report can at most move the lobby to one of the caller's own sessions.
 */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!isRecord(data) || data.v !== 1) return null;
  if (data.type === "tl-ready") {
    const { environmentId, threadId } = data;
    if (!shortString(environmentId, MAX_ID_LEN) || !environmentId) return null;
    if (threadId !== null && !shortString(threadId, MAX_ID_LEN)) return null;
    return { type: "tl-ready", v: 1, environmentId, threadId };
  }
  if (data.type === "tl-key") {
    const { key, code, ctrlKey, metaKey, shiftKey, altKey, repeat } = data;
    if (!shortString(key, MAX_KEY_LEN) || !key || !shortString(code, MAX_KEY_LEN)) return null;
    if (
      typeof ctrlKey !== "boolean" ||
      typeof metaKey !== "boolean" ||
      typeof shiftKey !== "boolean" ||
      typeof altKey !== "boolean" ||
      typeof repeat !== "boolean"
    ) {
      return null;
    }
    return { type: "tl-key", v: 1, key, code, ctrlKey, metaKey, shiftKey, altKey, repeat };
  }
  if (data.type === "tl-route") {
    const { threadId } = data;
    if (threadId !== null && (!shortString(threadId, MAX_ID_LEN) || !threadId)) return null;
    const session = parseRouteSession(data.session);
    if (session === undefined) return null;
    return { type: "tl-route", v: 1, threadId, session };
  }
  return null;
}

/**
 * The name of the caller's own session a frame's route report names, or null.
 * Matched by key first (the birth name, which a rename leaves alone), then by
 * the name the sidecar saw. Someone else's session is never a match: the T3
 * view serves only the caller's own.
 */
export function followTarget(
  sessions: ReadonlyArray<{ name: string; bornAs?: string; owner?: string }>,
  me: string,
  target: RouteSession,
): string | null {
  const own = sessions.filter((s) => !s.owner || s.owner === me);
  const byKey = own.find((s) => (s.bornAs ?? s.name) === target.key);
  return (byKey ?? own.find((s) => s.name === target.name))?.name ?? null;
}

/**
 * Whether a forwarded key is one of the chords the lobby sent the frame, by
 * the same rule the frame matches with (EMBED.md "Forwarding keys"): all four
 * modifiers equal, and the key (with "esc" read as "escape") or the code
 * matches. A key the lobby never asked for is dropped, so a frame cannot
 * replay an arbitrary lobby command.
 */
export function keyInChords(m: TlKeyMessage, chords: readonly FrameChord[]): boolean {
  const lower = m.key.toLowerCase();
  const key = lower === "esc" ? "escape" : lower;
  return chords.some(
    (c) =>
      c.ctrl === m.ctrlKey &&
      c.shift === m.shiftKey &&
      c.alt === m.altKey &&
      c.meta === m.metaKey &&
      (c.key === key || (c.code !== undefined && c.code === m.code)),
  );
}

/** The keydown a forwarded key becomes in the lobby's document. */
export function replayInit(m: TlKeyMessage): KeyboardEventInit {
  return {
    key: m.key,
    code: m.code,
    ctrlKey: m.ctrlKey,
    metaKey: m.metaKey,
    shiftKey: m.shiftKey,
    altKey: m.altKey,
    repeat: m.repeat,
    bubbles: true,
    cancelable: true,
  };
}

// ---- the chords the frame hands back --------------------------------------

/** The physical key a chord's key also matches on (chords.logic eventChordKeys). */
function codeFor(key: string): string | undefined {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === "[") return "BracketLeft";
  if (key === "]") return "BracketRight";
  if (key === "/") return "Slash";
  return undefined;
}

/**
 * Keys the lobby handles outside the binding table: Ctrl/Cmd+J opens the
 * scratch-shell dock (App.tsx `onDockKey`), and Escape closes whatever lobby
 * overlay is up. Escape is passive: T3 closes its own menus with it first.
 */
const EXTRA_CHORDS: FrameChord[] = [
  { ctrl: true, shift: false, alt: false, meta: false, key: "j", code: "KeyJ" },
  { ctrl: false, shift: false, alt: false, meta: true, key: "j", code: "KeyJ" },
  { ctrl: false, shift: false, alt: false, meta: false, key: "escape", passive: true },
];

/**
 * Every chord the lobby would act on, for the frame to hand back.
 *
 * The frame cannot see the lobby's when-clauses, and does not need to: the
 * replayed keydown goes through the lobby's own engine, which evaluates them.
 * The one clause the lobby cannot evaluate is `editing`, because focus inside
 * the frame is invisible to it, so a row that carries `!editing` is marked and
 * the frame keeps that key while its own focus is in a field.
 */
export function frameChords(b: {
  enabled: boolean;
  defaults: readonly ResolvedBinding[];
  always: readonly ResolvedBinding[];
}): FrameChord[] {
  const rows = b.enabled ? [...b.always, ...b.defaults] : [...b.always];
  const out: FrameChord[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const c = r.chord;
    if (!c) continue;
    const id = `${c.ctrl}${c.shift}${c.alt}${c.meta}:${c.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const code = codeFor(c.key);
    out.push({
      ctrl: c.ctrl,
      shift: c.shift,
      alt: c.alt,
      meta: c.meta,
      key: c.key,
      ...(code ? { code } : {}),
      ...(r.when?.includes("!editing") ? { notWhileEditing: true as const } : {}),
    });
  }
  for (const x of EXTRA_CHORDS) {
    const id = `${x.ctrl}${x.shift}${x.alt}${x.meta}:${x.key}`;
    if (!seen.has(id)) out.push(x);
  }
  return out;
}

// ---- who is offered it -----------------------------------------------------

/**
 * Whether a session offers the T3 view: any lobby user (ADR-0045 decision 4,
 * which dropped the admin-only gate of the first cut), acting as themselves,
 * on their own Claude session (design decisions 12, 16 and 17). The sidecar
 * shows each caller only their own sessions and refuses act-as on its own;
 * this only keeps the switcher from offering a view that could not work.
 */
export function t3Offered(o: {
  actingAs: boolean;
  foreign: boolean;
  tool: SessionTool | undefined;
}): boolean {
  return !o.actingAs && !o.foreign && o.tool === "claude";
}
