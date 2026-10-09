/**
 * The words Safari's own AutoFill script matches a text field against, for
 * the tests that keep the prompt boxes out of AutoFill.
 *
 * Copied from Safari 26.2's form scripts (FormMetadata.js and
 * FormMetadataContactsAutoFillMappings.js, as extracted at
 * git.noh.am/noham/safari-internal-js), English entries only. Safari 27 moved
 * the lists into native code, so they can no longer be read; these are the
 * last ones we could see.
 *
 * How Safari uses them, from FormMetadata.js `_looksLikeOneTimeCodeField`:
 * a textarea counts as a text field. If one of the WEAK words ends a word in
 * the field's placeholder, title, aria-label or label, and the field is the
 * only visible one with no visible <input> before it, Safari treats it as a
 * one-time-code field. The QuickType bar then offers codes (Bitwarden's for
 * a viktorbarzin.me login) and autocorrect goes off. Separately, a field with
 * no label of its own gets the visible text before it scanned instead, and a
 * lone field always gets the page before it scanned for the STRONG phrases.
 */

/** WeakOneTimeCodeFieldLabels, matched at the end of a word only. */
export const WEAK_OTP = /(code|passcode|pin|token)\b/i;

/** The start of OneTimeCodeFieldLabels, matched as whole phrases. */
export const STRONG_OTP =
  /\b(security code|login code|enter (the )?code|otp|one ?time ?(password|passcode|code)|verification ?code|confirmation code|activation code|authorization code|2fa)\b/i;

/** The text of every element a field's aria-labelledby names. */
export function labelledByText(el: HTMLElement): string {
  return (el.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(" ");
}

/** Every string Safari matches a field's own label words in. */
export function labelWordsOf(el: HTMLElement): string[] {
  return [
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("title") ?? "",
    el.getAttribute("placeholder") ?? "",
    labelledByText(el),
  ];
}
