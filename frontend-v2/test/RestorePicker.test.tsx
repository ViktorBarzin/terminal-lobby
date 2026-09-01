import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor, screen } from "@solidjs/testing-library";
import {
  RestorePicker,
  formatAgo,
  formatSnapshotTime,
  memoryWarning,
  orderRows,
  rowNote,
  shortCwd,
  snapshotDate,
  type RestorePickerApi,
} from "../src/components/RestorePicker";
import type { SnapshotList, SnapshotRow } from "../src/types/lobby";

// The shape of the 2026-08-14 incident: nine sessions live, older snapshots
// holding progressively more of what memory pressure took.
const LIST: SnapshotList = {
  snapshots: [
    { ts: "20260814T130500", count: 9, newest: true, deltaVsLive: 0, lastFull: false },
    { ts: "20260814T130049", count: 10, newest: false, deltaVsLive: 1, lastFull: false },
    { ts: "20260814T125000", count: 18, newest: false, deltaVsLive: 9, lastFull: true },
  ],
  memAvailableMb: 1430,
  perSessionMb: 550,
};

const row = (over: Partial<SnapshotRow> & { name: string }): SnapshotRow => ({
  cwd: "/home/wizard/code",
  state: "missing",
  action: "new",
  target: over.name,
  default: true,
  ...over,
});

const ROWS: Record<string, SnapshotRow[]> = {
  "20260814T130500": [
    row({ name: "portal", state: "live_same", action: "skip", default: false }),
  ],
  "20260814T125000": [
    row({ name: "T3" }),
    row({
      name: "chesscom",
      state: "live_other_conv",
      action: "suffixed",
      target: "chesscom-1250",
    }),
    row({
      name: "tripit-casia",
      cwd: "/home/wizard/code/tripit",
      state: "live_no_claude",
      action: "in_place",
    }),
    row({ name: "Wrongmove", default: false, killedAt: 1786711920 }),
    row({ name: "portal", state: "live_same", action: "skip", default: false }),
  ],
  // The ordinary case: everything still running except one session, whose name
  // sorts last. Finding it must not mean reading past the nine that are fine.
  "20260814T130049": [
    row({ name: "matrix", state: "live_same", action: "skip", default: false }),
    row({ name: "portal", state: "live_same", action: "skip", default: false }),
    row({ name: "repowise", project: "code" }),
  ],
};

class FakeApi implements RestorePickerApi {
  restores: { snapshot: string; sessions: string[] }[] = [];
  failRestore = false;
  fetched: string[] = [];
  /** The server this fake speaks for. "one-call" sends the newest snapshot's
   *  rows with the list; "list-only" is a box that predates that. */
  list: SnapshotList = LIST;
  async listSnapshots() {
    return this.list;
  }
  async getSnapshot(ts: string) {
    this.fetched.push(ts);
    return ROWS[ts] ?? [];
  }
  async restoreSessions(sel: { snapshot: string; sessions: string[] }) {
    if (this.failRestore) throw new Error("boom");
    this.restores.push(sel);
  }
}

/** Click the nth version in the snapshot list. By position, not by label: the
 *  label is a locale-formatted time ("01:00 PM" under the test's en-US). */
const clickSnapshot = (container: HTMLElement, n: number): void => {
  const snaps = [...container.querySelectorAll<HTMLButtonElement>(".tl-restore-snap")];
  fireEvent.click(snaps[n]!);
};

const mount = (api: RestorePickerApi, over: Record<string, unknown> = {}) =>
  render(() => (
    <RestorePicker api={api} home="/home/wizard" onClose={() => {}} {...over} />
  ));

