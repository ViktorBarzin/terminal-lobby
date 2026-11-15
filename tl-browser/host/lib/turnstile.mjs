// Cloudflare Turnstile: the "Verify you are human" checkbox, both the widget
// on a site's own form and the full-page "Just a moment..." check. The host
// watches every page and presses the checkbox itself, so the agent never has
// to. Measured 2026-11-15 on this box against turnstile-lab.viktorbarzin.me:
//
// - headless Chrome fails with error 600010 whatever we press, so this works
//   only because the host now runs Chrome headed (display.mjs);
// - Playwright's --enable-automation (navigator.webdriver = true) also fails,
//   so the host drops it (chromeLaunchOptions);
// - a mouse click on the checkbox passed 1 of 2 runs; focusing it and pressing
//   Space passed every run.
//
// The checkbox sits in a closed shadow root inside a cross-origin frame, out
// of reach of page scripts and Playwright selectors. DOM.getDocument with
// pierce: true on the frame's own CDP session reaches it, and DOM.focus moves
// focus there before the key press.

/**
 * @typedef {import("playwright-core").BrowserContext} BrowserContext
 * @typedef {import("playwright-core").Page} Page
 * @typedef {import("playwright-core").Frame} Frame
 * @typedef {{ nodeName?: string, backendNodeId?: number, attributes?: string[],
 *   children?: DomNode[], shadowRoots?: DomNode[], contentDocument?: DomNode }} DomNode
 * @typedef {'solved' | 'passed' | 'unsolved' | 'no-checkbox' | 'gone'} SolveResult
 * @typedef {{
 *   findBox: () => Promise<number | null>,
 *   isDetached: () => boolean,
 *   hasToken: () => Promise<boolean>,
 *   press: (box: number) => Promise<void>,
 *   wait: (ms: number) => Promise<void>,
 *   mainNavigations?: () => number,
 *   pollMs?: number,
 *   timeoutMs?: number,
 *   settleMs?: number,
 * }} SolveDeps
 */

/**
 * @param {string | undefined} url
 * @returns {boolean}
 */
export function isTurnstileFrameURL(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "challenges.cloudflare.com";
  } catch {
    return false;
  }
}

/**
 * @param {DomNode | undefined} node a DOM.getDocument tree, pierced
 * @returns {number | null} the checkbox's backendNodeId
 */
export function findCheckbox(node) {
  if (!node) return null;
  if (node.nodeName === "INPUT") {
    const a = node.attributes ?? [];
    for (let i = 0; i + 1 < a.length; i += 2) {
      if (a[i] === "type" && a[i + 1] === "checkbox" && node.backendNodeId) return node.backendNodeId;
    }
  }
  const next = [
    ...(node.children ?? []),
    ...(node.shadowRoots ?? []),
    ...(node.contentDocument ? [node.contentDocument] : []),
  ];
  for (const child of next) {
    const hit = findCheckbox(child);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Solves one challenge frame. Returns:
 *   solved       pressed, then a token came or the page loaded anew (the
 *                full-page check reloads into the site once it passes);
 *   passed       a token came with no checkbox shown;
 *   unsolved     pressed, no token within settleMs (the site wants a person);
 *   gone         the frame went away with no token and no new page load: a
 *                widget that failed re-renders in a new frame, or the agent
 *                navigated away;
 *   no-checkbox  neither a checkbox nor a token within timeoutMs.
 * @param {SolveDeps} d
 * @returns {Promise<SolveResult>}
 */
export async function solveFrame(d) {
  const pollMs = d.pollMs ?? 500;
  const timeoutMs = d.timeoutMs ?? 30_000;
  const settleMs = d.settleMs ?? 15_000;

  const navigations = d.mainNavigations ?? (() => 0);
  const gone = async () => ((await d.hasToken()) ? "passed" : "gone");

  const deadline = Date.now() + timeoutMs;
  /** @type {number | null} */
  let box = null;
  for (;;) {
    if (d.isDetached()) return gone();
    box = await d.findBox();
    if (box !== null) break;
    if (await d.hasToken()) return "passed";
    if (Date.now() >= deadline) return "no-checkbox";
    await d.wait(pollMs);
  }

  // A short human-sized pause between the checkbox showing and the press.
  await d.wait(300 + Math.floor(Math.random() * 500));
  const before = navigations();
  await d.press(box);

  const until = Date.now() + settleMs;
  for (;;) {
    if (await d.hasToken()) return "solved";
    if (d.isDetached()) return navigations() > before ? "solved" : "gone";
    if (Date.now() >= until) return "unsolved";
    await d.wait(pollMs);
  }
}

/**
 * The real dependencies for a frame: its own CDP session for the pierced DOM,
 * and the page's keyboard for the press.
 * @param {BrowserContext} context
 * @param {Frame} frame
 * @returns {SolveDeps}
 */
function cdpDeps(context, frame) {
  const page = frame.page();
  /** @type {Promise<import("playwright-core").CDPSession> | undefined} */
  let session;
  let navigations = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigations++;
  });
  const cdp = () => {
    session ??= context.newCDPSession(frame);
    return session;
  };
  return {
    findBox: async () => {
      try {
        const s = await cdp();
        const { root } = await s.send("DOM.getDocument", { depth: -1, pierce: true });
        return findCheckbox(root);
      } catch {
        return null;
      }
    },
    isDetached: () => frame.isDetached(),
    // turnstile.getResponse() holds the widget's token; a form also carries it
    // in a cf-turnstile-response field.
    hasToken: () =>
      page
        .evaluate(() => {
          const w = /** @type {{ turnstile?: { getResponse?: () => string | undefined } }} */ (
            /** @type {unknown} */ (window)
          );
          let token = "";
          try {
            token = w.turnstile?.getResponse?.() ?? "";
          } catch {
            token = "";
          }
          if (token) return true;
          for (const el of document.querySelectorAll('[name="cf-turnstile-response"]')) {
            if (el instanceof HTMLInputElement && el.value) return true;
          }
          return false;
        })
        .catch(() => false),
    press: async (box) => {
      const s = await cdp();
      await s.send("DOM.focus", { backendNodeId: box });
      await page.keyboard.press("Space");
    },
    wait: (ms) => page.waitForTimeout(ms),
    mainNavigations: () => navigations,
  };
}

