// The session's Chrome: launch, its tabs, the screencast viewers watch, the
// input a person in control sends, freezing and closing. Chrome is reached
// over Playwright's pipe (--remote-debugging-pipe), never a TCP port, so no
// other user on the box can attach to it.

import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { childPids, treePids } from "./proctree.mjs";
import { TabRegistry } from "./tabs.mjs";

/**
 * @typedef {import("playwright-core").Browser} Browser
 * @typedef {import("playwright-core").BrowserContext} BrowserContext
 * @typedef {import("playwright-core").Page} Page
 * @typedef {import("playwright-core").CDPSession} CDPSession
 * @typedef {import("./protocol.mjs").ViewerMessage} ViewerMessage
 * @typedef {{ jpeg: string, w: number, h: number }} Frame
 */

export const VIEWPORT = { width: 1280, height: 800 };
const JPEG_QUALITY = 60;
const CLOSE_TIMEOUT_MS = 5000;
const NAV_TIMEOUT_MS = 30_000;

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 * @returns {string | undefined} the storage state to seed the context from, if any
 */
export function storageStatePath(env, home) {
  const p = env.TL_BROWSER_STORAGE_STATE ?? `${home}/.cache/playwright-shared-storage-state.json`;
  return p && existsSync(p) ? p : undefined;
}

/**
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @returns {Promise<T | undefined>}
 */
function within(p, ms) {
  return Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve(undefined), ms).unref()),
  ]);
}

export class BrowserSession {
  /** @type {TabRegistry<Page>} */
  tabs = new TabRegistry();
  #browser;
  #context;
  /** @type {number[]} the Chrome processes this host started */
  #roots;
  /** @type {Map<Page, CDPSession>} */
  #cdp = new Map();
  /** @type {Set<Page>} pages being screencast */
  #casting = new Set();
  /** Input from a person runs in order: a mouse down must land before its up. */
  #queue = Promise.resolve();
  #tabsQueued = false;
  #closing = false;
  #o;

