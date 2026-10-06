import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The public-link visitor page (docs/plans/2026-10-06-public-links-design.md),
// built on its own because it is served under /s/ to people who are not signed
// in, while the lobby's chunks live at /assets/ behind sign-in. `base: "/s/"`
// makes every chunk URL this page emits start with /s/assets/, which the
// ingress serves without sign-in (clipboard-upload's /assets/ handler, with the
// /s prefix stripped).
//
// Runs SECOND, into the same dist/, after the lobby build: emptyOutDir is off
// so the lobby's index.html and chunks survive, and chunk names are content
// hashes, so the two builds never write the same file with different bytes.
const BUILD_ID = process.env.TL_BUILD || "__TL_BUILD__";

export default defineConfig({
  plugins: [solid()],
  base: "/s/",
  define: {
    __TL_BUILD__: JSON.stringify(BUILD_ID),
  },
  build: {
    target: "safari15",
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: "link.html",
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
  },
});
