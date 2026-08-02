import { createMemo, createSignal, type Accessor } from "solid-js";
import {
  buildGroups,
  recentsFirst,
  type PaletteGroup,
  type PaletteItem,
} from "./palette.logic";
import { track } from "../telemetry/track";

/**
 * The reactive controller behind the command palette (feature-inventory Cat.2
 * "Command palette"). Ported from the vanilla frontend/index.html `createPalette`
 * (index.html:3594-3763), reshaped from imperative DOM building into Solid
 * signals so `CommandPalette.tsx` is a thin view. Pure ranking/filtering lives in
 * palette.logic.ts; this owns open/close state, the async session cache, the
 * query, and the keyboard selection index.
 */

/** An action row (New session / Kill / Rename / gallery / paste / help). */
export interface PaletteAction {
  label: string;
  hint?: string;
  danger?: boolean;
  keepFocus?: boolean;
  run: () => void;
}

/** The host wiring the palette drives. */
export interface PaletteEnv {
  /** the session list to rank (resolved once per open; may be async). */
  sessions: () => Promise<{ name: string; state?: string }[]>;
  /** the currently-attached session name (marked "current"), or null. */
  current: () => string | null;
  /** attach a session by name. */
  attach: (name: string) => void;
  /** the action rows, recomputed each render (so "current"-dependent rows track). */
  actions: () => PaletteAction[];
  /** hand keyboard focus back to the terminal (non-keepFocus items). */
  refocus: () => void;
}

/** A flattened render row: a group label, an inline note, or a selectable item. */
export type PaletteRow =
  | { kind: "label"; label: string }
  | { kind: "note"; note: string }
  | { kind: "item"; item: PaletteItem; index: number };

export interface PaletteController {
  isOpen: Accessor<boolean>;
  open: () => void;
  close: (refocus?: boolean) => void;
  toggle: () => void;
  query: Accessor<string>;
  setQuery: (q: string) => void;
  rows: Accessor<PaletteRow[]>;
  flatItems: Accessor<PaletteItem[]>;
  selIdx: Accessor<number>;
  setSel: (i: number) => void;
  moveSel: (delta: number) => void;
  runItem: (item: PaletteItem) => void;
  runSelected: () => void;
}

const VISITS_KEY = "tl:session-visits:v1";

function readVisitTimes(): Record<string, number> {
  try {
    const obj = JSON.parse(localStorage.getItem(VISITS_KEY) ?? "null");
    return obj && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

export function createPaletteController(env: PaletteEnv): PaletteController {
  const [isOpen, setOpen] = createSignal(false);
  const [query, setQuerySig] = createSignal("");
  const [sessionsCache, setSessionsCache] = createSignal<
    { name: string; state?: string }[] | null
  >(null);
  const [selIdx, setSelIdx] = createSignal(0);
  let openSeq = 0;

  const sessionItems = createMemo<PaletteItem[]>(() => {
    const c = sessionsCache();
    if (!c) return [];
    const cur = env.current();
    return recentsFirst(c, readVisitTimes()).map((s) => ({
      title: s.name,
      terms: [s.name],
      meta: s.name === cur ? "current" : s.state || "",
      run: () => env.attach(s.name),
    }));
  });

  const actionItems = createMemo<PaletteItem[]>(() =>
    env.actions().map((a) => ({
      title: a.label,
      terms: [a.label],
      meta: a.hint || "",
      danger: !!a.danger,
      keepFocus: !!a.keepFocus,
      run: a.run,
    })),
  );

  const groups = createMemo<PaletteGroup[]>(() =>
    buildGroups(query(), {
      sessionItems: sessionItems(),
      actionItems: actionItems(),
      sessionsLoaded: sessionsCache() !== null,
    }),
  );

  const rows = createMemo<PaletteRow[]>(() => {
    const out: PaletteRow[] = [];
    let idx = 0;
    for (const g of groups()) {
      out.push({ kind: "label", label: g.label });
      if (g.note) out.push({ kind: "note", note: g.note });
      for (const item of g.items) out.push({ kind: "item", item, index: idx++ });
    }
    // vanilla: nothing matched but sessions loaded -> "No matches".
    if (idx === 0 && sessionsCache() !== null) {
      out.push({ kind: "note", note: "No matches" });
    }
    return out;
  });

  const flatItems = createMemo<PaletteItem[]>(() =>
    rows()
      .filter((r): r is Extract<PaletteRow, { kind: "item" }> => r.kind === "item")
      .map((r) => r.item),
  );

  function setSel(i: number): void {
    const n = flatItems().length;
    setSelIdx(n === 0 ? 0 : Math.max(0, Math.min(i, n - 1)));
  }
  function moveSel(delta: number): void {
    setSel(selIdx() + delta);
  }
  function setQuery(q: string): void {
    setQuerySig(q);
    setSelIdx(0);
  }

  function open(): void {
    track("palette.opened");
    if (isOpen()) return;
    setQuerySig("");
    setSessionsCache(null);
    setSelIdx(0);
    setOpen(true);
    const seq = ++openSeq;
    Promise.resolve()
      .then(() => env.sessions())
      .then((list) => {
        if (seq !== openSeq || !isOpen()) return;
        setSessionsCache(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (seq !== openSeq || !isOpen()) return;
        setSessionsCache([]);
      });
  }
  function close(refocus = false): void {
    if (!isOpen()) return;
    openSeq++;
    setOpen(false);
    if (refocus) env.refocus();
  }
  function toggle(): void {
    if (isOpen()) close(true);
    else open();
  }

  function runItem(item: PaletteItem): void {
    // keepFocus items pick their own focus target (e.g. the new-session box);
    // everything else hands the keyboard back.
    close(!item.keepFocus);
    item.run?.();
  }
  function runSelected(): void {
    const it = flatItems()[selIdx()];
    if (it) runItem(it);
  }

  return {
    isOpen,
    open,
    close,
    toggle,
    query,
    setQuery,
    rows,
    flatItems,
    selIdx,
    setSel,
    moveSel,
    runItem,
    runSelected,
  };
}
