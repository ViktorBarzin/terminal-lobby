import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createToastController,
  SLOW_THRESHOLD_MS,
  MAX_TRACKED,
} from "../src/store/toast";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("toast stack — push/dismiss/auto-dismiss", () => {
  it("pushes a typed toast and auto-dismisses non-sticky ones", () => {
    const c = createToastController();
    const id = c.push({ kind: "info", message: "hello" });
    expect(c.toasts()).toHaveLength(1);
    expect(c.toasts()[0]?.kind).toBe("info");
    vi.advanceTimersByTime(3000);
    expect(c.toasts()).toHaveLength(0);
    // dismissing an already-gone id is a no-op
    c.dismiss(id);
    c.dispose();
  });

  it("keeps sticky (loading) toasts until dismissed", () => {
    const c = createToastController();
    const id = c.push({ kind: "loading", message: "working" });
    vi.advanceTimersByTime(60000);
    expect(c.toasts()).toHaveLength(1);
    c.dismiss(id);
    expect(c.toasts()).toHaveLength(0);
    c.dispose();
  });
});

describe("slow-request coordinator", () => {
  it("shows nothing before the threshold, one warning toast after", () => {
    const c = createToastController();
    const ack = c.track("GET /api/sessions");
    vi.advanceTimersByTime(SLOW_THRESHOLD_MS - 1);
    expect(c.toasts()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(c.toasts()).toHaveLength(1);
    const t = c.toasts()[0];
    expect(t?.kind).toBe("warning");
    expect(t?.message).toMatch(/slow/i);
    expect(t?.detail).toContain("GET /api/sessions");
    expect(t?.sticky).toBe(true);
    ack();
    expect(c.toasts()).toHaveLength(0);
    c.dispose();
  });

  it("a request that acks before the threshold never raises the toast", () => {
    const c = createToastController();
    const ack = c.track("GET /api/whoami");
    vi.advanceTimersByTime(5000);
    ack(); // fast enough
    vi.advanceTimersByTime(SLOW_THRESHOLD_MS);
    expect(c.toasts()).toHaveLength(0);
    c.dispose();
  });

  it("coalesces multiple slow requests into ONE self-updating toast", () => {
    const c = createToastController();
    const a = c.track("GET /api/sessions");
    const b = c.track("PUT /api/layout");
    vi.advanceTimersByTime(SLOW_THRESHOLD_MS);
    expect(c.toasts()).toHaveLength(1);
    const detail = c.toasts()[0]?.detail ?? "";
    expect(detail).toContain("GET /api/sessions");
    expect(detail).toContain("PUT /api/layout");
    // acking one leaves the shared toast (the other is still slow)
    a();
    expect(c.toasts()).toHaveLength(1);
    expect(c.toasts()[0]?.detail).not.toContain("GET /api/sessions");
    expect(c.toasts()[0]?.detail).toContain("PUT /api/layout");
    // acking the last closes it
    b();
    expect(c.toasts()).toHaveLength(0);
    c.dispose();
  });

  it("a failed request acks too (closes the slow toast)", () => {
    const c = createToastController();
    const ack = c.track("POST /prompt/x");
    vi.advanceTimersByTime(SLOW_THRESHOLD_MS);
    expect(c.toasts()).toHaveLength(1);
    ack(); // callers ack in a .catch as well as .then
    expect(c.toasts()).toHaveLength(0);
    c.dispose();
  });

  it("caps tracking at MAX_TRACKED without throwing", () => {
    const c = createToastController();
    const acks = [];
    for (let i = 0; i < MAX_TRACKED + 5; i++) acks.push(c.track(`GET /api/${i}`));
    vi.advanceTimersByTime(SLOW_THRESHOLD_MS);
    // still a single coalesced toast; the extra tracks were no-ops
    expect(c.toasts()).toHaveLength(1);
    for (const a of acks) a();
    expect(c.toasts()).toHaveLength(0);
    c.dispose();
  });
});