  /**
   * @param {Browser} browser
   * @param {BrowserContext} context
   * @param {number[]} roots
   * @param {{
   *   onTabs: () => void,
   *   onFrame: (tab: string, frame: Frame) => void,
   *   onDisconnected: () => void,
   * }} opts
   */
  constructor(browser, context, roots, opts) {
    this.#browser = browser;
    this.#context = context;
    this.#roots = roots;
    this.#o = opts;
    context.on("page", (page) => this.#addPage(page));
    for (const page of context.pages()) this.#addPage(page);
    browser.on("disconnected", () => {
      if (!this.#closing) this.#o.onDisconnected();
    });
  }

  /**
   * @param {{ channel: string, storageState: string | undefined }} opts
   * @param {ConstructorParameters<typeof BrowserSession>[3]} hooks
   */
  static async launch({ channel, storageState }, hooks) {
    const before = new Set(childPids(process.pid));
    const browser = await chromium.launch({
      channel,
      headless: true,
      // The host handles its own signals so it can clear tmux and the socket
      // before Chrome goes.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    try {
      const context = await browser.newContext({ viewport: VIEWPORT, storageState });
      const roots = childPids(process.pid).filter((pid) => !before.has(pid));
      return new BrowserSession(browser, context, roots, hooks);
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }

  get context() {
    return this.#context;
  }

  /** @returns {number[]} */
  get pids() {
    return this.#roots.flatMap((root) => treePids(root));
  }

  /** Stops Chrome and every helper it started: no CPU, pages kept. */
  freeze() {
    this.#signal("SIGSTOP");
  }

  thaw() {
    this.#signal("SIGCONT");
  }

  /**
   * Starts the screencast on exactly the tabs someone is watching.
   * @param {Set<string>} wanted tab ids
   */
  setWatched(wanted) {
    for (const page of [...this.#casting]) {
      const id = this.tabs.idOf(page);
      if (id === null || !wanted.has(id)) this.#stopCast(page);
    }
    for (const id of wanted) {
      const page = this.tabs.pageOf(id);
      if (page && !this.#casting.has(page)) this.#startCast(page, id);
    }
  }

  /**
   * A fresh picture of a tab. The screencast paints only on change, so a new
   * viewer would otherwise see nothing until the page moves.
   * @param {string} id
   * @returns {Promise<Frame | null>}
   */
  async snapshot(id) {
    const page = this.tabs.pageOf(id);
    if (!page) return null;
    try {
      const cdp = await this.#session(page);
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: JPEG_QUALITY,
      });
      const size = page.viewportSize() ?? VIEWPORT;
      return { jpeg: data, w: size.width, h: size.height };
    } catch {
      return null;
    }
  }

  /**
   * Runs a person's input or navigation on a tab, in order with the rest.
   * Copy answers with the selected text; everything else with nothing.
   * @param {string} id
   * @param {ViewerMessage} msg
   * @returns {Promise<string | undefined>}
   */
  act(id, msg) {
    const run = async () => {
      const page = this.tabs.pageOf(id);
      if (!page) throw new Error("That tab has closed.");
      return this.#act(page, msg);
    };
    const result = this.#queue.then(run);
    this.#queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Closes Chrome; anything still running after the timeout is killed. */
  async close() {
    this.#closing = true;
    this.thaw();
    await within(this.#browser.close(), CLOSE_TIMEOUT_MS).catch(() => {});
    this.#signal("SIGKILL");
  }

  /**
   * @param {Page} page
   * @param {ViewerMessage} msg
   * @returns {Promise<string | undefined>}
   */
  async #act(page, msg) {
    switch (msg.t) {
      case "mouse": {
        const opts = { button: msg.button, clickCount: Math.max(1, msg.clickCount) };
        if (msg.type === "click") await page.mouse.click(msg.x, msg.y, opts);
        else {
          await page.mouse.move(msg.x, msg.y);
          if (msg.type === "down") await page.mouse.down(opts);
          if (msg.type === "up") await page.mouse.up(opts);
        }
        return undefined;
      }
      case "wheel":
        await page.mouse.move(msg.x, msg.y);
        await page.mouse.wheel(msg.dx, msg.dy);
        return undefined;
      case "key":
        await this.#key(page, msg.type, msg.key);
        return undefined;
      case "insertText":
        await page.keyboard.insertText(msg.text);
        return undefined;
      case "navigate":
        await page.goto(msg.url, { waitUntil: "commit", timeout: NAV_TIMEOUT_MS });
        return undefined;
      case "back":
        await page.goBack({ waitUntil: "commit", timeout: NAV_TIMEOUT_MS });
        return undefined;
      case "forward":
        await page.goForward({ waitUntil: "commit", timeout: NAV_TIMEOUT_MS });
        return undefined;
      case "reload":
        await page.reload({ waitUntil: "commit", timeout: NAV_TIMEOUT_MS });
        return undefined;
      case "copy":
        return page.evaluate(() => {
          const el = document.activeElement;
          if (
            (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
            el.selectionStart !== null &&
            el.selectionEnd !== null
          )
            return el.value.slice(el.selectionStart, el.selectionEnd);
          return String(window.getSelection() ?? "");
        });
      default:
        return undefined;
    }
  }

  /**
   * KeyboardEvent.key names mostly match Playwright's. One it does not know
   * (a dead key, an IME's "Process") is typed as text when it is a single
   * character and dropped otherwise.
   * @param {Page} page
   * @param {"down" | "up" | "press"} type
   * @param {string} key
   */
  async #key(page, type, key) {
    try {
      if (type === "down") await page.keyboard.down(key);
      else if (type === "up") await page.keyboard.up(key);
      else await page.keyboard.press(key);
    } catch (err) {
      if (!/Unknown key/.test(String(err))) throw err;
      if (type !== "up" && [...key].length === 1) await page.keyboard.insertText(key);
    }
  }

  /** @param {Page} page */
  #addPage(page) {
    this.tabs.add(page);
    this.tabs.update(page, { url: page.url() });
    this.#tabsChanged();
    const refreshTitle = () => {
      page
        .title()
        .then((title) => {
          if (this.tabs.update(page, { title })) this.#tabsChanged();
        })
        .catch(() => {});
    };
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const agent = this.tabs.navigated(page);
      const info = this.tabs.update(page, { url: page.url() });
      if (agent || info) this.#tabsChanged();
      refreshTitle();
    });
    page.on("domcontentloaded", refreshTitle);
    page.on("load", refreshTitle);
    page.on("close", () => {
      this.#casting.delete(page);
      this.#cdp
        .get(page)
        ?.detach()
        .catch(() => {});
      this.#cdp.delete(page);
      this.tabs.remove(page);
      this.#tabsChanged();
    });
  }

  /** Coalesces a burst of changes (navigate, then its title) into one report. */
  #tabsChanged() {
    if (this.#tabsQueued) return;
    this.#tabsQueued = true;
    queueMicrotask(() => {
      this.#tabsQueued = false;
      this.#o.onTabs();
    });
  }

  /**
   * @param {Page} page
   * @returns {Promise<CDPSession>}
   */
  async #session(page) {
    const existing = this.#cdp.get(page);
    if (existing) return existing;
    const cdp = await this.#context.newCDPSession(page);
    this.#cdp.set(page, cdp);
    cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      const id = this.tabs.idOf(page);
      if (id === null || !this.#casting.has(page)) return;
      // w and h are the page's size in CSS pixels, the space mouse
      // coordinates are given in.
      this.#o.onFrame(id, {
        jpeg: data,
        w: Math.round(metadata.deviceWidth),
        h: Math.round(metadata.deviceHeight),
      });
    });
    return cdp;
  }

  /**
   * @param {Page} page
   * @param {string} id
   */
  #startCast(page, id) {
    this.#casting.add(page);
    this.#session(page)
      .then((cdp) =>
        cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: JPEG_QUALITY,
          maxWidth: VIEWPORT.width,
          maxHeight: VIEWPORT.height,
        }),
      )
      .catch(() => {
        if (this.tabs.idOf(page) === id) this.#casting.delete(page);
      });
  }

  /** @param {Page} page */
  #stopCast(page) {
    this.#casting.delete(page);
    this.#cdp
      .get(page)
      ?.send("Page.stopScreencast")
      .catch(() => {});
  }

  /** @param {NodeJS.Signals} sig */
  #signal(sig) {
    let pids;
    try {
      pids = this.pids;
    } catch {
      pids = this.#roots;
    }
    for (const pid of pids) {
      try {
        process.kill(pid, sig);
      } catch {
        // Exited between the scan and the signal.
      }
    }
  }
}
