/**
 * Which sessions stay mounted in the background.
 *
 * Switching sessions used to unmount the whole `SessionView` and build a new
 * one: a fresh iframe, a re-parse of the 1.7 MB terminal page, a new xterm, a
 * new ttyd WebSocket, a tmux attach and a new SSE stream. Measured on the
 * deployed build, that put a themed cover over the pane for 1,797 ms on every
 * switch, and the cover was lifted by the lobby's 1,800 ms fallback timer rather
 * than by the terminal being ready.
 *
 * So a session you have opened stays mounted and CSS-hidden, and switching back
 * to it shows what is already there. Viktor's call (2026-08-19): keep every
 * session you visit, with a one-day TTL, rather than a small LRU.
 *
 * What a kept session costs while it sits there: one ttyd WebSocket, one
 * attached tmux client, one SSE stream on the server, and one xterm buffer in
 * the tab. tmux sizes a window to its latest active client, so a hidden client
 * holding an older size does not shrink the pane the visible one is using.
 *
 * TWO THINGS ARE LOAD-BEARING, and both exist because moving or replacing the
 * DOM node a session hangs off tears its terminal down with it. That used to
 * mean an iframe reload; since 2c64552 it means Solid disposing TerminalNative,
 * which drops the xterm instance, the ttyd socket and the tmux attach — the
 * same cost this module exists to avoid:
 *
 *   - `list` only ever grows at the end and shrinks by removal. It is not an
 *     LRU queue and must not become one.
 *   - The entries in `list` are STABLE objects. Visiting a session again
 *     updates `seen`, a plain map beside the list, so `<For>` sees an unchanged
 *     array and leaves the DOM alone.
 */

import { createSignal } from "solid-js";

/** One kept session's identity. Created once, then never replaced. */
export interface KeptSession {
  /** identity across owners: `keyOf`, so it survives a rename */
  key: string;
  /** the name it was kept under, which a rename leaves behind: read the
   *  session's current name from the list by `key` */
  name: string;
  owner?: string;
}

export interface KeepState {
  list: KeptSession[];
  /** key -> epoch ms when that session was last on screen */
  seen: Record<string, number>;
}

/** How long an unvisited session keeps its mount. */
export const KEEP_TTL_MS = 24 * 60 * 60 * 1000;

/** The selected session, as the lobby knows it. */
export interface Selected {
  name: string;
  owner?: string;
}

export const EMPTY_KEEP: KeepState = { list: [], seen: {} };

const rawKey = (owner: string | undefined, name: string): string =>
  `${owner ?? ""}\u0000${name}`;

/**
 * Each listed session's birth name, by its current key, for the sessions whose
 * birth name is not already their name.
 *
 * A signal because `keyOf` runs inside memos (the selected key, the tiles, the
 * workspace members), and a rename has to re-run them under the same answer.
 */
const [births, setBirths] = createSignal<ReadonlyMap<string, string>>(new Map());

/**
 * Record each session's birth name from a fresh session list. The lobby store
 * calls this on every poll, before anything reads the new list.
 *
 * An own session is keyed with NO owner even though `/sessions` stamps one on
 * it, the convention every caller of `keyOf` already follows, so `me` is
 * needed to strip it.
 */
export function noteBirthNames(
  rows: ReadonlyArray<{ name: string; owner?: string; bornAs?: string }>,
  me: string,
): void {
  const next = new Map<string, string>();
  for (const s of rows) {
    if (!s.bornAs || s.bornAs === s.name) continue;
    const owner = s.owner && s.owner !== me ? s.owner : undefined;
    next.set(rawKey(owner, s.name), s.bornAs);
  }
  setBirths(next);
}

/**
 * A session's identity. The owner is part of it: two people can have a session
 * of the same name, and they are different terminals.
 *
 * The name part is the session's BIRTH NAME when it has one (CONTEXT.md), not
 * its current name. A session is renamed seconds after it is created, when its
 * first title lands (ADR-0022), and a key that moved with it read as a
 * different terminal: the lobby disposed the live one and attached a fresh one,
 * a blank pane for most of a second while Claude's first reply streamed. Keyed
 * by birth name, the rename changes the label and nothing else. Asked with the
 * old name, as a tab still holding the id it minted does, the answer is the
 * same key, because the old name is the birth name.
 */
export function keyOf(sel: Selected): string {
  const born = births().get(rawKey(sel.owner, sel.name));
  return rawKey(sel.owner, born ?? sel.name);
}

/**
 * A listed session's key. An own session is keyed with NO owner even though
 * `/sessions` stamps one on it, which is the convention the selection and the
 * workspace members are written in.
 */
export function sessionKey(s: { name: string; owner?: string }, me: string): string {
  return keyOf(s.owner && s.owner !== me ? { name: s.name, owner: s.owner } : { name: s.name });
}

/**
 * Record that `selected` is the session on screen: append it if it is new,
 * otherwise just note when it was seen. The `list` reference only changes when
 * a session is actually added.
 */
export function keepSelected(
  state: KeepState,
  selected: Selected | null,
  now: number,
): KeepState {
  if (!selected) return state;
  const key = keyOf(selected);
  const seen = { ...state.seen, [key]: now };
  if (state.list.some((k) => k.key === key)) return { list: state.list, seen };
  return {
    list: [...state.list, { key, name: selected.name, owner: selected.owner }],
    seen,
  };
}

/**
 * Drop the mounts worth dropping: sessions unvisited for longer than `ttl`, and
 * sessions the lobby no longer lists (killed elsewhere, or gone with their tmux
 * server). The selected one always survives — it is the view on screen.
 *
 * `live` is the set of session KEYS (`keyOf`) the lobby currently knows about,
 * so a session renamed since it was kept is still live; pass undefined while
 * the list is unknown, which keeps everything.
 */
export function pruneKept(
  state: KeepState,
  selected: Selected | null,
  now: number,
  ttl: number = KEEP_TTL_MS,
  live?: ReadonlySet<string>,
): KeepState {
  const selKey = selected ? keyOf(selected) : null;
  const list = state.list.filter((k) => {
    if (k.key === selKey) return true;
    if (now - (state.seen[k.key] ?? 0) > ttl) return false;
    if (live && !live.has(k.key)) return false;
    return true;
  });
  if (list.length === state.list.length) return state;
  const seen: Record<string, number> = {};
  for (const k of list) {
    const at = state.seen[k.key];
    if (at !== undefined) seen[k.key] = at;
  }
  return { list, seen };
}
