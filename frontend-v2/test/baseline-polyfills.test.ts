import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canParseURL,
  installBaselinePolyfills,
  makeTimeoutSignal,
} from "../src/lib/baseline-polyfills";

const nativeTimeout = AbortSignal.timeout;
const nativeCanParse = (URL as unknown as { canParse?: unknown }).canParse;

afterEach(() => {
  (AbortSignal as unknown as { timeout: unknown }).timeout = nativeTimeout;
  (URL as unknown as { canParse: unknown }).canParse = nativeCanParse;
  vi.useRealTimers();
});

describe("makeTimeoutSignal", () => {
  beforeEach(() => vi.useFakeTimers());

  it("does not abort before the deadline", () => {
    const s = makeTimeoutSignal(1000);
    vi.advanceTimersByTime(999);
    expect(s.aborted).toBe(false);
  });

  // lobby-api merges this signal with the caller's and forwards `reason`, and
  // the store tells a timeout apart from a cancel by its NAME. A plain
  // controller.abort() would report AbortError and quietly change that.
  it("aborts at the deadline with a TimeoutError, like the native one", () => {
    const s = makeTimeoutSignal(1000);
    vi.advanceTimersByTime(1000);
    expect(s.aborted).toBe(true);
    expect((s.reason as DOMException).name).toBe("TimeoutError");
  });
});

describe("canParseURL", () => {
  it("agrees with the URL constructor", () => {
    expect(canParseURL("https://example.com/x")).toBe(true);
    expect(canParseURL("/relative", "https://example.com")).toBe(true);
    expect(canParseURL("not a url")).toBe(false);
    expect(canParseURL("/relative")).toBe(false);
  });
});

describe("installBaselinePolyfills", () => {
  it("fills in what the engine is missing", () => {
    delete (AbortSignal as unknown as { timeout?: unknown }).timeout;
    delete (URL as unknown as { canParse?: unknown }).canParse;

    installBaselinePolyfills();

    expect(typeof AbortSignal.timeout).toBe("function");
    expect(typeof (URL as unknown as { canParse: unknown }).canParse).toBe("function");
    expect((URL as unknown as { canParse: (u: string) => boolean }).canParse("https://x.dev")).toBe(true);
  });

  it("leaves a real implementation alone", () => {
    const sentinel = () => new AbortController().signal;
    (AbortSignal as unknown as { timeout: unknown }).timeout = sentinel;
    installBaselinePolyfills();
    expect(AbortSignal.timeout).toBe(sentinel);
  });

  it("reports what it installed, so a device can be asked", () => {
    delete (AbortSignal as unknown as { timeout?: unknown }).timeout;
    expect(installBaselinePolyfills()).toContain("AbortSignal.timeout");
  });
});
