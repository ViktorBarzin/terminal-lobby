// A one-line summary of a conversation the lobby started, for its title.
//
// Claude Code writes its own summary into the terminal title after the first
// prompt somebody types, and tmux-api adopts that as the session's title. It
// writes nothing for a prompt a plugin submitted, and the lobby sends every
// prompt through this mod, so a session started from the lobby kept its
// random id as its only name: in the sidebar of every other device and in
// every push about it. So the mod asks for the summary itself, once, on the
// first prompt of a fresh conversation, and sends it as a `summary` event.
// session-events stamps it as @tl_summary, where tmux-api's auto-title rule
// reads it when the pane title has none.

// The engine's small fast model, which is what Claude Code titles with.
export const SUMMARY_MODEL = 'haiku';
// The title is capped at 64 characters on the server, and a few words is
// all a reply needs room for.
export const SUMMARY_MAX_TOKENS = 40;
const PROMPT_CHARS = 4000;
const TITLE_CHARS = 64;

const SYSTEM = [
  'You write the title of a conversation with a coding assistant, from the first thing the person asked.',
  'Reply with the title alone: 3 to 7 words, sentence case, in the language the person wrote in.',
  'No quotes, no trailing full stop, no preamble.',
].join(' ');

// Whether this conversation still owes a summary. Claimed once per
// conversation; a /clear starts a new one.
export class SummaryOnce {
  #claimed = false;

  // True the first time it is asked in a conversation, false after.
  claim(): boolean {
    if (this.#claimed) return false;
    this.#claimed = true;
    return true;
  }

  reset(): void {
    this.#claimed = false;
  }
}

// The request for $.model.complete.
export function summaryRequest(prompt: string): { model: string; prompt: string; system: string; maxTokens: number } {
  const text = prompt.length > PROMPT_CHARS ? `${prompt.slice(0, PROMPT_CHARS)}…` : prompt;
  return { model: SUMMARY_MODEL, system: SYSTEM, prompt: text, maxTokens: SUMMARY_MAX_TOKENS };
}

// The title in a model's reply: its first line, without the wrapping a model
// sometimes adds anyway, or '' when there is nothing left.
export function summaryFrom(reply: string): string {
  const line = reply.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  let t = line.replace(/^(title|заглавие)\s*:\s*/i, '');
  t = t.replace(/^[#*_`"'“”‘’«»\s]+|[*_`"'“”‘’«»\s]+$/gu, '');
  t = t.replace(/\.+$/, '').trim();
  const chars = [...t];
  return chars.length > TITLE_CHARS ? chars.slice(0, TITLE_CHARS).join('').trim() : t;
}
