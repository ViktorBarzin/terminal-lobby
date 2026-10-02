// Dialogs waiting on an answer from the web, keyed by tool_use_id.

export type Waiter<T> = { promise: Promise<T>; cancel: () => void };

export class Pending<T> {
  #waiting = new Map<string, (value: T) => void>();

  wait(id: string): Waiter<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    this.#waiting.set(id, resolve);
    return {
      promise,
      cancel: () => {
        if (this.#waiting.get(id) === resolve) this.#waiting.delete(id);
      },
    };
  }

  has(id: string): boolean {
    return this.#waiting.has(id);
  }

  // Hands `value` to the dialog waiting on `id`. False when nothing waits.
  resolve(id: string, value: T): boolean {
    const resolve = this.#waiting.get(id);
    if (!resolve) return false;
    this.#waiting.delete(id);
    resolve(value);
    return true;
  }
}
