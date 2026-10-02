// Control of a session browser: who is driving it, the agent or one person.
// While a person holds it the host refuses the agent's tool calls. It lapses
// after a stretch with no input from the holder, so a forgotten takeover does
// not lock the agent out for good.
//
// Control is held by one viewer connection, not by a username: the same
// person on a laptop and a phone has two connections, and only the one that
// took control drives. The name is kept beside it for display ("Viktor has
// control"). A holder whose connection closes keeps control until it lapses
// or someone takes it, so a reload does not drop it; any connection allowed
// to control can take it. The same tab reconnecting resumes it without a
// takeover: it names its previous connection in a resume message.

/** @typedef {{ holder: string | null, holderId: string | null, since: number | null, lapseAt: number | null }} ControlSnapshot */

export class Control {
  /** @type {string | null} the holding connection's id */
  #holderId = null;
  /** @type {string | null} the holder's display name */
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

  /** @returns {string | null} the holder's display name */
  get holder() {
    return this.#holder;
  }

  /** @returns {string | null} the holding connection's id */
  get holderId() {
    return this.#holderId;
  }

  /**
   * Always succeeds: anyone allowed to control may take over from whoever
   * holds it, the same person's other connection included. The relay has
   * already checked that this connection is allowed. `since` restarts only
   * when the person changes.
   * @param {string} id the connection taking control
   * @param {string} user its display name
   */
  take(id, user) {
    const now = this.#now();
    if (this.#holder !== user) this.#since = now;
    this.#holderId = id;
    this.#holder = user;
    this.#lastInput = now;
  }

  /**
   * Moves control from a holder's closed connection to its new one, when the
   * same person's tab reconnects. The person did not change and gave no
   * input, so `since` and the lapse stay as they were: a page left open on a
   * flaky network does not keep control past the lapse by reconnecting. The
   * caller checks that `prev` has closed.
   * @param {string} prev the connection the viewer had before
   * @param {string} id its new connection
   * @param {string} user the new connection's display name
   * @returns {boolean} whether control moved
   */
  resume(prev, id, user) {
    if (this.#holderId === null || this.#holderId !== prev || this.#holder !== user) return false;
    this.#holderId = id;
    return true;
  }

  /**
   * @param {string} id
   * @returns {boolean} whether control changed hands
   */
  handBack(id) {
    if (this.#holderId === null || this.#holderId !== id) return false;
    this.#release();
    return true;
  }

  /**
   * Records input from a connection and says whether it may act on the page.
   * @param {string} id
   * @returns {boolean}
   */
  input(id) {
    if (this.#holderId === null || this.#holderId !== id) return false;
    this.#lastInput = this.#now();
    return true;
  }

  /**
   * Frees control a user holds, on whichever connection holds it, including
   * one already closed. session-events asks for this when that user's access
   * ends, so a revoked share does not leave the agent locked out until the
   * lapse.
   * @param {string} user
   * @returns {boolean} whether control changed hands
   */
  release(user) {
    if (this.#holderId === null || this.#holder !== user) return false;
    this.#release();
    return true;
  }

  /** @returns {boolean} whether control lapsed just now */
  lapse() {
    if (this.#holderId === null) return false;
    if (this.#now() < this.#lastInput + this.#lapseMs) return false;
    this.#release();
    return true;
  }

  /** @returns {ControlSnapshot} */
  snapshot() {
    if (this.#holderId === null) return { holder: null, holderId: null, since: null, lapseAt: null };
    return {
      holder: this.#holder,
      holderId: this.#holderId,
      since: this.#since,
      lapseAt: this.#lastInput + this.#lapseMs,
    };
  }

  #release() {
    this.#holderId = null;
    this.#holder = null;
    this.#since = null;
  }
}
