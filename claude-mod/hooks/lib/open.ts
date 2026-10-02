// The dialogs on screen right now, as the events that announced them, oldest
// first. The link sends them again after every hello: a session-events that
// restarted has forgotten them, and the web could not answer them otherwise.

import type { ModEvent } from './queue.ts';

export class OpenDialogs {
  #byTool = new Map<string, ModEvent>();

  add(ev: ModEvent): void {
    const id = String(ev.toolId ?? '');
    this.#byTool.delete(id);
    this.#byTool.set(id, ev);
  }

  settle(toolId: string): void {
    this.#byTool.delete(toolId);
  }

  list(): ModEvent[] {
    return [...this.#byTool.values()];
  }
}
