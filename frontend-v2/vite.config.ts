import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import solid from "vite-plugin-solid";
import { viteSingleFile } from "vite-plugin-singlefile";
import type { ClientRequest } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Build id — injected as the LITERAL placeholder, not a resolved value, so the
// built artifact is a pure function of the source (ADR-0007). deploy-v2.sh
// fingerprints that artifact to mint `__TL_ASSET__`, then substitutes both
// tokens; baking a git SHA or a timestamp in here would make every build unique
// and defeat the whole point. `define` (a preserved string literal) is what
// carries the placeholder safely through minification.
const BUILD_ID = process.env.TL_BUILD || "__TL_BUILD__";

// term.html — the ttyd terminal-mode page the SPA's iframe attaches against
// (config.TERMINAL_BASE = "/term.html"). It is deliberately NOT part of the
// Solid bundle: viteSingleFile inlines ONLY the SPA entry (index.html), and the
// terminal page pulls xterm from a CDN + speaks the ttyd binary WS protocol —
// wholly outside this app. term.html ships as its OWN static dist asset (like
// public/sw.js) so the iframe never recursively loads the SPA. Its canonical
// source lives beside the vanilla page it derives from (../frontend/term.html);
// this plugin copies it into dist/ on `vite build` and stamps the build id the
// same way the SPA does (define __TL_BUILD__), keeping the two artifacts in sync.
const TERM_HTML_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../frontend/term.html",
);
function copyTermHtml(): Plugin {
  return {
    name: "tl-copy-term-html",
    apply: "build",
    writeBundle(options) {
      const outDir =
        options.dir ?? resolve(dirname(fileURLToPath(import.meta.url)), "dist");
      let html: string;
      try {
        html = readFileSync(TERM_HTML_SRC, "utf8");
      } catch {
        this.error(
          `term.html not found at ${TERM_HTML_SRC} — the terminal iframe page must ship as a dist asset`,
        );
        return;
      }
      writeFileSync(join(outDir, "term.html"), html.replace(/__TL_BUILD__/g, BUILD_ID));
    },
  };
}

// Dev-proxy targets. In production the SPA is same-origin behind the ingress,
// which routes /events,/prompt,/cancel -> session-events and
// /api/sessions/* -> tmux-api (stripping the whole prefix). For local dev we
// reproduce both mappings so a real session-events + tmux-api on the box (or the
// dev-harness) is reachable without CORS. Override the origins with
// TL_SESSION_EVENTS / TL_TMUX_API.
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
// ttyd (the terminal attach): the terminal-mode page (term.html, the iframe)
// opens /ws (WebSocket) + /token same-origin, and in prod the ingress routes
// "everything else" -> ttyd (:7681). The dev proxy reproduces that so `vite
// preview` is a COMPLETE same-origin harness — SPA at /, term.html at /term.html,
// and a live terminal — which the postMessage bridge REQUIRES (it rejects any
// cross-origin frame). Override with TL_TTYD (e.g. a scratch dev-harness ttyd).
const TTYD = process.env.TL_TTYD || "http://127.0.0.1:7681";
// Both backends resolve the OS user from the X-Authentik-Username header that
// the ingress injects in prod. For local dev, TL_DEV_AUTH lets the proxy stand
// in for the ingress so the dev server actually authenticates. Injected via the
// proxyReq hook (the static `headers` option is unreliable across versions).
const DEV_AUTH = process.env.TL_DEV_AUTH || "";
const injectAuth: ProxyOptions["configure"] = (proxy) => {
  if (!DEV_AUTH) return;
  const setHeader = (proxyReq: ClientRequest) => {
    proxyReq.setHeader("X-Authentik-Username", DEV_AUTH);
  };
  proxy.on("proxyReq", setHeader);
  // WebSocket upgrades (the ttyd /ws attach) fire proxyReqWs, NOT proxyReq — the
  // header must be injected on both or ttyd's -H auth sees no user and the
  // terminal fails to attach.
  proxy.on("proxyReqWs", setHeader);
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
  // No /permission entry: 575d4f5 removed the web-mediated permission broker
  // from session-events, so proxying it here would forward local dev to a 404
  // the prod ingress does not even route. This list mirrors the routes the
  // service registers (session-events/main.go).
  // tmux-api lobby data API: /api/sessions/* -> tmux-api root (strip the whole
  // /api/sessions prefix, mirroring the PROD ingress `PathPrefix /api/sessions/`).
  // Covers whoami/sessions/layout/dirs/prefs/projects/users/shares AND Web Push
  // (/api/sessions/push*, spelled out verbatim in pwa/push.ts) — all hit tmux-api
  // at its root.
  "/api/sessions": {
    target: TMUX_API,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api\/sessions/, ""),
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
  // ttyd terminal attach — lets `vite preview` browser-verify TERMINAL mode.
  // term.html opens these same-origin; the ingress maps them to ttyd in prod.
  // /ws is the ttyd WebSocket (ws:true); /token is its pre-attach token fetch.
  "/ws": {
    target: TTYD,
    changeOrigin: true,
    ws: true,
    configure: injectAuth,
  },
  "/token": {
    target: TTYD,
    changeOrigin: true,
    ws: false,
    configure: injectAuth,
  },
  // Webfonts: clipboard-upload serves /fonts/*.woff2 in prod (deploy.sh), and
  // term.html's @font-face sources them. Verbatim (no strip), no auth needed.
  "/fonts": {
    target: CLIPBOARD_UPLOAD,
    changeOrigin: true,
    ws: false,
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
    // Emit dist/term.html (the terminal iframe page) as a separate static asset,
    // after viteSingleFile has finished with the SPA entry.
    copyTermHtml(),
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
    // The floor is bob's iPad — iPadOS 15.8, a Safari 15.6-era WebKit the device
    // cannot be upgraded past, and the same engine scripts/vendor-xterm.py pins
    // as its BASELINE. This is not a style preference: viteSingleFile inlines the
    // whole bundle into ONE script, so a single construct the engine cannot parse
    // is a SyntaxError that takes the entire lobby down rather than degrading one
    // feature. At "es2022" the shipped bundle carried 270 class static blocks, and
    // that iPad rendered a blank page — tab title, nothing else, and no telemetry,
    // since a page that cannot parse cannot report that it could not — from the
    // 2026-08-16 SPA promotion until 2026-08-18.
    // Guarded by scripts/test_frontend_compat.py, which scripts/deploy-v2.sh runs.
    target: "safari15",
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
