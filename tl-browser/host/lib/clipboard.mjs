// Chrome's clipboard, reached from a page of its own. Headless Chrome keeps
// one clipboard for the whole browser: a page's copy (keyboard, execCommand
// or navigator.clipboard.writeText) lands there, and a native paste reads it.
// Pages in the agent's context are granted nothing, so none of them can read
// it. The host reads and writes it from a page in a separate context, at an
// origin that is fulfilled by a route and never reaches the network, which
// is the only origin granted clipboard access. A separate context also keeps
// the page out of playwright-mcp's tabs and the viewers' tab strip.
//
// The host treats the clipboard as a mailbox: every read empties it, so text
// a person pasted does not stay where the next page or the agent could paste
// it, and a page copying the same text twice is seen twice.

/**
 * @typedef {import("playwright-core").Browser} Browser
 * @typedef {import("playwright-core").Page} Page
 */

export const CLIPBOARD_ORIGIN = "https://clipboard.tl-browser.invalid";
/** A read or write is a quick look; a page that will not answer has failed. */
const CLIPBOARD_MS = 2000;

/**
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @returns {Promise<T>}
 */
function deadline(p, ms) {
  return Promise.race([
    p,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("The clipboard did not answer.")), ms).unref(),
    ),
  ]);
}

export class ChromeClipboard {
  #browser;
  /** @type {Promise<Page> | null} */
  #page = null;

  /** @param {Browser} browser */
  constructor(browser) {
    this.#browser = browser;
  }

  /**
   * Puts text on the clipboard, for a native paste to read.
   * @param {string} text
   */
  async write(text) {
    await this.#run((page) =>
      page.evaluate((t) => navigator.clipboard.writeText(t), text),
    );
  }

  /**
   * Reads the clipboard and empties it.
   * @returns {Promise<string>}
   */
  async take() {
    const text = await this.#run((page) => page.evaluate(() => navigator.clipboard.readText()));
    if (text) await this.write("");
    return text;
  }

  /**
   * @template T
   * @param {(page: Page) => Promise<T>} step
   * @returns {Promise<T>}
   */
  async #run(step) {
    this.#page ??= this.#open();
    try {
      return await deadline(
        this.#page.then((page) => step(page)),
        CLIPBOARD_MS,
      );
    } catch (err) {
      // Opened again on the next use: the page may have crashed or hung.
      const page = this.#page;
      this.#page = null;
      page?.then((p) => p.context().close()).catch(() => {});
      throw err;
    }
  }

  /** @returns {Promise<Page>} */
  async #open() {
    const context = await this.#browser.newContext();
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: CLIPBOARD_ORIGIN,
      });
      await context.route(`${CLIPBOARD_ORIGIN}/**`, (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>clipboard</title>" }),
      );
      const page = await context.newPage();
      await page.goto(`${CLIPBOARD_ORIGIN}/`);
      return page;
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
  }
}
