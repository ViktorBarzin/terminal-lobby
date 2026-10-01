// The tabs of a session browser, and which one is "the agent's tab".
// playwright-mcp does not expose its current tab, so the agent's tab is the
// page whose main frame navigated last, or the page created last. The panel's
// tab strip covers the cases this approximation misses.

/** @typedef {{ id: string, url: string, title: string }} TabInfo */

/** @template P */
export class TabRegistry {
  /** @type {Map<P, TabInfo>} insertion order is creation order */
  #byPage = new Map();
  #next = 1;
  /** @type {string | null} */
  agentTab = null;

  /**
   * @param {P} page
   * @returns {string} the new tab's id
   */
  add(page) {
    const id = `t${this.#next++}`;
    this.#byPage.set(page, { id, url: "", title: "" });
    this.agentTab = id;
    return id;
  }

  /**
   * @param {P} page
   * @returns {boolean} whether the agent's tab changed
   */
  remove(page) {
    const info = this.#byPage.get(page);
    if (!info) return false;
    this.#byPage.delete(page);
    if (this.agentTab !== info.id) return false;
    const rest = [...this.#byPage.values()];
    this.agentTab = rest.length ? rest[rest.length - 1].id : null;
    return true;
  }

  /**
   * @param {P} page
   * @returns {boolean} whether the agent's tab changed
   */
  navigated(page) {
    const info = this.#byPage.get(page);
    if (!info || this.agentTab === info.id) return false;
    this.agentTab = info.id;
    return true;
  }

  /**
   * @param {P} page
   * @param {{ url?: string, title?: string }} change
   * @returns {boolean} whether anything changed
   */
  update(page, change) {
    const info = this.#byPage.get(page);
    if (!info) return false;
    let changed = false;
    if (change.url !== undefined && change.url !== info.url) {
      info.url = change.url;
      changed = true;
    }
    if (change.title !== undefined && change.title !== info.title) {
      info.title = change.title;
      changed = true;
    }
    return changed;
  }

  /**
   * @param {P} page
   * @returns {string | null}
   */
  idOf(page) {
    return this.#byPage.get(page)?.id ?? null;
  }

  /**
   * @param {string} id
   * @returns {P | null}
   */
  pageOf(id) {
    for (const [page, info] of this.#byPage) if (info.id === id) return page;
    return null;
  }

  /** @returns {P[]} */
  pages() {
    return [...this.#byPage.keys()];
  }

  /** @returns {TabInfo[]} */
  snapshot() {
    return [...this.#byPage.values()].map((info) => ({ ...info }));
  }
}
