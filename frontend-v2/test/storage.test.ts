import { describe, it, expect, afterEach } from "vitest";
import { localStorageOrNull, lsGet, lsSet, sessionStorageOrNull } from "../src/lib/storage";

const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const realSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

function restore(): void {
  if (real) Object.defineProperty(globalThis, "localStorage", real);
}

function restoreSession(): void {
  if (realSession) Object.defineProperty(globalThis, "sessionStorage", realSession);
}

describe("localStorageOrNull", () => {
  afterEach(restore);

  it("hands back the real localStorage when the browser has one", () => {
    expect(localStorageOrNull()).toBe(globalThis.localStorage);
  });

  it("is null when the getter throws, which is what a partitioned or blocked store does", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(localStorageOrNull()).toBeNull();
  });

  it("is null where there is no localStorage at all", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
    expect(localStorageOrNull()).toBeNull();
  });
});

/** The per-tab twin, used by the undo stack (store/undo.ts) for a history that
 *  survives a reload and dies with the tab. Same three cases, because the
 *  failure modes are the same ones: a sandboxed frame throws on the getter, and
 *  a non-browser runtime has no such global. */
describe("sessionStorageOrNull", () => {
  afterEach(restoreSession);

  it("hands back the real sessionStorage when the browser has one", () => {
    expect(sessionStorageOrNull()).toBe(globalThis.sessionStorage);
  });

  it("is null when the getter throws, which is what a sandboxed frame does", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(sessionStorageOrNull()).toBeNull();
  });

  it("is null where there is no sessionStorage at all", () => {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: undefined });
    expect(sessionStorageOrNull()).toBeNull();
  });
});

describe("lsGet / lsSet", () => {
  afterEach(() => {
    restore();
    globalThis.localStorage?.removeItem?.("tl:test:key");
  });

  it("round-trips a value", () => {
    lsSet("tl:test:key", "hello");
    expect(lsGet("tl:test:key")).toBe("hello");
  });

  it("returns null for a key nothing wrote, so each caller keeps its own default", () => {
    expect(lsGet("tl:test:key")).toBeNull();
  });

  it("removes the key when the value is null", () => {
    lsSet("tl:test:key", "hello");
    lsSet("tl:test:key", null);
    expect(globalThis.localStorage.getItem("tl:test:key")).toBeNull();
  });

  it("reads null when the localStorage getter throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(lsGet("tl:test:key")).toBeNull();
  });

  it("reads null where there is no localStorage at all", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
    expect(lsGet("tl:test:key")).toBeNull();
  });

  it("swallows a refused write, because a lost preference is not a crash", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem() {
          throw new DOMException("QuotaExceededError", "QuotaExceededError");
        },
        removeItem() {
          throw new DOMException("QuotaExceededError", "QuotaExceededError");
        },
      },
    });
    expect(() => lsSet("tl:test:key", "hello")).not.toThrow();
    expect(() => lsSet("tl:test:key", null)).not.toThrow();
  });

  it("is a no-op where there is no localStorage at all", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
    expect(() => lsSet("tl:test:key", "hello")).not.toThrow();
  });
});
