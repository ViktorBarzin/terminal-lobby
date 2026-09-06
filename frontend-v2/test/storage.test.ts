import { describe, it, expect, afterEach } from "vitest";
import { localStorageOrNull } from "../src/lib/storage";

const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function restore(): void {
  if (real) Object.defineProperty(globalThis, "localStorage", real);
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
