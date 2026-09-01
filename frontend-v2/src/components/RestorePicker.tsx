import {
  createMemo,
  createSignal,
  For,
  Show,
  type Accessor,
  type Component,
} from "solid-js";
import type { Snapshot, SnapshotList, SnapshotRow } from "../types/lobby";

/**
 * The restore picker (2026-08-14). Port of the vanilla lobby's
 * `openRestorePicker`, sharing its server-side row resolution so the two
 * surfaces cannot drift on rules like "this name is taken by a different
 * conversation, restore it alongside as name-1250".
 *
 * Restore used to POST immediately and recreate whatever the single live
 * manifest held. After a partial loss — the tmux server alive, the processes
 * inside sessions killed — the 5-minute save had already rewritten that
 * manifest with only the survivors, so one click brought back a fraction of
 * what was lost. tmux-persist now keeps a SERIES of snapshots, and this is how
 * you choose among them.
 *
 * It opens on the NEWEST snapshot: predictable, with no heuristic deciding for
 * you. The "vs live" column and the "last full" badge are what point at an
 * older one.
 */

export interface RestorePickerApi {
  listSnapshots(): Promise<SnapshotList>;
  getSnapshot(ts: string): Promise<SnapshotRow[]>;
  restoreSessions(sel: { snapshot: string; sessions: string[] }): Promise<void>;
}

export interface RestorePickerProps {
  api: RestorePickerApi;
  /** Home directory, so rows read as `~/code` rather than a wall of prefixes. */
  home?: string;
  onClose: () => void;
  onRestored?: (count: number) => void;
  onError?: (message: string) => void;
}

