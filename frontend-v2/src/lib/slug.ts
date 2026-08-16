/**
 * Deriving a tmux session NAME from a display TITLE.
 *
 * The mirror of Go's terminal-lobby/slug, and it has to stay a mirror: a
 * disagreement between the two would create or rename the wrong session. Both
 * sides are tested against `slug/vectors.json` — add a case there, not here.
 *
 * This exists in the browser at all because creating a session involves no
 * server call: the lobby picks the name, and ttyd's `tmux new-session -A`
 * brings the session into being when the iframe attaches. That path
 * deliberately still works while tmux-api is down (store/lobby.ts — "attaching
 * the terminal is what actually brings the session into being"), so the name
 * cannot come from an endpoint.
 */

/** tmux session-name budget, matching tmux-api's sessionNameRe. */
export const MAX_NAME_LEN = 32;

/**
 * Title cap, in code points. An emoji is one character to the person who typed
 * it, and cutting on UTF-16 units would split a surrogate pair.
 */
export const MAX_TITLE_RUNES = 64;

/**
 * Romanization table, keyed by LOWERCASE code point — slugFromTitle lowercases
 * first, which halves the table. Kept in step with slug/translit.go.
 *
 * Cyrillic follows the Bulgarian Streamlined System (щ→sht, ъ→a, ж→zh, ц→ts,
 * ч→ch, ш→sh, х→h, й→y), which also reads correctly for Russian and Ukrainian
 * apart from щ. A soft sign maps to nothing on purpose, joining its neighbours
 * rather than splitting the word with a dash.
 */
const TRANSLIT: Record<string, string> = {
  // Latin-1 Supplement
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a",
  æ: "ae", ç: "c",
  è: "e", é: "e", ê: "e", ë: "e",
  ì: "i", í: "i", î: "i", ï: "i",
  ð: "d", ñ: "n",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o",
  ù: "u", ú: "u", û: "u", ü: "u",
  ý: "y", ÿ: "y", þ: "th", ß: "ss",

  // Latin Extended-A
  ā: "a", ă: "a", ą: "a",
  ć: "c", ĉ: "c", ċ: "c", č: "c",
  ď: "d", đ: "d",
  ē: "e", ĕ: "e", ė: "e", ę: "e", ě: "e",
  ĝ: "g", ğ: "g", ġ: "g", ģ: "g",
  ĥ: "h", ħ: "h",
  ĩ: "i", ī: "i", ĭ: "i", į: "i", ı: "i", ĳ: "ij",
  ĵ: "j", ķ: "k",
  ĺ: "l", ļ: "l", ľ: "l", ŀ: "l", ł: "l",
  ń: "n", ņ: "n", ň: "n", ŋ: "n",
  ō: "o", ŏ: "o", ő: "o", œ: "oe",
  ŕ: "r", ŗ: "r", ř: "r",
  ś: "s", ŝ: "s", ş: "s", š: "s",
  ţ: "t", ť: "t", ŧ: "t",
  ũ: "u", ū: "u", ŭ: "u", ů: "u", ű: "u", ų: "u",
  ŵ: "w", ŷ: "y",
  ź: "z", ż: "z", ž: "z",

  // Cyrillic
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e",
  ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l",
  м: "m", н: "n", о: "o", п: "p", р: "r", с: "s",
  т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch",
  ш: "sh", щ: "sht", ъ: "a", ы: "y", ь: "", э: "e",
  ю: "yu", я: "ya",
  ё: "yo", і: "i", ї: "yi", є: "ye", ґ: "g", ў: "u",
  ђ: "dj", ј: "j", љ: "lj", њ: "nj", ћ: "c", џ: "dz",

  // Greek
  α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z",
  η: "i", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m",
  ν: "n", ξ: "x", ο: "o", π: "p", ρ: "r", σ: "s",
  ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps",
  ω: "o",
  ά: "a", έ: "e", ή: "i", ί: "i", ό: "o", ύ: "y",
  ώ: "o", ϊ: "i", ϋ: "y", ΐ: "i", ΰ: "y",
};

/** Control characters (C0 and C1) and every flavour of Unicode whitespace. */
const CONTROL_OR_SPACE = /[\p{Cc}\p{Zs}\p{Zl}\p{Zp}\s]/u;

/**
 * Normalize a title for storage and display.
 *
 * Control characters become a space rather than vanishing: a title pasted out
 * of a terminal or an editor arrives with tabs and newlines in it, and "tab and
 * newline" is what the person meant where "tabandnewline" is not. Whitespace
 * runs then collapse, so the result is stable whichever control character
 * produced the gap.
 *
 * Idempotent — a retitle compares against the stored value, and a clean that
 * kept changing its own output would rename on every poll.
 */
export function cleanTitle(title: string): string {
  let out = "";
  let space = true; // leading whitespace is dropped by starting "in" a run
  for (const ch of title) {
    if (CONTROL_OR_SPACE.test(ch)) {
      if (!space) {
        out += " ";
        space = true;
      }
      continue;
    }
    out += ch;
    space = false;
  }
  if (out.endsWith(" ")) out = out.slice(0, -1);
  const runes = [...out];
  if (runes.length > MAX_TITLE_RUNES) {
    out = runes.slice(0, MAX_TITLE_RUNES).join("");
    if (out.endsWith(" ")) out = out.slice(0, -1);
  }
  return out;
}

/**
 * Derive the tmux session name for a title.
 *
 * Returns "" when nothing usable survives — a CJK or emoji-only title, or no
 * title at all. The caller supplies its own fallback (fallbackName below).
 */
export function slugFromTitle(title: string): string {
  const clean = cleanTitle(title).toLowerCase();

  let ascii = "";
  for (const ch of clean) {
    if (ch.charCodeAt(0) < 0x80 && ch.length === 1) {
      ascii += ch;
      continue;
    }
    const mapped = TRANSLIT[ch];
    if (mapped !== undefined) {
      ascii += mapped;
      continue;
    }
    // Untransliterable (CJK, emoji, symbols). Emit something outside the keep
    // set so the collapse below turns it into a single dash, rather than
    // silently joining the words on either side.
    ascii += " ";
  }

  let out = "";
  let dash = false; // collapses a run of unusable characters into one dash
  for (const ch of ascii) {
    if (isNameChar(ch)) {
      out += ch;
      dash = false;
      continue;
    }
    if (!dash && out.length > 0) {
      out += "-";
      dash = true;
    }
  }

  out = trimDashes(out);
  if (out.length > MAX_NAME_LEN) out = trimTrailingDashes(out.slice(0, MAX_NAME_LEN));
  return out;
}

/** tmux-api's sessionNameRe minus uppercase, since slugFromTitle lowercases. */
function isNameChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "-";
}

function trimDashes(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === "-") a++;
  while (b > a && s[b - 1] === "-") b--;
  return s.slice(a, b);
}

function trimTrailingDashes(s: string): string {
  let b = s.length;
  while (b > 0 && s[b - 1] === "-") b--;
  return s.slice(0, b);
}

/**
 * Name a session whose title yielded nothing usable: the first session-N not
 * already taken.
 */
export function fallbackName(taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const name = "session-" + n;
    if (!taken.has(name)) return name;
  }
}

/**
 * The name a title will actually get: its slug, or a session-N when the title
 * has nothing romanizable in it. Does NOT resolve collisions — a name already
 * taken is rejected so the person can pick a different title, rather than being
 * given a name they never asked for.
 */
export function nameForTitle(title: string, taken: ReadonlySet<string>): string {
  return slugFromTitle(title) || fallbackName(taken);
}
