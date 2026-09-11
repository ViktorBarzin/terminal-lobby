/**
 * Is the keyboard currently inside something that types?
 *
 * ONE CHORD needs this and it is Cmd+Z. Every other lobby chord lives in the
 * Alt+Shift namespace precisely so it is safe to press with a caret in a field;
 * undo is the exception, because a text field, a textarea and the file editor
 * each have their own undo and the browser's is better at it than we could be —
 * it knows the caret, the selection and the word boundaries.
 *
 * WHY A FLAG RATHER THAN LETTING THE FIELD WIN. The keybinding engine's single
 * listener is CAPTURE phase on `window` (engine.ts `init`), while CodeMirror's
 * `historyKeymap` (@codemirror/commands, `Mod-z`) is a BUBBLE-phase handler on
 * its own contentDOM (components/codemirror-view.ts, the `keymap.of([...])`
 * extension). Capture runs first, so a matching `ctrl+z` row fires BEFORE the
 * editor's undo is ever asked and there is nothing downstream that can hand the
 * key back. The refusal has to happen at the table, which is what
 * `bindings.logic.ts`'s `!editing` clause does with this answer.
 *
 * It reads the DOM, so it lives here rather than in bindings.logic.ts, which is
 * deliberately free of it.
 */

/**
 * Input types that carry typed text, and therefore an edit history of their
 * own. A checkbox, a radio, a file picker or a range slider has none, so Cmd+Z
 * pressed on one means the lobby's undo — refusing there would leave the chord
 * dead for as long as the focus ring sat on a toggle.
 *
 * `HTMLInputElement.type` reports "text" for a missing or unrecognised `type`
 * attribute, so a bare `<input>` lands in this set without a special case.
 */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

/**
 * True when `el` owns the undo chord: a text-bearing input, a textarea, a
 * contenteditable region, or anywhere inside the CodeMirror editor.
 *
 * Takes the element rather than reading `document.activeElement` itself, so the
 * decision is testable without a focus dance and so a caller with the keydown's
 * own target in hand can pass that instead.
 *
 * READONLY IS NOT EDITING. Nothing types into a readonly field, so it has no
 * history to walk back and the press means the lobby's undo.
 */
export function isEditingTarget(el: Element | null | undefined): boolean {
  if (!el) return false;

  // THE TERMINAL IS NOT A TEXT FIELD, whatever its DOM says. xterm types
  // through a hidden proxy — `<textarea class="xterm-helper-textarea">` inside
  // its `.xterm` element (node_modules/@xterm/xterm 6.0.0, Terminal.open) —
  // and `term.focus()` focuses exactly that, so an attached session leaves
  // document.activeElement on a TEXTAREA. It carries no readOnly either
  // (xterm sets that only under `disableStdin`, which this app never passes),
  // so without this line the branch below reads every attached session as a
  // field being typed into: `editing` would be true wherever a session is
  // open, Cmd+Z would do nothing there, and Ctrl+Z would go on suspending the
  // foreground job. That is the outcome ADR-0024 turned down.
  //
  // By ancestry rather than by the textarea's own class, so the accessibility
  // tree and anything else xterm mounts inside its element is covered too.
  // Nothing of ours lives in there: `.xterm` is the element xterm creates
  // inside our container, not the container (terminal/TerminalNative.tsx).
  if (el.closest(".xterm")) return false;

  // The editor first, and by ancestry: a click can leave focus on a `.cm-line`
  // rather than on the contentDOM, and CodeMirror's keymap still runs from
  // there. Nothing in this app mounts it readonly.
  if (el.closest(".cm-editor")) return true;

  const tag = el.tagName;
  if (tag === "TEXTAREA") return !(el as HTMLTextAreaElement).readOnly;
  if (tag === "INPUT") {
    const input = el as HTMLInputElement;
    return !input.readOnly && TEXT_INPUT_TYPES.has(input.type.toLowerCase());
  }

  // `isContentEditable` would be the direct answer and jsdom does not implement
  // it (it reads `undefined` there, measured 2026-09-10), so the attribute is
  // what this asks. `closest` is what covers inheritance: focus inside an
  // editable region lands on a descendant that carries no attribute of its own.
  const editable = el.closest("[contenteditable]");
  if (!editable) return false;
  return (editable.getAttribute("contenteditable") ?? "").toLowerCase() !== "false";
}
