// Control of a session browser: who is driving it, the agent or one person.
// While a person holds it the host refuses the agent's tool calls. It lapses
// after a stretch with no input from the holder, so a forgotten takeover does
// not lock the agent out for good.

/** @typedef {{ holder: string | null, since: number | null, lapseAt: number | null }} ControlSnapshot */

export class Control {
  /** @type {string | null} */
  #holder = null;
  /** @type {number | null} */
  #since = null;
  #lastInput = 0;
  #lapseMs;
  #now;

  /** @param {{ lapseMs: number, now?: () => number }} opts */
  constructor({ lapseMs, now = Date.now }) {
    this.#lapseMs = lapseMs;
    this.#now = now;
  }

  /** @returns {string | null} */
  get holder() {
    return this.#holder;
  }

  /**
   * Always succeeds: anyone allowed to control may take over from whoever
   * holds it. The relay has already checked that this person is allowed.
   * @param {string} user
   */
  take(user) {
    const now = this.#now();
    if (this.#holder !== user) {
      this.#holder = user;
      this.#since = now;
    }
    this.#lastInput = now;
  }

  /**
   * @param {string} user
   * @returns {boolean} whether control changed hands
   */
  handBack(user) {
    if (this.#holder === null || this.#holder !== user) return false;
    this.#release();
    return true;
  }

  /**
   * Records input from a person and says whether it may act on the page.
   * @param {string} user
   * @returns {boolean}
   */
  input(user) {
    if (this.#holder === null || this.#holder !== user) return false;
    this.#lastInput = this.#now();
    return true;
  }

  /** @returns {boolean} whether control lapsed just now */
  lapse() {
    if (this.#holder === null) return false;
    if (this.#now() < this.#lastInput + this.#lapseMs) return false;
    this.#release();
    return true;
  }

  /** @returns {ControlSnapshot} */
  snapshot() {
    if (this.#holder === null) return { holder: null, since: null, lapseAt: null };
    return { holder: this.#holder, since: this.#since, lapseAt: this.#lastInput + this.#lapseMs };
  }

  #release() {
    this.#holder = null;
    this.#since = null;
  }
}
