// The idle clock behind Frozen. A browser nobody uses for freezeMs is frozen
// (SIGSTOP: no CPU, pages kept). One left frozen for closeMs is closed, because
// with swap full a frozen page still holds its memory.

/** @typedef {"live" | "frozen"} IdleState */

export class IdleClock {
  /** @type {IdleState} */
  state = "live";
  #lastActivity;
  #frozenAt = 0;
  #freezeMs;
  #closeMs;
  #now;

  /** @param {{ freezeMs: number, closeMs: number, now?: () => number }} opts */
  constructor({ freezeMs, closeMs, now = Date.now }) {
    this.#freezeMs = freezeMs;
    this.#closeMs = closeMs;
    this.#now = now;
    this.#lastActivity = now();
  }

  touch() {
    this.#lastActivity = this.#now();
  }

  /** @returns {boolean} whether it was frozen */
  thaw() {
    this.touch();
    if (this.state !== "frozen") return false;
    this.state = "live";
    return true;
  }

  /**
   * Advances the clock. `busy` is true while a viewer is watching, a person
   * holds control or a tool call is running; each counts as activity.
   * @param {boolean} busy
   * @returns {"freeze" | "close" | null} what is due now
   */
  check(busy) {
    const now = this.#now();
    if (busy) {
      this.#lastActivity = now;
      if (this.state === "frozen") this.#frozenAt = now;
      return null;
    }
    if (this.state === "live") {
      if (now - this.#lastActivity < this.#freezeMs) return null;
      this.state = "frozen";
      this.#frozenAt = now;
      return "freeze";
    }
    return now - this.#frozenAt >= this.#closeMs ? "close" : null;
  }
}
