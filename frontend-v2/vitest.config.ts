import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// Separate from vite.config.ts on purpose: the singlefile plugin's build
// rewrites must not run during tests, and Solid needs its dev/browser export
// conditions so `render()` uses the DOM runtime (not the SSR one).
export default defineConfig({
  plugins: [solid()],
  resolve: { conditions: ["development", "browser"] },
  // frontend/term.html lives one level up, outside this package. Tests that
  // assert against the shipped page import it with `?raw`, and Vite refuses to
  // read outside the project root unless the sibling is allowed here.
  server: { fs: { allow: [".."] } },
  define: { __TL_BUILD__: JSON.stringify("test") },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    // Isolated per file. It was false, and that made the suite
    // order-dependent: SoftKeys.height stubs HTMLElement.prototype.offsetHeight
    // and the setup file installs a PointerEvent shim, both of which are shared
    // state under a shared environment — whole files failed together depending
    // on which other files ran alongside them (measured: 4 failures in roughly
    // one run in three, moving between SoftKeys.height and Composer.keyboard
    // with no source change). A suite that reports a different answer each run
    // cannot be evidence for anything.
    isolate: true,
  },
});
