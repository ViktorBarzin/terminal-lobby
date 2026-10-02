// Decisions a person already made, by tool call.
//
// Claude Code can check one tool call's permission twice: measured live on
// 2026-10-02 (CLI 2.1.287), every allowed call drew the mod's dialog, and
// once it was answered the same dialog came straight back for the same
// tool_use_id. The second check takes the answer already given. Only one
// repeat is answered this way, so a call that keeps asking reaches the
// person again rather than looping on a remembered answer.

export type Remembered = { decision: 'allow' } | { decision: 'deny'; reason: string };

export class Decided {
  #byCall = new Map<string, Remembered>();
  #max: number;

  constructor(max = 64) {
    this.#max = max;
  }

  remember(toolId: string, decision: Remembered): void {
    if (!toolId) return;
    this.#byCall.delete(toolId);
    this.#byCall.set(toolId, decision);
    while (this.#byCall.size > this.#max) {
      const oldest = this.#byCall.keys().next().value;
      if (oldest === undefined) break;
      this.#byCall.delete(oldest);
    }
  }

  // The decision for this call's repeated check, once; undefined otherwise.
  recall(toolId: string): Remembered | undefined {
    if (!toolId) return undefined;
    const d = this.#byCall.get(toolId);
    this.#byCall.delete(toolId);
    return d;
  }
}
