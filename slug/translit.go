package slug

// Romanization table, keyed by LOWERCASE rune — FromTitle lowercases before it
// gets here, which halves the table and lets unicode.ToLower handle the
// script-specific case rules (Greek final sigma among them).
//
// Hand-rolled rather than pulled from golang.org/x/text: no module in this repo
// depends on it today, the TypeScript side needs the same table anyway, and the
// scripts actually in use here fit in one screen. A rune that is absent is not
// an error — it collapses to a dash, which is how CJK and emoji titles end up
// at Fallback.
//
// Cyrillic follows the Bulgarian Streamlined System (щ→sht, ъ→a, ж→zh, ц→ts,
// ч→ch, ш→sh, х→h, й→y), which also reads correctly for Russian and Ukrainian
// text apart from щ. Mapping to a soft sign's absence ("") is deliberate: it
// joins its neighbours instead of splitting the word with a dash.
var translit = map[rune]string{
	// Latin-1 Supplement
	'à': "a", 'á': "a", 'â': "a", 'ã': "a", 'ä': "a", 'å': "a",
	'æ': "ae", 'ç': "c",
	'è': "e", 'é': "e", 'ê': "e", 'ë': "e",
	'ì': "i", 'í': "i", 'î': "i", 'ï': "i",
	'ð': "d", 'ñ': "n",
	'ò': "o", 'ó': "o", 'ô': "o", 'õ': "o", 'ö': "o", 'ø': "o",
	'ù': "u", 'ú': "u", 'û': "u", 'ü': "u",
	'ý': "y", 'ÿ': "y", 'þ': "th", 'ß': "ss",

	// Latin Extended-A
	'ā': "a", 'ă': "a", 'ą': "a",
	'ć': "c", 'ĉ': "c", 'ċ': "c", 'č': "c",
	'ď': "d", 'đ': "d",
	'ē': "e", 'ĕ': "e", 'ė': "e", 'ę': "e", 'ě': "e",
	'ĝ': "g", 'ğ': "g", 'ġ': "g", 'ģ': "g",
	'ĥ': "h", 'ħ': "h",
	'ĩ': "i", 'ī': "i", 'ĭ': "i", 'į': "i", 'ı': "i", 'ĳ': "ij",
	'ĵ': "j", 'ķ': "k",
	'ĺ': "l", 'ļ': "l", 'ľ': "l", 'ŀ': "l", 'ł': "l",
	'ń': "n", 'ņ': "n", 'ň': "n", 'ŋ': "n",
	'ō': "o", 'ŏ': "o", 'ő': "o", 'œ': "oe",
	'ŕ': "r", 'ŗ': "r", 'ř': "r",
	'ś': "s", 'ŝ': "s", 'ş': "s", 'š': "s",
	'ţ': "t", 'ť': "t", 'ŧ': "t",
	'ũ': "u", 'ū': "u", 'ŭ': "u", 'ů': "u", 'ű': "u", 'ų': "u",
	'ŵ': "w", 'ŷ': "y",
	'ź': "z", 'ż': "z", 'ž': "z",

	// Cyrillic
	'а': "a", 'б': "b", 'в': "v", 'г': "g", 'д': "d", 'е': "e",
	'ж': "zh", 'з': "z", 'и': "i", 'й': "y", 'к': "k", 'л': "l",
	'м': "m", 'н': "n", 'о': "o", 'п': "p", 'р': "r", 'с': "s",
	'т': "t", 'у': "u", 'ф': "f", 'х': "h", 'ц': "ts", 'ч': "ch",
	'ш': "sh", 'щ': "sht", 'ъ': "a", 'ы': "y", 'ь': "", 'э': "e",
	'ю': "yu", 'я': "ya",
	'ё': "yo", 'і': "i", 'ї': "yi", 'є': "ye", 'ґ': "g", 'ў': "u",
	'ђ': "dj", 'ј': "j", 'љ': "lj", 'њ': "nj", 'ћ': "c", 'џ': "dz",

	// Greek
	'α': "a", 'β': "v", 'γ': "g", 'δ': "d", 'ε': "e", 'ζ': "z",
	'η': "i", 'θ': "th", 'ι': "i", 'κ': "k", 'λ': "l", 'μ': "m",
	'ν': "n", 'ξ': "x", 'ο': "o", 'π': "p", 'ρ': "r", 'σ': "s",
	'ς': "s", 'τ': "t", 'υ': "y", 'φ': "f", 'χ': "ch", 'ψ': "ps",
	'ω': "o",
	'ά': "a", 'έ': "e", 'ή': "i", 'ί': "i", 'ό': "o", 'ύ': "y",
	'ώ': "o", 'ϊ': "i", 'ϋ': "y", 'ΐ': "i", 'ΰ': "y",
}