/** 20260814T125000 → a local time, with the date when it is not today. */
export function formatSnapshotTime(ts: string, now: Date = new Date()): string {
  const d = snapshotDate(ts);
  if (!d) return ts;
  const hhmm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString()
    ? hhmm
    : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hhmm}`;
}

export function snapshotDate(ts: string): Date | null {
  if (!/^[0-9]{8}T[0-9]{6}$/.test(ts)) return null;
  const d = new Date(
    Date.UTC(
      +ts.slice(0, 4),
      +ts.slice(4, 6) - 1,
      +ts.slice(6, 8),
      +ts.slice(9, 11),
      +ts.slice(11, 13),
      +ts.slice(13, 15),
    ),
  );
  return isNaN(d.getTime()) ? null : d;
}

export function formatAgo(ts: string, now: Date = new Date()): string {
  const d = snapshotDate(ts);
  if (!d) return "";
  const mins = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

export function shortCwd(cwd: string, home?: string): string {
  if (!cwd) return "";
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * A snapshot's rows split into what a restore would DO and what is already
 * running, each keeping its snapshot order.
 *
 * The list is alphabetical as it arrives, which is fine when a lot is missing
 * and unhelpful in the ordinary case: one session died, seventeen are fine, and
 * the one that matters sits wherever its name happens to fall. A session killed
 * deliberately counts as a change — it differs from what is live — so it stays
 * visible without scrolling, still unticked.
 */
export function orderRows(rows: SnapshotRow[]): {
  changed: SnapshotRow[];
  running: SnapshotRow[];
} {
  const changed: SnapshotRow[] = [];
  const running: SnapshotRow[] = [];
  for (const r of rows) (r.action === "skip" ? running : changed).push(r);
  return { changed, running };
}

/** The one-line explanation under a row. `warn` marks the two cases where a
 *  restore does something other than recreate the session under its own name. */
export function rowNote(row: SnapshotRow): { text: string; warn: boolean } {
  if (row.state === "live_same") return { text: "already running", warn: false };
  if (row.state === "live_other_conv") {
    return {
      text: `name is taken by a different conversation — restores as ${row.target}`,
      warn: true,
    };
  }
  if (row.state === "live_no_claude") {
    return { text: "still open, but Claude exited — resumes in place", warn: true };
  }
  if (row.killedAt) {
    const when = new Date(row.killedAt * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return { text: `you killed this at ${when}`, warn: false };
  }
  return { text: "", warn: false };
}

/** The warning shown before a large restore. Restoring is unpaced by design, so
 *  this is the one place that says so — and only when the box is already short
 *  on memory, which is exactly when a recovery can re-trigger the OOM it
 *  follows. Returns null when there is nothing worth saying, including when the
 *  server could not read the number (-1). */
export function memoryWarning(
  list: SnapshotList | null,
  selectedCount: number,
): string | null {
  if (!list || selectedCount <= 0) return null;
  const avail = list.memAvailableMb;
  if (avail <= 0 || avail >= 4096) return null;
  const per = list.perSessionMb || 550;
  const needGb = ((selectedCount * per) / 1024).toFixed(1);
  return (
    `${(avail / 1024).toFixed(1)} GiB available; ${selectedCount} ` +
    `session${selectedCount === 1 ? "" : "s"} need about ${needGb} GiB. ` +
    `They all start at once.`
  );
}

export const RestorePicker: Component<RestorePickerProps> = (props) => {
  const [list, setList] = createSignal<SnapshotList | null>(null);
  const [selectedTS, setSelectedTS] = createSignal("");
  const [rows, setRows] = createSignal<SnapshotRow[]>([]);
  const [checked, setChecked] = createSignal<Set<string>>(new Set());
  const [status, setStatus] = createSignal("Loading…");
  const [busy, setBusy] = createSignal(false);

  const snapshots: Accessor<Snapshot[]> = () => list()?.snapshots ?? [];
  const selectedCount = (): number => checked().size;
  // What a restore would do, above what is already running.
  const split = createMemo(() => orderRows(rows()));

  const showRows = (ts: string, got: SnapshotRow[]): void => {
    setSelectedTS(ts);
    setRows(got);
    setChecked(new Set(got.filter((r) => r.default).map((r) => r.name)));
    const missing = got.filter((r) => r.action !== "skip").length;
    setStatus(
      missing
        ? `${missing} of ${got.length} not running`
        : "Everything in this snapshot is already running",
    );
  };

  const loadRows = async (ts: string): Promise<void> => {
    setSelectedTS(ts);
    setRows([]);
    setChecked(new Set<string>());
    setStatus("Loading…");
    let got: SnapshotRow[];
    try {
      got = await props.api.getSnapshot(ts);
    } catch (e) {
      setStatus(`Could not load that snapshot: ${(e as Error).message}`);
      return;
    }
    showRows(ts, got);
  };

  void (async () => {
    try {
      const l = await props.api.listSnapshots();
      setList(l);
      const newest = l.snapshots[0];
      if (!newest) {
        setStatus("No session snapshots saved yet");
        return;
      }
      // The list arrives with the newest snapshot already resolved, so opening
      // the picker is one request rather than two that cannot overlap — the
      // second used to need the first's answer to know what to ask for. A
      // server that predates that still sends the list alone; then we ask.
      if (l.rows && l.newestTs === newest.ts) {
        showRows(newest.ts, l.rows);
        return;
      }
      await loadRows(newest.ts); // newest, per the design
    } catch (e) {
      setStatus(`Could not load snapshots: ${(e as Error).message}`);
    }
  })();

  const toggle = (name: string): void => {
    const next = new Set(checked());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setChecked(next);
  };

  const selectAll = (): void => {
    setChecked(new Set(rows().filter((r) => r.action !== "skip").map((r) => r.name)));
  };

  const restore = async (): Promise<void> => {
    const names = [...checked()];
    if (!names.length) return;
    setBusy(true);
    try {
      await props.api.restoreSessions({ snapshot: selectedTS(), sessions: names });
      props.onRestored?.(names.length);
      props.onClose();
    } catch (e) {
      props.onError?.(`Restore failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** One session row — identical markup in both parts of the list, so the
   *  divider is the only thing that tells them apart. The destination project
   *  is shown where a restore would act on it: for an already-running session
   *  the sidebar already answers that question. */
  const renderRow = (row: SnapshotRow) => {
    const note = rowNote(row);
    return (
      <label class="tl-restore-row" classList={{ "is-live": row.action === "skip" }}>
        <input
          type="checkbox"
          checked={checked().has(row.name)}
          disabled={row.action === "skip"}
          onChange={() => toggle(row.name)}
        />
        <span class="tl-restore-meta">
          <span class="tl-restore-name">{row.name}</span>
          <span class="tl-restore-where">
            <span class="tl-restore-cwd">{shortCwd(row.cwd, props.home)}</span>
            <Show when={row.action !== "skip" && row.project}>
              <span class="tl-restore-dest">→ {row.project}</span>
            </Show>
          </span>
          <Show when={note.text}>
            <span class="tl-restore-note" classList={{ "is-warn": note.warn }}>
              {note.text}
            </span>
          </Show>
        </span>
      </label>
    );
  };

  return (
    <div
      class="tl-cmdpalette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="tl-schelp tl-restore" role="dialog" aria-label="Restore from snapshot">
        <h2 class="tl-schelp-title">Restore from snapshot</h2>

        <div class="tl-restore-head">
          <span>SNAPSHOT</span>
          <span>SESSIONS</span>
          <span>VS LIVE</span>
        </div>

        <div class="tl-restore-snaps">
          <For each={snapshots()}>
            {(s) => (
              <button
                type="button"
                class="tl-restore-snap"
                classList={{ "is-active": s.ts === selectedTS() }}
                onClick={() => void loadRows(s.ts)}
              >
                <span>
                  {formatSnapshotTime(s.ts)}
                  <Show when={s.newest}> ({formatAgo(s.ts)})</Show>
                  <Show when={s.lastFull}>
                    <span class="tl-restore-badge">last full</span>
                  </Show>
                </span>
                <span>{s.count}</span>
                <span classList={{ "is-up": s.deltaVsLive > 0 }}>
                  {s.deltaVsLive > 0 ? `+${s.deltaVsLive}` : "—"}
                </span>
              </button>
            )}
          </For>
        </div>

        <Show when={rows().length > 0}>
          <div class="tl-restore-bulk">
            <button type="button" onClick={selectAll}>
              select all
            </button>
            <button type="button" onClick={() => setChecked(new Set<string>())}>
              select none
            </button>
          </div>
        </Show>

        <div class="tl-restore-rows tl-schelp-scroll">
          <For each={split().changed}>{renderRow}</For>
          <Show when={split().changed.length > 0 && split().running.length > 0}>
            <div class="tl-restore-divider">already running ({split().running.length})</div>
          </Show>
          <For each={split().running}>{renderRow}</For>
        </div>

        <Show when={memoryWarning(list(), selectedCount())}>
          {(msg) => <div class="tl-restore-mem">{msg()}</div>}
        </Show>

        <div class="tl-restore-status">{status()}</div>

        <div class="tl-restore-footer">
          <button type="button" class="tl-foot-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="tl-foot-btn tl-restore-go"
            disabled={busy() || selectedCount() === 0}
            onClick={() => void restore()}
          >
            {selectedCount() ? `Restore ${selectedCount()} selected` : "Restore"}
          </button>
        </div>
      </div>
    </div>
  );
};
