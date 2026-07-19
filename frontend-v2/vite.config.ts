import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { viteSingleFile } from "vite-plugin-singlefile";

// Build id — replaces the vanilla app's `__TL_BUILD__` sed (design §8: sed lacks
// `g` and breaks under minification, so we inject via Vite `define` instead).
// Read at runtime by the (future) stale-tab healer and for diagnostics.
const BUILD_ID = process.env.TL_BUILD || new Date().toISOString();

export default defineConfig({
  plugins: [
    solid(),
    // Inlines ALL JS + CSS into one dist/index.html. `useRecommendedBuildConfig`
    // (default true) sets assetsInlineLimit=∞, cssCodeSplit=false and
    // inlineDynamicImports=true, and `deleteInlinedFiles` (default) removes the
    // emitted chunk/css files — so the build emits exactly ONE file.
    // `removeViteModuleLoader` strips the now-unused Vite preloader.
    viteSingleFile({ removeViteModuleLoader: true }),
  ],
  define: {
    __TL_BUILD__: JSON.stringify(BUILD_ID),
  },
  build: {
    target: "es2022",
    // xterm stays EXTERNAL per the deploy decision (design §2, decision #7):
    // it must never be bundled into the no-store single-file blob (that would
    // re-download xterm on every deploy/stale-heal). The terminal view is a
    // ttyd iframe today so nothing imports xterm — this is a guard-rail that
    // fails the build loud if a future xterm import tries to land in the bundle.
    rollupOptions: {
      external: [/^@xterm\//, /^xterm(\/|$)/],
    },
  },
});