/**
 * Watches every page in the context and solves each challenge frame once, in
 * the background. settle(page) waits for the page's challenge, if one shows
 * within frameWaitMs, and returns its result.
 * @param {Pick<BrowserContext, "on" | "pages">} context
 * @param {(msg: string) => void} log
 * @param {{ frameWaitMs?: number, pollMs?: number, depsFor?: (frame: Frame) => SolveDeps }} [o]
 */
export function watchTurnstile(context, log, o = {}) {
  const frameWaitMs = o.frameWaitMs ?? 5000;
  const pollMs = o.pollMs ?? 500;
  const depsFor =
    o.depsFor ?? ((frame) => cdpDeps(/** @type {BrowserContext} */ (context), frame));
  /** @type {WeakSet<Frame>} */
  const seen = new WeakSet();
  /** @type {Map<Page, Promise<SolveResult | "error">>} */
  const inflight = new Map();
  /** @type {Set<Promise<SolveResult | "error">>} solves not finished yet */
  const running = new Set();
  let stopped = false;

  /** @param {Frame} frame */
  const start = (frame) => {
    if (stopped || seen.has(frame) || !isTurnstileFrameURL(frame.url())) return;
    seen.add(frame);
    const page = frame.page();
    const result = solveFrame(depsFor(frame)).then(
      (r) => {
        if (r === "unsolved") log("cloudflare: pressed the checkbox but got no token; the site may need a person");
        else if (r === "gone") log("cloudflare: the challenge frame closed without a token");
        else if (r !== "no-checkbox") log(`cloudflare: challenge ${r}`);
        return r;
      },
      (err) => {
        // A solve cut short by the browser closing is not worth a line.
        if (!stopped) log(`cloudflare: solver failed: ${err instanceof Error ? err.message : String(err)}`);
        return /** @type {const} */ ("error");
      },
    );
    inflight.set(page, result);
    running.add(result);
    void result.then(() => running.delete(result));
  };

  /** @param {Page} page */
  const watch = (page) => {
    page.on("framenavigated", (frame) => {
      // A new page load: the last load's result says nothing about this one.
      if (frame === page.mainFrame()) inflight.delete(page);
      start(frame);
    });
    for (const f of page.frames()) start(f);
  };
  for (const p of context.pages()) watch(p);
  context.on("page", watch);

  return {
    /**
     * @param {Page} page
     * @returns {Promise<SolveResult | "error" | "no-challenge">}
     */
    async settle(page) {
      const deadline = Date.now() + frameWaitMs;
      for (;;) {
        for (const f of page.frames()) start(f);
        const result = inflight.get(page);
        if (result) return result;
        if (Date.now() >= deadline) return "no-challenge";
        await page.waitForTimeout(pollMs);
      }
    },
    /**
     * The page's solve while it runs, else null. Never waits for a frame.
     * @param {Page} page
     */
    pending(page) {
      const result = inflight.get(page);
      return result && running.has(result) ? result : null;
    },
    stop() {
      stopped = true;
    },
  };
}
