import { createSignal, type Accessor } from "solid-js";
import type { LobbyStore } from "./lobby";
import type { DockState } from "../types/lobby";
import {
  clampRatio,
  DOCK_RATIO_DEFAULT,
  DOCK_RATIO_KEY,
  nextDockAction,
} from "./dock.logic";

/**
 * The Ctrl/Cmd+J scratch-shell dock.
 *
 * State lives in the roamed layout (`layout.dock`), which tmux-api already
 * carries and v2 already round-trips — so a dock opened on the laptop is still
 * there on the desktop. Only the split RATIO is per-browser: screens differ.
 */
export interface DockStore {
  /** the docked session, or null when nothing is docked. */
  session: Accessor<string | null>;
  /** docked AND showing (a hidden dock keeps its shell running). */
  visible: Accessor<boolean>;
  /** true the first time this dock is shown — the attach is what creates the
   *  tmux session, so the terminal must not wait to be asked. */
  creating: Accessor<boolean>;
  /** dock height as a % of the content area. */
  ratio: Accessor<number>;
  setRatio: (pct: number) => void;
  /** Ctrl+J: create → hide → show. */
  toggle: () => Promise<void>;
  /** ✕: un-dock. The shell keeps running and returns as an ordinary card. */
  undock: () => Promise<void>;
}

export interface DockStoreOptions {
  store: LobbyStore;
  /** injectable for tests; defaults to localStorage. */
  readRatio?: () => number;
  writeRatio?: (pct: number) => void;
}

// No telemetry here on purpose: the event catalog is a closed union mirroring
// the Go one in tmux-api, so a dock event would mean widening a SHARED-tier
// contract for a nice-to-have. Add it there first if the dock ever needs
// measuring.
export function createDockStore(opts: DockStoreOptions): DockStore {
  const { store } = opts;
  const readRatio =
    opts.readRatio ??
    (() => {
      try {
        return clampRatio(Number(localStorage.getItem(DOCK_RATIO_KEY)));
      } catch {
        return DOCK_RATIO_DEFAULT;
      }
    });
  const writeRatio =
    opts.writeRatio ??
    ((pct: number) => {
      try {
        localStorage.setItem(DOCK_RATIO_KEY, String(pct));
      } catch {
        /* private mode */
      }
    });

  const [ratio, setRatioSig] = createSignal(readRatio());
  // Set while a freshly-created dock has not yet attached: the tmux session is
  // born BY that attach, so this one may not wait for the view to be asked for.
  const [creating, setCreating] = createSignal(false);

  const dock = (): DockState | undefined => store.layout().dock;
  const session = () => dock()?.session ?? null;
  const visible = () => !!dock()?.visible;

  const setRatio = (pct: number): void => {
    const v = clampRatio(pct);
    setRatioSig(v);
    writeRatio(v);
  };

  async function toggle(): Promise<void> {
    const action = nextDockAction(store.layout(), store.sessions.map((s) => s.name));
    if (action.kind === "create") {
      setCreating(true);
      // The dock's dir follows the session you are working in, so a shell opened
      // under a project starts in that project (vanilla parity).
      const dir = store.layout().projects.find((p) =>
        p.sessions.includes(store.selected()?.name ?? ""),
      )?.dir;
      await store.setDock({ session: action.name, visible: true, ...(dir ? { dir } : {}) });
      return;
    }
    const d = dock()!;
    if (action.kind === "hide") {
      await store.setDock({ ...d, visible: false });
      return;
    }
    await store.setDock({ ...d, visible: true });
  }

  async function undock(): Promise<void> {
    const d = dock();
    if (!d) return;
    setCreating(false);
    // Clearing layout.dock is the whole un-dock: the shell keeps running and
    // the sidebar stops hiding it, so it reappears as an ordinary card.
    await store.setDock(undefined);
  }

  return { session, visible, creating, ratio, setRatio, toggle, undock };
}
