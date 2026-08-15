import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor, screen } from "@solidjs/testing-library";
import {
  RestorePicker,
  formatAgo,
  formatSnapshotTime,
  memoryWarning,
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
};

class FakeApi implements RestorePickerApi {
  restores: { snapshot: string; sessions: string[] }[] = [];
  failRestore = false;
  async listSnapshots() {
    return LIST;
  }
  async getSnapshot(ts: string) {
    return ROWS[ts] ?? [];
  }
  async restoreSessions(sel: { snapshot: string; sessions: string[] }) {
    if (this.failRestore) throw new Error("boom");
    this.restores.push(sel);
  }
}

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
