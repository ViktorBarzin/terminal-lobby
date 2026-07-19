import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

// @solidjs/testing-library does not auto-clean under vitest globals; do it here.
afterEach(() => cleanup());