describe("restore picker — pure helpers", () => {
  it("parses a snapshot id as UTC", () => {
    const d = snapshotDate("20260814T125000");
    expect(d?.toISOString()).toBe("2026-08-14T12:50:00.000Z");
    expect(snapshotDate("nonsense")).toBeNull();
    expect(snapshotDate("20260814T12500")).toBeNull();
  });

  it("shows a bare time today and adds the date otherwise", () => {
    const sameDay = new Date(Date.UTC(2026, 7, 14, 20, 0, 0));
    expect(formatSnapshotTime("20260814T125000", sameDay)).not.toMatch(/Aug/);
    const later = new Date(Date.UTC(2026, 7, 20, 20, 0, 0));
    expect(formatSnapshotTime("20260814T125000", later)).toMatch(/Aug/);
  });

  it("describes age in the largest useful unit", () => {
    const base = new Date(Date.UTC(2026, 7, 14, 12, 50, 0));
    expect(formatAgo("20260814T125000", new Date(base.getTime() + 5 * 60000))).toBe("5m ago");
    expect(formatAgo("20260814T125000", new Date(base.getTime() + 3 * 3600_000))).toBe("3h ago");
    expect(formatAgo("20260814T125000", new Date(base.getTime() + 48 * 3600_000))).toBe("2d ago");
  });

  it("shortens paths under home only", () => {
    expect(shortCwd("/home/wizard/code", "/home/wizard")).toBe("~/code");
    expect(shortCwd("/srv/nfs", "/home/wizard")).toBe("/srv/nfs");
    expect(shortCwd("", "/home/wizard")).toBe("");
  });

  it("explains each row state, flagging the two that do something else", () => {
    expect(rowNote(row({ name: "a" })).text).toBe("");
    expect(rowNote(row({ name: "a", state: "live_same", action: "skip" })).text)
      .toBe("already running");

    const conflict = rowNote(
      row({ name: "chesscom", state: "live_other_conv", action: "suffixed", target: "chesscom-1250" }),
    );
    expect(conflict.text).toContain("chesscom-1250");
    expect(conflict.warn).toBe(true);

    const inPlace = rowNote(row({ name: "t", state: "live_no_claude", action: "in_place" }));
    expect(inPlace.text).toContain("resumes in place");
    expect(inPlace.warn).toBe(true);

    expect(rowNote(row({ name: "W", killedAt: 1786711920 })).text).toContain("you killed this at");
  });
});

describe("restore picker — diff first", () => {
  const rows = [
    row({ name: "matrix", state: "live_same", action: "skip", default: false }),
    row({ name: "repowise" }),
    row({ name: "portal", state: "live_same", action: "skip", default: false }),
    row({ name: "chesscom", state: "live_other_conv", action: "suffixed", target: "chesscom-1250" }),
  ];

  it("separates what a restore would do from what is already running", () => {
    const { changed, running } = orderRows(rows);
    expect(changed.map((r) => r.name)).toEqual(["repowise", "chesscom"]);
    expect(running.map((r) => r.name)).toEqual(["matrix", "portal"]);
  });

  // Snapshot order is the only order the server promises; the split must not
  // reshuffle within a part, or the list moves under the reader between visits.
  it("keeps snapshot order inside each part", () => {
    const { changed } = orderRows([...rows].reverse());
    expect(changed.map((r) => r.name)).toEqual(["chesscom", "repowise"]);
  });

  // A session you killed is a difference from what is live, so it belongs with
  // the changes — unticked, but visible without scrolling.
  it("counts a deliberately killed session as a change", () => {
    const { changed } = orderRows([row({ name: "Wrongmove", default: false, killedAt: 1786711920 })]);
    expect(changed.map((r) => r.name)).toEqual(["Wrongmove"]);
  });

  it("handles a snapshot that is all one kind", () => {
    expect(orderRows([]).changed).toEqual([]);
    const allLive = orderRows([row({ name: "a", state: "live_same", action: "skip" })]);
    expect(allLive.changed).toEqual([]);
    expect(allLive.running.map((r) => r.name)).toEqual(["a"]);
  });
});

describe("restore picker — the memory warning", () => {
  it("appears only when memory is short and something is selected", () => {
    expect(memoryWarning(LIST, 0)).toBeNull();
    expect(memoryWarning(LIST, 5)).toContain("1.4 GiB available");
    expect(memoryWarning(LIST, 5)).toContain("2.7 GiB");
    expect(memoryWarning({ ...LIST, memAvailableMb: 12000 }, 5)).toBeNull();
  });

  // -1 means the server could not read /proc/meminfo. Saying nothing is right;
  // implying there is room would be worse than staying quiet.
  it("stays silent when the number is unknown", () => {
    expect(memoryWarning({ ...LIST, memAvailableMb: -1 }, 5)).toBeNull();
  });

  it("says sessions start together, since the restore is unpaced by design", () => {
    expect(memoryWarning(LIST, 2)).toContain("all start at once");
  });
});

