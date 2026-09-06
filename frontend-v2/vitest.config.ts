import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// Separate from vite.config.ts on purpose: the build's asset hashing and
// chunking must not run during tests, and Solid needs its dev/browser export
// conditions so `render()` uses the DOM runtime (not the SSR one).
export default defineConfig({
  plugins: [solid()],
  resolve: { conditions: ["development", "browser"] },
  // Allows Vite to serve files from the parent directory, where two siblings of
  // this package live: frontend/diag.js, imported for its side effects by three
  // diag tests, and slug/vectors.json, the shared CleanTitle cases that
  // test/title.test.ts and slug/slug_test.go both read so the Go and TypeScript
  // copies of that function cannot drift apart.
  //
  // The comment here used to name frontend/term.html as the only reason, which
  // would make this line look safe to delete with that page. It is not: no test
  // imports term.html today, and the slug fixture outlives the cutover.
  //
  // Measured 2026-09-06: both imports above still resolve with `allow: []`,
  // because vite-node transforms them rather than the dev server serving them.
  // Kept for the dev server and for any future `?raw` import of a sibling.
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
