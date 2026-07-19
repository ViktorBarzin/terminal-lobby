import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// @solidjs/testing-library needs a DOM. The DOM-free integration test runs under
// `@vitest-environment node`, where importing/using its cleanup would throw — so
// only wire it up when a document exists.
if (typeof document !== "undefined") {
  afterEach(async () => {
    const { cleanup } = await import("@solidjs/testing-library");
    cleanup();
  });
}
