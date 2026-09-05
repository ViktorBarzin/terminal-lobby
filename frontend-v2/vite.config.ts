import { defineConfig, type ProxyOptions } from "vite";
import solid from "vite-plugin-solid";
import type { ClientRequest } from "node:http";

// Build id — injected as the LITERAL placeholder, not a resolved value, so the
// built artifact is a pure function of the source (ADR-0007). release/tl-stamp
// fingerprints that artifact to mint `__TL_ASSET__`, then substitutes both
// tokens; baking a git SHA or a timestamp in here would make every build unique
// and defeat the whole point. `define` (a preserved string literal) is what
// carries the placeholder safely through minification.
const BUILD_ID = process.env.TL_BUILD || "__TL_BUILD__";

// A second HTML artifact used to be emitted here. `frontend/term.html` was the
// terminal-mode page the SPA framed, copied into dist/ by a `writeBundle` plugin
// and stamped with the same build id. The lobby draws its own terminal now, so
// this build has one entry and one output document (2026-09-05).

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
// skills-api (the skill manager): /skills/* verbatim, same shape as /files.
// Override with TL_SKILLS_API.
const SKILLS_API = process.env.TL_SKILLS_API || "http://127.0.0.1:7688";
// ttyd (the terminal attach): the terminal opens /ws (WebSocket) + /token
// same-origin (terminal/wire.ts), and in prod the ingress routes "everything
// else" -> ttyd (:7681). The dev proxy reproduces that so `vite dev` and `vite
// preview` are a COMPLETE same-origin harness — the SPA at / with a live
// terminal in it. Override with TL_TTYD (e.g. a scratch dev-harness ttyd).
const TTYD = process.env.TL_TTYD || "http://127.0.0.1:7681";
// Both backends resolve the OS user from the X-Authentik-Username header that
// the ingress injects in prod. For local dev, TL_DEV_AUTH lets the proxy stand
// in for the ingress so the dev server actually authenticates. Injected via the
// proxyReq hook (the static `headers` option is unreliable across versions).
const DEV_AUTH = process.env.TL_DEV_AUTH || "";
// WHICH header carries the identity is configuration on the box as of
// 2026-08-29 (`TL_AUTH_HEADER` in /etc/terminal-lobby.conf, default
// X-Forwarded-User), so the dev proxy reads the same variable rather than
// assuming Authentik. Hardcoding the Authentik name left `vite` authenticating
// against nothing on a box configured for any other proxy, and the default here
// keeps every existing invocation working.
const DEV_AUTH_HEADER = process.env.TL_AUTH_HEADER || "X-Authentik-Username";
const injectAuth: ProxyOptions["configure"] = (proxy) => {
  if (!DEV_AUTH) return;
  const setHeader = (proxyReq: ClientRequest) => {
    proxyReq.setHeader(DEV_AUTH_HEADER, DEV_AUTH);
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
  // The list is the prod ingress's, prefix for prefix: the ten PathPrefix rules
  // on the session-events IngressRoute (infra/stacks/terminal/main.tf). Any
  // prefix missing here falls through to ttyd's `location /`, which answers 200
  // with the SPA's own index.html — so `res.json()` throws, the caller's catch
  // returns its empty fallback, and the feature is quietly absent rather than
  // broken. Measured 2026-09-04 with only the first three present: GET
  // /commands/<session> returned 9,406 bytes of text/html, the `/` menu fell
  // back to the 95 built-ins the page ships, and none of this user's 34 skills
  // were offered. Nothing logged.
  //
  // No /permission entry: 575d4f5 removed the web-mediated permission broker
  // from session-events, so proxying it here would forward local dev to a 404
  // the prod ingress does not even route. /hooks/* is loopback-only and
  // deliberately absent from the ingress too.
  "/events": sessionEventsProxy,
  "/prompt": sessionEventsProxy,
  "/cancel": sessionEventsProxy,
  "/earlier": sessionEventsProxy,
  "/result": sessionEventsProxy,
  "/pane": sessionEventsProxy,
  "/keys": sessionEventsProxy,
  "/commands": sessionEventsProxy,
  "/search": sessionEventsProxy,
  "/answer-text": sessionEventsProxy,
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
  // skills-api: /skills/* -> service verbatim (its routes carry /skills).
  "/skills": {
    target: SKILLS_API,
    changeOrigin: true,
    ws: false,
    configure: injectAuth,
  },
  // ttyd terminal attach — lets `vite preview` browser-verify TERMINAL mode.
  // terminal/wire.ts opens these same-origin; the ingress maps them to ttyd in
  // prod. /ws is the ttyd WebSocket (ws:true); /token its pre-attach token
  // fetch. Both carry the positional ?arg= list (lib/terminal-url.ts), which is
  // where `ttyd -a` maps them to $1..$5.
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
  // Webfonts: clipboard-upload serves /fonts/*.woff2 in prod, and the SPA's own
  // @font-face rules source them (src/theme/theme.css — JetBrains Mono, DM Sans
  // and TL Symbols). Verbatim (no strip), no auth needed.
  "/fonts": {
    target: CLIPBOARD_UPLOAD,
    changeOrigin: true,
    ws: false,
  },
};

export default defineConfig({
  plugins: [
    solid(),
    // NO viteSingleFile. It inlined every chunk into one dist/index.html, which
    // is how the lobby became a 4,744,477-byte document whose mount point sits
    // at byte 4,740,657 — 99.92% in, so first paint landed 0.07 s AFTER the last
    // byte (measured under throttling: 24.5 s). It also silently defeated the
    // lazy loading this app already had: mermaid (3,565,102 B of source),
    // CodeMirror with nine language packs and highlight.js are all behind
    // `await import(...)` at their use sites, and inlineDynamicImports pulled
    // every one of them into the initial payload anyway.
    //
    // Hashed chunks under /assets/ instead, served `immutable` by
    // clipboard-upload (the terminal stack routes that path), so a repeat visit
    // revalidates nothing and the heavy libraries are fetched only by the
    // features that use them.
    //
  ],
  define: {
    __TL_BUILD__: JSON.stringify(BUILD_ID),
  },
  // Several CJS transitive deps of the markdown/mermaid chain (debug, extend,
  // …) trip Vite's dev ESM interop ("no default export") unless pre-bundled.
  // Force esbuild to optimize them so `npm run dev` renders. Dev-only; the
  // production build interops them correctly via Rollup.
  optimizeDeps: {
    include: ["debug", "extend"],
  },
  server: { proxy },
  preview: { proxy },
  build: {
    // The floor is bob's iPad — iPadOS 15.8, a Safari 15.6-era WebKit the device
    // cannot be upgraded past, and the same engine scripts/test_frontend_compat.py
    // pins as its BASELINE. This is not a style preference: viteSingleFile inlines the
    // whole bundle into ONE script, so a single construct the engine cannot parse
    // is a SyntaxError that takes the entire lobby down rather than degrading one
    // feature. At "es2022" the shipped bundle carried 270 class static blocks, and
    // that iPad rendered a blank page — tab title, nothing else, and no telemetry,
    // since a page that cannot parse cannot report that it could not — from the
    // 2026-08-16 SPA promotion until 2026-08-18.
    // Guarded by scripts/test_frontend_compat.py, which packaging/build-deb.sh
    // runs over the staged bytes. It used to name scripts/deploy-v2.sh, which
    // was removed with the dev tier on 2026-08-16, so the guard read as
    // unattended for as long as the citation stood.
    target: "safari15",
    // xterm USED to be external here, on the deploy decision that it must never
    // land in the no-store single-file blob — every deploy would have
    // re-downloaded it. That build shape is gone: viteSingleFile was removed
    // (see the plugins note above) and the lobby now ships as an HTML shell plus
    // content-hashed chunks that clipboard-upload answers `immutable`
    // (clipboard-upload/main.go handleHashedAsset, whose own comment cites this
    // as what stopped the terminal page costing ~474 KB after every deploy).
    //
    // So a lazily-imported xterm is one more immutable chunk that only changes
    // when xterm changes. Measured before removing the guard: 330 KB (83 KB
    // gzipped) in its own chunk, against 946 KB hand-vendored into the terminal
    // page it replaced — and esbuild's safari15 and esnext output for that chunk
    // are byte identical, so nothing needs lowering for the iPadOS 15.8 floor.
    // The npm ESM build has none of the class static blocks that made the CDN's
    // CJS build unparseable there, which is what the hand-vendoring existed to
    // fix. The version is pinned in package.json and resolved from the committed
    // package-lock.json, and scripts/test_frontend_compat.py is what still asks
    // the floor question of the bytes we actually ship.
    rollupOptions: {
      output: {
        // One flat directory of content-hashed names: that is exactly what
        // clipboard-upload's /assets/ handler accepts (a single segment, no
        // separators, so there is nothing to traverse with) and what lets every
        // name be answered `immutable`.
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
  },
});
