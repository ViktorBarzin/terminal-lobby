// A lobby prompt that is a slash command (`/unslop`, `/doc-tone a.md`) has to
// run as one. $.prompt.submit hands its text to the model as a user turn, so a
// bare skill name sent that way ran nothing at all; $.command.run is what a
// typed `/name args` goes through.

export type SlashCall = { command: string; args: string };

// The name runs to the first whitespace and holds no further slash, so a path
// such as `/usr/bin is missing jq` never reads as one.
const SLASH = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;

// The command a prompt names, when the whole prompt is `/name args` and the
// session has a command by that name; null when it is prose to submit. Claude
// Code runs a slash command only as the whole prompt, and an unknown name stays
// prose rather than a run the engine would reject.
export function slashCall(text: string, names: readonly string[]): SlashCall | null {
  const [, command, args = ''] = SLASH.exec(text.trim()) ?? [];
  if (command === undefined || !names.includes(command)) return null;
  return { command, args };
}
