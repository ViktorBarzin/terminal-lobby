/**
 * Settings → T3 apps (ADR-0045, docs/plans/2026-10-21-t3-everywhere-design.md
 * decision 8): pair a T3 app with a link, a QR code and a short code that
 * counts down, and list and revoke the apps already paired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { T3AppsPage, type DevicesApi } from "../src/components/settings/pages/T3AppsPage";
import { SettingsPanel } from "../src/components/SettingsPanel";
import type { DeviceView } from "../src/lib/devices-api";
import { PREF_DEFAULTS, type Prefs, type PrefsStore } from "../src/store/prefs";

const ORIGIN = "https://t3.viktorbarzin.me";
const NOW = 1_800_000_000_000;

const phone: DeviceView = {
  id: "a1b2c3d4e5f60718",
  label: "Pixel 9",
  deviceType: "mobile",
  os: "android",
  created: 1_799_000_000,
  lastSeen: 0,
};
const laptop: DeviceView = {
  id: "0f1e2d3c4b5a6978",
  label: "T3 desktop",
  deviceType: "desktop",
  os: "linux",
  created: 1_798_000_000,
  lastSeen: 1_799_500_000,
};

function fakeApi(devices: DeviceView[] = []): DevicesApi & {
  pair: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
  /** A device using the code: tmux-api lists it from now on. */
  paired: (d: DeviceView) => void;
} {
  let held = [...devices];
  return {
    paired: (d) => {
      held = [d, ...held];
    },
    pair: vi.fn(async () => ({ code: "ABCDEFGHJKLM", expiresAt: NOW / 1000 + 300 })),
    list: vi.fn(async () => held),
    revoke: vi.fn(async (id: string) => {
      held = held.filter((d) => d.id !== id);
    }),
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const text = (c: HTMLElement) => c.textContent ?? "";
const button = (c: HTMLElement, name: string): HTMLButtonElement | null =>
  Array.from(c.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name,
  ) ?? null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Settings → T3 apps: pairing", () => {
  it("shows the link, a QR code of it, the grouped code and a countdown", async () => {
    const api = fakeApi();
    const { container } = render(() => <T3AppsPage origin={ORIGIN} api={api} />);
    await flush();
    fireEvent.click(button(container, "Pair a device")!);
    await flush();

    expect(api.pair).toHaveBeenCalledTimes(1);
    const link = container.querySelector<HTMLInputElement>('input[aria-label="Pairing link"]');
    expect(link?.value).toBe(`${ORIGIN}/pair#token=ABCDEFGHJKLM`);
    const qr = container.querySelector("svg.tl-t3-qr");
    expect(qr).toBeTruthy();
    expect(qr?.getAttribute("aria-label")).toContain("QR code");
    expect(qr?.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(text(container)).toContain("ABCD EFGH JKLM");
    expect(text(container)).toContain("5:00");

    await vi.advanceTimersByTimeAsync(1000);
    expect(text(container)).toContain("4:59");
  });

  it("offers a new code when this one expires", async () => {
    const api = fakeApi();
    const { container } = render(() => <T3AppsPage origin={ORIGIN} api={api} />);
    await flush();
    fireEvent.click(button(container, "Pair a device")!);
    await flush();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(container.querySelector('input[aria-label="Pairing link"]')).toBeNull();
    expect(container.querySelector("svg.tl-t3-qr")).toBeNull();
    expect(text(container)).toContain("expired");

    fireEvent.click(button(container, "New code")!);
    await flush();
    expect(api.pair).toHaveBeenCalledTimes(2);
    expect(container.querySelector('input[aria-label="Pairing link"]')).toBeTruthy();
  });

  it("shows a refusal inline and lets the person try again", async () => {
    const api = fakeApi();
    api.pair.mockRejectedValueOnce(
      new Error("too many pairing codes outstanding; wait for one to expire"),
    );
    const { container } = render(() => <T3AppsPage origin={ORIGIN} api={api} />);
    await flush();
    fireEvent.click(button(container, "Pair a device")!);
    await flush();

    expect(text(container)).toContain("too many pairing codes outstanding");
    fireEvent.click(button(container, "Pair a device")!);
    await flush();
    expect(container.querySelector('input[aria-label="Pairing link"]')).toBeTruthy();
  });

  it("shows the code and a note on a dev server with no T3 address", async () => {
    const api = fakeApi();
    const { container } = render(() => <T3AppsPage origin={null} api={api} />);
    await flush();
    fireEvent.click(button(container, "Pair a device")!);
    await flush();

    expect(text(container)).toContain("ABCD EFGH JKLM");
    expect(container.querySelector("svg.tl-t3-qr")).toBeNull();
    expect(container.querySelector('input[aria-label="Pairing link"]')).toBeNull();
    expect(text(container)).toContain("no T3 address");
  });

  it("explains where the link goes in T3", async () => {
    const { container } = render(() => <T3AppsPage origin={ORIGIN} api={fakeApi()} />);
    await flush();
    expect(text(container)).toContain("Settings → Connections → Add environment");
  });

  it("says a phone scans with T3's scanner, not the camera", async () => {
    const { container } = render(() => <T3AppsPage origin={ORIGIN} api={fakeApi()} />);
    await flush();
    expect(text(container)).toContain("scan with the scanner inside T3");
  });
});

describe("Settings → T3 apps: noticing the code was used", () => {
  const POLL = 3000;

  async function showCode(api: ReturnType<typeof fakeApi>) {
    const view = render(() => <T3AppsPage origin={ORIGIN} api={api} />);
    await flush();
    fireEvent.click(button(view.container, "Pair a device")!);
    await flush();
    expect(view.container.querySelector('input[aria-label="Pairing link"]')).toBeTruthy();
    return view;
  }

  it("clears the code, lists the new device and names it once it pairs", async () => {
    const api = fakeApi([laptop]);
    const { container } = await showCode(api);

    await vi.advanceTimersByTimeAsync(POLL);
    expect(container.querySelector('input[aria-label="Pairing link"]')).toBeTruthy();

    api.paired(phone);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(container.querySelector('input[aria-label="Pairing link"]')).toBeNull();
    expect(container.querySelector("svg.tl-t3-qr")).toBeNull();
    expect(text(container)).not.toContain("ABCD EFGH JKLM");
    expect(text(container)).toContain("Paired: Pixel 9");
    const rows = container.querySelectorAll(".tl-t3-device");
    expect(rows).toHaveLength(2);
    expect(text(rows[0] as HTMLElement)).toContain("Pixel 9");
    expect(button(container, "Pair a device")).toBeTruthy();

    const calls = api.list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * POLL);
    expect(api.list).toHaveBeenCalledTimes(calls);
  });

  it("polls every three seconds while the code shows, and stops when it expires", async () => {
    const api = fakeApi();
    await showCode(api);
    const before = api.list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL - 1);
    expect(api.list).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.list).toHaveBeenCalledTimes(before + 1);

    await vi.advanceTimersByTimeAsync(300_000);
    const atExpiry = api.list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * POLL);
    expect(api.list).toHaveBeenCalledTimes(atExpiry);
  });

  it("stops polling when the page unmounts", async () => {
    const api = fakeApi();
    const { unmount } = await showCode(api);
    await vi.advanceTimersByTimeAsync(POLL);
    unmount();
    const atUnmount = api.list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * POLL);
    expect(api.list).toHaveBeenCalledTimes(atUnmount);
  });

  it("does not poll while the tab is hidden, and resumes when it shows again", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    try {
      const api = fakeApi();
      await showCode(api);
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      const hidden = api.list.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10 * POLL);
      expect(api.list).toHaveBeenCalledTimes(hidden);

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(POLL);
      expect(api.list.mock.calls.length).toBeGreaterThan(hidden);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the code when a poll fails", async () => {
    const api = fakeApi();
    const { container } = await showCode(api);
    api.list.mockRejectedValueOnce(new Error("devices HTTP 502"));
    await vi.advanceTimersByTimeAsync(POLL);
    expect(container.querySelector('input[aria-label="Pairing link"]')).toBeTruthy();
    api.paired(phone);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(text(container)).toContain("Paired: Pixel 9");
  });
});

