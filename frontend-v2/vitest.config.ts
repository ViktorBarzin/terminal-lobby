import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// Separate from vite.config.ts on purpose: the singlefile plugin's build
// rewrites must not run during tests, and Solid needs its dev/browser export
// conditions so `render()` uses the DOM runtime (not the SSR one).
export default defineConfig({
  plugins: [solid()],
  resolve: { conditions: ["development", "browser"] },
  define: { __TL_BUILD__: JSON.stringify("test") },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    isolate: false,
  },
});