describe("restore picker — behaviour", () => {
  it("opens on the newest snapshot rather than guessing a better one", async () => {
    mount(new FakeApi());
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());
    // The 18-session version is offered and labelled, but not chosen for you.
    expect(screen.getByText("last full")).toBeTruthy();
    expect(screen.queryByText("T3")).toBeNull();
  });

  it("pre-ticks what is missing, and leaves live and killed sessions alone", async () => {
    const api = new FakeApi();
    const { container } = mount(api);
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());

    fireEvent.click(screen.getByText(/12:50/));
    await waitFor(() => expect(screen.getByText("T3")).toBeTruthy());

    const boxes = [...container.querySelectorAll<HTMLInputElement>(".tl-restore-row input")];
    const state = Object.fromEntries(
      boxes.map((b, i) => {
        const name = b.closest(".tl-restore-row")?.querySelector(".tl-restore-name")?.textContent;
        return [name ?? String(i), { checked: b.checked, disabled: b.disabled }];
      }),
    );
    expect(state["T3"]).toEqual({ checked: true, disabled: false });
    expect(state["chesscom"]).toEqual({ checked: true, disabled: false });
    expect(state["tripit-casia"]).toEqual({ checked: true, disabled: false });
    // Deliberately killed after this snapshot — offered, but not on by default.
    expect(state["Wrongmove"]).toEqual({ checked: false, disabled: false });
    // Already running — nothing to do, and not selectable.
    expect(state["portal"]).toEqual({ checked: false, disabled: true });
  });

  it("restores exactly the ticked rows of the chosen snapshot", async () => {
    const api = new FakeApi();
    let closed = false;
    const { container, getByText } = mount(api, { onClose: () => (closed = true) });
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());
    fireEvent.click(screen.getByText(/12:50/));
    await waitFor(() => expect(screen.getByText("T3")).toBeTruthy());

    // Tick the killed session back on — an accidental kill must stay one click
    // from coming back.
    const wrong = [...container.querySelectorAll<HTMLInputElement>(".tl-restore-row")]
      .find((r) => r.querySelector(".tl-restore-name")?.textContent === "Wrongmove")
      ?.querySelector("input");
    fireEvent.click(wrong!);

    fireEvent.click(getByText(/^Restore \d+ selected$/));
    await waitFor(() => expect(api.restores.length).toBe(1));

    expect(api.restores[0]!.snapshot).toBe("20260814T125000");
    expect(api.restores[0]!.sessions.sort()).toEqual(
      ["T3", "Wrongmove", "chesscom", "tripit-casia"].sort(),
    );
    expect(api.restores[0]!.sessions).not.toContain("portal");
    expect(closed).toBe(true);
  });

  it("cannot restore nothing", async () => {
    const api = new FakeApi();
    const { getByText, container } = mount(api);
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());
    // The newest snapshot is entirely live, so there is nothing to select.
    expect((getByText("Restore") as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector(".tl-restore-status")?.textContent)
      .toContain("already running");
  });

  it("select none clears, select all takes only what is restorable", async () => {
    const api = new FakeApi();
    const { container, getByText } = mount(api);
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());
    fireEvent.click(screen.getByText(/12:50/));
    await waitFor(() => expect(screen.getByText("T3")).toBeTruthy());

    fireEvent.click(getByText("select none"));
    await waitFor(() =>
      expect((getByText("Restore") as HTMLButtonElement).disabled).toBe(true),
    );

    fireEvent.click(getByText("select all"));
    await waitFor(() => expect(getByText(/^Restore 4 selected$/)).toBeTruthy());
    const checkedNames = [...container.querySelectorAll<HTMLInputElement>(".tl-restore-row input")]
      .filter((b) => b.checked)
      .map((b) => b.closest(".tl-restore-row")?.querySelector(".tl-restore-name")?.textContent);
    expect(checkedNames).not.toContain("portal");
  });

  it("reports a failed restore and stays open so the selection is not lost", async () => {
    const api = new FakeApi();
    api.failRestore = true;
    let closed = false;
    const errors: string[] = [];
    const { getByText } = mount(api, {
      onClose: () => (closed = true),
      onError: (m: string) => errors.push(m),
    });
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());
    fireEvent.click(screen.getByText(/12:50/));
    await waitFor(() => expect(screen.getByText("T3")).toBeTruthy());

    fireEvent.click(getByText(/^Restore \d+ selected$/));
    await waitFor(() => expect(errors.length).toBe(1));
    expect(errors[0]).toContain("Restore failed");
    expect(closed).toBe(false);
  });

  // The reason this ordering exists: a snapshot where one session died and the
  // rest are fine used to bury the missing one wherever its name sorted.
  it("shows what would be restored first, under a labelled divider", async () => {
    const api = new FakeApi();
    const { container } = mount(api);
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());

    clickSnapshot(container, 1); // 13:00 — one session short of what is live
    await waitFor(() => expect(screen.getByText("repowise")).toBeTruthy());

    const names = [...container.querySelectorAll(".tl-restore-row .tl-restore-name")].map(
      (n) => n.textContent,
    );
    expect(names[0]).toBe("repowise");
    expect(names).toEqual(["repowise", "matrix", "portal"]);
    expect(container.querySelector(".tl-restore-divider")?.textContent).toContain(
      "already running (2)",
    );
  });

  it("shows no divider when there is nothing to separate", async () => {
    const api = new FakeApi();
    const { container } = mount(api);
    // The newest snapshot is entirely live — one part, so no divider.
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());
    expect(container.querySelector(".tl-restore-divider")).toBeNull();
  });

  // Where a session lands is decided server-side; the picker shows it so a
  // restore is not a guess about which group it reappears in.
  it("names the project the restore would put a session in", async () => {
    const api = new FakeApi();
    const { container } = mount(api);
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());

    clickSnapshot(container, 1);
    await waitFor(() => expect(screen.getByText("repowise")).toBeTruthy());

    const dest = container.querySelector(".tl-restore-row .tl-restore-dest");
    expect(dest?.textContent).toContain("code");
    // Nothing invented for rows with no project.
    expect(container.querySelectorAll(".tl-restore-dest").length).toBe(1);
  });

  // Opening the picker is ONE request: the list arrives with the newest
  // snapshot already resolved. Asking twice meant two sudo/bash/tmux round
  // trips that could not overlap, since the second needed the first's answer.
  it("renders the newest snapshot from the list response, without a second call", async () => {
    const api = new FakeApi();
    api.list = {
      ...LIST,
      newestTs: "20260814T130500",
      rows: ROWS["20260814T130500"]!,
    };
    mount(api);
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());
    expect(api.fetched).toEqual([]);
  });

  // Switching to an older version is still a fetch — only the open is bundled.
  it("still fetches when you pick a different version", async () => {
    const api = new FakeApi();
    api.list = {
      ...LIST,
      newestTs: "20260814T130500",
      rows: ROWS["20260814T130500"]!,
    };
    const { container } = mount(api);
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());

    clickSnapshot(container, 2);
    await waitFor(() => expect(screen.getByText("chesscom")).toBeTruthy());
    expect(api.fetched).toEqual(["20260814T125000"]);
  });

  // A box whose tmux-persist predates the one-call open sends the list alone.
  it("asks for the rows when the list does not carry them", async () => {
    const api = new FakeApi();
    mount(api);
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());
    expect(api.fetched).toEqual(["20260814T130500"]);
  });

  // Rows for a snapshot that is no longer the newest are not the rows to show.
  it("ignores bundled rows that belong to another snapshot", async () => {
    const api = new FakeApi();
    api.list = { ...LIST, newestTs: "20260814T125000", rows: ROWS["20260814T125000"]! };
    mount(api);
    await waitFor(() => expect(screen.getByText("portal")).toBeTruthy());
    expect(api.fetched).toEqual(["20260814T130500"]);
  });

  it("says so when nothing has been snapshotted yet", async () => {
    const api = new FakeApi();
    api.listSnapshots = async () => ({ snapshots: [], memAvailableMb: -1, perSessionMb: 550 });
    const { container } = mount(api);
    await waitFor(() =>
      expect(container.querySelector(".tl-restore-status")?.textContent)
        .toContain("No session snapshots saved yet"),
    );
  });
});
