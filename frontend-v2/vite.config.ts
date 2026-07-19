import { defineConfig, type ProxyOptions } from "vite";
import solid from "vite-plugin-solid";
import { viteSingleFile } from "vite-plugin-singlefile";
import type { ClientRequest } from "node:http";

// Build id — replaces the vanilla app's `__TL_BUILD__` sed (design §8: sed lacks
// `g` and breaks under minification, so we inject via Vite `define` instead).
// Read at runtime by the (future) stale-tab healer and for diagnostics.
const BUILD_ID = process.env.TL_BUILD || new Date().toISOString();

// Dev-proxy targets. In production the SPA is same-origin behind the ingress,
// which routes /events,/prompt,/cancel,/permission -> session-events and /api/*
// -> tmux-api (root). For local dev we reproduce both mappings so a real
// session-events + tmux-api on the box (or the dev-harness) is reachable
// without CORS. Override the origins with TL_SESSION_EVENTS / TL_TMUX_API.
const SESSION_EVENTS = process.env.TL_SESSION_EVENTS || "http://127.0.0.1:7685";
const TMUX_API = process.env.TL_TMUX_API || "http://127.0.0.1:7684";
// clipboard-upload (image store): the ingress routes /clipboard/* here stripping
// the prefix, so the dev proxy reproduces that mapping. Override with
// TL_CLIPBOARD_UPLOAD.
const CLIPBOARD_UPLOAD = process.env.TL_CLIPBOARD_UPLOAD || "http://127.0.0.1:7683";
// file-api (per-user file read/list/write): the ingress routes /files/* here
// WITHOUT stripping (its own routes already carry the /files prefix), so the dev
// proxy forwards verbatim. Override with TL_FILE_API.
const FILE_API = process.env.TL_FILE_API || "http://127.0.0.1:7686";
// Both backends resolve the OS user from the X-Authentik-Username header that
// the ingress injects in prod. For local dev, TL_DEV_AUTH lets the proxy stand
// in for the ingress so the dev server actually authenticates. Injected via the
// proxyReq hook (the static `headers` option is unreliable across versions).
const DEV_AUTH = process.env.TL_DEV_AUTH || "";
const injectAuth: ProxyOptions["configure"] = (proxy) => {
  if (!DEV_AUTH) return;
  proxy.on("proxyReq", (proxyReq: ClientRequest) => {
    proxyReq.setHeader("X-Authentik-Username", DEV_AUTH);
  });
};

// session-events lives at the root paths; each is proxied verbatim (no rewrite).
const sessionEventsProxy: ProxyOptions = {
  target: SESSION_EVENTS,
  changeOrigin: true,
  ws: false,
  configure: injectAuth,
};

// Shared by both `vite` (dev) and `vite preview` (serving the built dist), so a
// local build can be exercised end-to-end against the same backends.
const proxy: Record<string, ProxyOptions> = {
  "/events": sessionEventsProxy,
  "/prompt": sessionEventsProxy,
  "/cancel": sessionEventsProxy,
  "/permission": sessionEventsProxy,
  // tmux-api lobby data API: /api/* -> tmux-api root (strip the /api prefix).
  "/api": {
    target: TMUX_API,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api/, ""),
    configure: injectAuth,
  },
  // clipboard-upload image store: /clipboard/* -> service root (strip prefix).
  "/clipboard": {
    target: CLIPBOARD_UPLOAD,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/clipboard/, ""),
    configure: injectAuth,
  },
  // file-api: /files/* -> service verbatim (no rewrite; routes carry /files).
  "/files": {
    target: FILE_API,
    changeOrigin: true,
    ws: false,
    configure: injectAuth,
  },
};

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
  // Several CJS transitive deps of the markdown/mermaid chain (debug, extend,
  // …) trip Vite's dev ESM interop ("no default export") unless pre-bundled.
  // Force esbuild to optimize them so `npm run dev` renders. Dev-only; the
  // production single-file build already interops them correctly via Rollup.
  optimizeDeps: {
    include: ["debug", "extend"],
  },
  server: { proxy },
  preview: { proxy },
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