describe("Settings → T3 apps: paired devices", () => {
  it("lists each app with its kind, when it paired and when it was last used", async () => {
    const { container } = render(() => (
      <T3AppsPage origin={ORIGIN} api={fakeApi([phone, laptop])} />
    ));
    await flush();
    const rows = container.querySelectorAll(".tl-t3-device");
    expect(rows).toHaveLength(2);
    expect(text(rows[0] as HTMLElement)).toContain("Pixel 9");
    expect(text(rows[0] as HTMLElement)).toContain("mobile · android");
    expect(text(rows[0] as HTMLElement)).toContain("paired");
    expect(text(rows[0] as HTMLElement)).toContain("not used yet");
    expect(text(rows[1] as HTMLElement)).toContain("T3 desktop");
    expect(text(rows[1] as HTMLElement)).toContain("last used");
  });

  it("says so when nothing is paired", async () => {
    const { container } = render(() => <T3AppsPage origin={ORIGIN} api={fakeApi()} />);
    await flush();
    expect(text(container)).toContain("No T3 apps paired");
  });

  it("revokes after a confirm, then refreshes the list", async () => {
    const api = fakeApi([phone, laptop]);
    const confirm = vi.fn(() => true);
    const { container } = render(() => <T3AppsPage origin={ORIGIN} api={api} confirm={confirm} />);
    await flush();
    fireEvent.click(
      container.querySelector<HTMLButtonElement>('button[aria-label="Revoke Pixel 9"]')!,
    );
    await flush();

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Pixel 9"));
    expect(api.revoke).toHaveBeenCalledWith(phone.id);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll(".tl-t3-device")).toHaveLength(1);
  });

  it("does nothing when the confirm is declined", async () => {
    const api = fakeApi([phone]);
    const { container } = render(() => (
      <T3AppsPage origin={ORIGIN} api={api} confirm={() => false} />
    ));
    await flush();
    fireEvent.click(
      container.querySelector<HTMLButtonElement>('button[aria-label="Revoke Pixel 9"]')!,
    );
    await flush();
    expect(api.revoke).not.toHaveBeenCalled();
  });

  it("shows a failed revoke or list inline", async () => {
    const api = fakeApi([phone]);
    api.revoke.mockRejectedValueOnce(new Error("network down"));
    const { container } = render(() => (
      <T3AppsPage origin={ORIGIN} api={api} confirm={() => true} />
    ));
    await flush();
    fireEvent.click(
      container.querySelector<HTMLButtonElement>('button[aria-label="Revoke Pixel 9"]')!,
    );
    await flush();
    expect(text(container)).toContain("Could not revoke: network down");

    const failing = fakeApi();
    failing.list.mockRejectedValueOnce(new Error("devices HTTP 502"));
    const second = render(() => <T3AppsPage origin={ORIGIN} api={failing} />);
    await flush();
    expect(text(second.container)).toContain("devices HTTP 502");
  });
});

function fakePrefs(): PrefsStore {
  const [prefs] = createSignal<Prefs>(structuredClone(PREF_DEFAULTS));
  return { prefs, setPref() {}, setFontSize() {}, async bootSync() {}, dispose() {} };
}

describe("Settings → T3 apps: who sees the page", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is in the rail for a tab acting as its own user", () => {
    const { container } = render(() => (
      <SettingsPanel prefs={fakePrefs()} onClose={() => {}} initialPage="t3apps" t3Apps />
    ));
    expect(container.querySelector('[data-page="t3apps"]')?.textContent).toBe("T3 apps");
    expect(button(container, "Pair a device")).toBeTruthy();
  });

  it("is absent under act-as, where tmux-api refuses to pair", () => {
    const { container } = render(() => (
      <SettingsPanel prefs={fakePrefs()} onClose={() => {}} initialPage="t3apps" />
    ));
    expect(container.querySelector('[data-page="t3apps"]')).toBeNull();
    expect(button(container, "Pair a device")).toBeNull();
  });
});
