/**
 * Copy text, falling back to selecting it in its field: the async clipboard is
 * missing on a plain-http origin and can be refused, and `execCommand` still
 * works in both cases. When neither does, the text is left selected so a
 * keyboard copy is one keystroke away.
 */
export async function copyText(text: string, field: HTMLInputElement | undefined): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!field) return false;
    field.focus();
    field.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}
