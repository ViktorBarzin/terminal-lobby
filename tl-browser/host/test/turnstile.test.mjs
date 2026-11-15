import assert from "node:assert/strict";
import { test } from "node:test";
import { findCheckbox, isTurnstileFrameURL, solveFrame, watchTurnstile } from "../lib/turnstile.mjs";

test("recognises the Turnstile challenge frame and nothing else", () => {
  assert.equal(
    isTurnstileFrameURL(
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/0x4AAA/auto/fbE/new/normal/auto/",
    ),
    true,
  );
  assert.equal(isTurnstileFrameURL("https://challenges.cloudflare.com.evil.test/x"), false);
  assert.equal(isTurnstileFrameURL("http://challenges.cloudflare.com/x"), false);
  assert.equal(isTurnstileFrameURL("https://example.com/?u=https://challenges.cloudflare.com/"), false);
  assert.equal(isTurnstileFrameURL("about:blank"), false);
  assert.equal(isTurnstileFrameURL(undefined), false);
});

// The shape DOM.getDocument({ depth: -1, pierce: true }) returns for the
// challenge frame: the checkbox sits in a closed shadow root under body, which
// is why no page script and no Playwright selector can reach it.
const challengeDoc = {
  nodeName: "#document",
  backendNodeId: 1,
  children: [
    {
      nodeName: "HTML",
      backendNodeId: 2,
      children: [
        {
          nodeName: "BODY",
          backendNodeId: 3,
          attributes: [],
          shadowRoots: [
            {
              nodeName: "#document-fragment",
              backendNodeId: 4,
              shadowRootType: "closed",
              children: [
                {
                  nodeName: "DIV",
                  backendNodeId: 5,
                  attributes: ["class", "cb-c"],
                  children: [
                    {
                      nodeName: "LABEL",
                      backendNodeId: 6,
                      children: [
                        { nodeName: "INPUT", backendNodeId: 77, attributes: ["type", "checkbox"] },
                        { nodeName: "SPAN", backendNodeId: 8, attributes: ["class", "cb-i"] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test("finds the checkbox inside the closed shadow root", () => {
  assert.equal(findCheckbox(challengeDoc), 77);
});

test("a frame still showing its spinner has no checkbox yet", () => {
  const spinner = {
    nodeName: "#document",
    backendNodeId: 1,
    children: [{ nodeName: "INPUT", backendNodeId: 9, attributes: ["type", "hidden"] }],
  };
  assert.equal(findCheckbox(spinner), null);
  assert.equal(findCheckbox(undefined), null);
});

/**
 * Fake solver dependencies. The checkbox shows after `appearsAfter` looks;
 * pressing it yields a token when `passes`.
 * @param {{ appearsAfter?: number, passes?: boolean, token?: string, neverShows?: boolean }} o
 */
function fakeDeps({ appearsAfter = 0, passes = true, token = "", neverShows = false } = {}) {
  /** @type {string[]} */
  const calls = [];
  let looks = 0;
  let pressed = false;
  return {
    calls,
    deps: {
      findBox: async () => {
        looks++;
        if (neverShows || (pressed && passes)) return null;
        return looks > appearsAfter ? 77 : null;
      },
      isDetached: () => false,
      hasToken: async () => Boolean(token || (pressed && passes)),
      /** @param {number} id */
      press: async (id) => {
        calls.push(`press:${id}`);
        pressed = true;
      },
      wait: async () => {},
      pollMs: 0,
      timeoutMs: 50,
      settleMs: 50,
    },
  };
}

test("waits for the checkbox, then presses it once", async () => {
  const f = fakeDeps({ appearsAfter: 3 });
  assert.equal(await solveFrame(f.deps), "solved");
  assert.deepEqual(f.calls, ["press:77"]);
});

test("reports unsolved when no token follows the press", async () => {
  const f = fakeDeps({ passes: false });
  assert.equal(await solveFrame(f.deps), "unsolved");
  assert.deepEqual(f.calls, ["press:77"]);
});

test("an invisible pass needs no key press", async () => {
  const f = fakeDeps({ neverShows: true, token: "0.abc" });
  assert.equal(await solveFrame(f.deps), "passed");
  assert.deepEqual(f.calls, []);
});

// Hit live 2026-11-15: a widget that failed re-rendered in a new frame, and
// the old frame going away was logged as "solved".
test("a frame that goes away without a token is gone, not solved", async () => {
  const f = fakeDeps({ neverShows: true });
  let n = 0;
  f.deps.isDetached = () => ++n > 2;
  assert.equal(await solveFrame(f.deps), "gone");
});

test("a frame that goes away after a pressed checkbox and a token is solved", async () => {
  const f = fakeDeps();
  let pressed = false;
  const press = f.deps.press;
  f.deps.press = async (id) => {
    pressed = true;
    await press(id);
  };
  f.deps.isDetached = () => pressed;
  assert.equal(await solveFrame(f.deps), "solved");
});

test("gives up quietly when no checkbox ever shows", async () => {
  const f = fakeDeps({ neverShows: true });
  assert.equal(await solveFrame(f.deps), "no-checkbox");
  assert.deepEqual(f.calls, []);
});

/** A fake page whose framenavigated handler the test fires by hand. */
function fakePage() {
  /** @type {Record<string, (frame: any) => void>} */
  const handlers = {};
  const main = { url: () => "https://example.com/" };
  const page = {
    /** @param {string} ev @param {(frame: any) => void} fn */
    on: (ev, fn) => {
      handlers[ev] = fn;
    },
    frames: () => [],
    mainFrame: () => main,
    waitForTimeout: async () => {},
  };
  Object.assign(main, { page: () => page });
  return { page, handlers, main };
}

const challenge = (/** @type {any} */ page) => ({
  url: () => "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/x",
  page: () => page,
});

test("the watcher solves each challenge frame once and ignores other frames", async () => {
  const p = fakePage();
  const f = fakeDeps();
  /** @type {unknown[]} */
  const solvedFrames = [];
  const solver = watchTurnstile({ on: () => {}, pages: () => [p.page] }, () => {}, {
    frameWaitMs: 0,
    pollMs: 0,
    depsFor: (frame) => {
      solvedFrames.push(frame);
      return f.deps;
    },
  });
  const frame = challenge(p.page);
  p.handlers.framenavigated(p.main);
  p.handlers.framenavigated(frame);
  p.handlers.framenavigated(frame);
  assert.equal(await solver.settle(p.page), "solved");
  assert.equal(solvedFrames.length, 1);
  assert.deepEqual(f.calls, ["press:77"]);
});

test("a new page load forgets the last result", async () => {
  const p = fakePage();
  const solver = watchTurnstile({ on: () => {}, pages: () => [p.page] }, () => {}, {
    frameWaitMs: 0,
    pollMs: 0,
    depsFor: () => fakeDeps().deps,
  });
  p.handlers.framenavigated(challenge(p.page));
  assert.equal(await solver.settle(p.page), "solved");
  p.handlers.framenavigated(p.main);
  assert.equal(await solver.settle(p.page), "no-challenge");
});

test("pages opened later are watched too", async () => {
  const p = fakePage();
  /** @type {(page: any) => void} */
  let onPage = () => {};
  const solver = watchTurnstile(
    {
      /** @param {string} ev @param {(page: any) => void} fn */
      on: (ev, fn) => {
        if (ev === "page") onPage = fn;
      },
      pages: () => [],
    },
    () => {},
    { frameWaitMs: 0, pollMs: 0, depsFor: () => fakeDeps().deps },
  );
  onPage(p.page);
  p.handlers.framenavigated(challenge(p.page));
  assert.equal(await solver.settle(p.page), "solved");
});

test("a solve cut short by stop() logs nothing", async () => {
  const p = fakePage();
  /** @type {string[]} */
  const logged = [];
  const deps = fakeDeps().deps;
  deps.findBox = async () => {
    throw new Error("Target page, context or browser has been closed");
  };
  const solver = watchTurnstile(
    { on: () => {}, pages: () => [p.page] },
    (m) => logged.push(m),
    { frameWaitMs: 0, pollMs: 0, depsFor: () => deps },
  );
  solver.stop();
  p.handlers.framenavigated(challenge(p.page));
  assert.equal(await solver.settle(p.page), "no-challenge");
  assert.deepEqual(logged, []);
});

test("pending gives the running solve and nothing once it is done", async () => {
  const p = fakePage();
  /** @type {() => void} */
  let finish = () => {};
  const deps = fakeDeps().deps;
  deps.findBox = () =>
    new Promise((r) => {
      finish = () => r(null);
    });
  deps.isDetached = () => true;
  let looked = false;
  const findBox = deps.findBox;
  deps.isDetached = () => looked;
  deps.findBox = () => {
    looked = true;
    return findBox();
  };
  const solver = watchTurnstile({ on: () => {}, pages: () => [p.page] }, () => {}, {
    frameWaitMs: 0,
    pollMs: 0,
    depsFor: () => deps,
  });
  assert.equal(solver.pending(p.page), null, "no challenge, nothing to wait for");
  p.handlers.framenavigated(challenge(p.page));
  const running = solver.pending(p.page);
  assert.ok(running, "a solve is running");
  finish();
  await running;
  await new Promise((r) => setImmediate(r));
  assert.equal(solver.pending(p.page), null, "done, nothing to wait for");
});
