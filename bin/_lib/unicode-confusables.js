'use strict';

/**
 * UTS#39 Unicode confusables subset — folds visually-confusable codepoints
 * to their ASCII skeleton for Layer B marker matching.
 *
 * Source: UTS#39 (https://unicode.org/reports/tr39/)
 *         Confusables data: https://www.unicode.org/Public/security/latest/confusables.txt
 * Scope: hand-curated subset covering Cyrillic, Greek, Armenian, Fullwidth,
 *        Mathematical Alphanumeric Symbols, and common digit confusables.
 *        Full UTS#39 table has ~6000 entries; we carry ~140 targeting
 *        prompt-injection attack vectors.
 *
 * v2.1.6 — W1c hardening (Risk 1 closure: Cyrillic/Greek homoglyph bypass).
 * v2.1.6 B6 — UTS#39 residual expansion: Turkish dotless-i, Arabic letter
 *   lookalikes, Hebrew letter lookalikes, Latin Extended-A/B, Armenian
 *   extended, Tifinagh sampling, Coptic additions (B4-03 partial closure).
 */

// ---------------------------------------------------------------------------
// Mapping: Unicode codepoint (number) -> ASCII string skeleton
// ---------------------------------------------------------------------------

const CONFUSABLES_MAP = new Map([
  // --- Cyrillic lowercase looking like Latin ---
  [0x0430, 'a'],  // а CYRILLIC SMALL LETTER A
  [0x0435, 'e'],  // е CYRILLIC SMALL LETTER IE
  [0x043E, 'o'],  // о CYRILLIC SMALL LETTER O
  [0x0440, 'p'],  // р CYRILLIC SMALL LETTER ER
  [0x0441, 'c'],  // с CYRILLIC SMALL LETTER ES
  [0x0443, 'y'],  // у CYRILLIC SMALL LETTER U
  [0x0445, 'x'],  // х CYRILLIC SMALL LETTER HA
  [0x0456, 'i'],  // і CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  [0x0455, 's'],  // ѕ CYRILLIC SMALL LETTER DZE
  [0x0458, 'j'],  // ј CYRILLIC SMALL LETTER JE

  // --- Cyrillic uppercase looking like Latin ---
  [0x0410, 'A'],  // А CYRILLIC CAPITAL LETTER A
  [0x0412, 'B'],  // В CYRILLIC CAPITAL LETTER VE
  [0x0421, 'C'],  // С CYRILLIC CAPITAL LETTER ES
  [0x0415, 'E'],  // Е CYRILLIC CAPITAL LETTER IE
  [0x041D, 'H'],  // Н CYRILLIC CAPITAL LETTER EN
  [0x041A, 'K'],  // К CYRILLIC CAPITAL LETTER KA
  [0x041C, 'M'],  // М CYRILLIC CAPITAL LETTER EM
  [0x041E, 'O'],  // О CYRILLIC CAPITAL LETTER O
  [0x0420, 'P'],  // Р CYRILLIC CAPITAL LETTER ER
  [0x0422, 'T'],  // Т CYRILLIC CAPITAL LETTER TE
  [0x0425, 'X'],  // Х CYRILLIC CAPITAL LETTER HA
  [0x0406, 'I'],  // І CYRILLIC CAPITAL LETTER BYELORUSSIAN-UKRAINIAN I
  [0x0405, 'S'],  // Ѕ CYRILLIC CAPITAL LETTER DZE
  [0x0408, 'J'],  // Ј CYRILLIC CAPITAL LETTER JE
  [0x0413, 'r'],  // Г CYRILLIC CAPITAL LETTER GHE (looks like Gamma/r)
  [0x0432, 'B'],  // в CYRILLIC SMALL LETTER VE (looks like B)

  // --- Greek capital letters looking like Latin ---
  [0x0391, 'A'],  // Α GREEK CAPITAL LETTER ALPHA
  [0x0392, 'B'],  // Β GREEK CAPITAL LETTER BETA
  [0x0395, 'E'],  // Ε GREEK CAPITAL LETTER EPSILON
  [0x0396, 'Z'],  // Ζ GREEK CAPITAL LETTER ZETA
  [0x0397, 'H'],  // Η GREEK CAPITAL LETTER ETA
  [0x0399, 'I'],  // Ι GREEK CAPITAL LETTER IOTA
  [0x039A, 'K'],  // Κ GREEK CAPITAL LETTER KAPPA
  [0x039C, 'M'],  // Μ GREEK CAPITAL LETTER MU
  [0x039D, 'N'],  // Ν GREEK CAPITAL LETTER NU
  [0x039F, 'O'],  // Ο GREEK CAPITAL LETTER OMICRON
  [0x03A1, 'P'],  // Ρ GREEK CAPITAL LETTER RHO
  [0x03A4, 'T'],  // Τ GREEK CAPITAL LETTER TAU
  [0x03A5, 'Y'],  // Υ GREEK CAPITAL LETTER UPSILON
  [0x03A7, 'X'],  // Χ GREEK CAPITAL LETTER CHI
  [0x03F4, 'O'],  // ϴ GREEK CAPITAL THETA SYMBOL (looks like O)

  // --- Greek lowercase letters looking like Latin ---
  [0x03B9, 'i'],  // ι GREEK SMALL LETTER IOTA
  [0x03BF, 'o'],  // ο GREEK SMALL LETTER OMICRON
  [0x03BD, 'v'],  // ν GREEK SMALL LETTER NU
  [0x03B1, 'a'],  // α GREEK SMALL LETTER ALPHA
  [0x03C2, 'c'],  // ς GREEK SMALL LETTER FINAL SIGMA (looks like c)
  [0x03F2, 'c'],  // ϲ GREEK LUNATE SIGMA SYMBOL
  [0x03C5, 'u'],  // υ GREEK SMALL LETTER UPSILON

  // --- Armenian letters looking like Latin ---
  [0x0531, 'A'],  // Ա ARMENIAN CAPITAL LETTER AYB
  [0x054D, 'S'],  // Ս ARMENIAN CAPITAL LETTER SEH
  [0x053B, 'I'],  // Ի ARMENIAN CAPITAL LETTER INI
  [0x0585, 'o'],  // օ ARMENIAN SMALL LETTER OH
  [0x0568, 'a'],  // ը ARMENIAN SMALL LETTER ET (looks like a)
  [0x0555, 'P'],  // Փ ARMENIAN CAPITAL LETTER PIWR (looks like P)
  [0x0548, 'U'],  // Պ ARMENIAN CAPITAL LETTER PEH (looks like U)

  // --- Latin lookalikes from other ranges ---
  [0x0D0E, 'n'],  // MALAYALAM LETTER NA (looks like n in some contexts)
  [0x1D0F, 'o'],  // LATIN LETTER SMALL CAPITAL O (looks like o)

  // --- Turkish dotless-i (B4-03 / B6) ---
  // U+0131 ı LATIN SMALL LETTER DOTLESS I: toLowerCase() in default JS locale
  // does NOT fold this to 'i'; must be handled explicitly.
  [0x0131, 'i'],  // ı LATIN SMALL LETTER DOTLESS I → i

  // --- Arabic letter lookalikes (B4-03 / B6) ---
  // These are common in visual-similarity attacks when mixed with Latin text.
  [0x0627, 'l'],  // ا ARABIC LETTER ALEF → l (tall vertical stroke)
  [0x0647, 'o'],  // ه ARABIC LETTER HEH → o (round)
  [0x0644, 'l'],  // ل ARABIC LETTER LAM → l (vertical stroke with hook)
  [0x0649, 'i'],  // ى ARABIC LETTER ALEF MAKSURA → i

  // --- Hebrew letter lookalikes (B4-03 / B6) ---
  [0x05D5, 'l'],  // ו HEBREW LETTER VAV → l (vertical stroke)
  [0x05E1, 'o'],  // ס HEBREW LETTER SAMEKH → o (round)
  [0x05DF, 'l'],  // ן HEBREW LETTER FINAL NUN → l (vertical stroke)
  [0x05DD, 'o'],  // ם HEBREW LETTER FINAL MEM → o (square-round)

  // --- Latin Extended-A (B4-03 / B6) ---
  [0x01CF, 'I'],  // Ǐ LATIN CAPITAL LETTER I WITH CARON → I
  [0x01D0, 'i'],  // ǐ LATIN SMALL LETTER I WITH CARON → i
  [0x01D1, 'O'],  // Ǒ LATIN CAPITAL LETTER O WITH CARON → O
  [0x01D2, 'o'],  // ǒ LATIN SMALL LETTER O WITH CARON → o
  [0x01D3, 'U'],  // Ǔ LATIN CAPITAL LETTER U WITH CARON → U
  [0x01D4, 'u'],  // ǔ LATIN SMALL LETTER U WITH CARON → u

  // --- Latin Extended-B ligatures and lookalikes (B4-03 / B6) ---
  [0x0196, 'I'],  // Ɩ LATIN CAPITAL LETTER IOTA → I (looks like I)
  [0x01C0, 'l'],  // ǀ LATIN LETTER DENTAL CLICK → l (single vertical bar)
  [0x01C1, 'l'],  // ǁ LATIN LETTER LATERAL CLICK → ll (double vertical bar → maps to single l)

  // --- Armenian extended (B4-03 / B6, supplements existing Armenian block) ---
  [0x0578, 'n'],  // ո ARMENIAN SMALL LETTER VO → n
  [0x057C, 'n'],  // ռ ARMENIAN SMALL LETTER RA → n
  [0x057D, 'u'],  // ս ARMENIAN SMALL LETTER SEH → u
  [0x0584, 'p'],  // ք ARMENIAN SMALL LETTER KEH → p

  // --- Tifinagh sampling (B4-03 / B6) ---
  [0x2D63, 'I'],  // ⵣ TIFINAGH LETTER YAZ → I (vertical strokes)
  [0x2D4D, 'l'],  // ⵍ TIFINAGH LETTER YAL → l (single vertical)

  // --- Coptic additions (B4-03 / B6) ---
  [0x2C9F, 'o'],  // ⲟ COPTIC SMALL LETTER O → o (additional beyond existing Coptic)

  // --- Common subscript/superscript digit confusables ---
  // Arabic-Indic digits (U+0660–U+0669)
  [0x0660, '0'],  // ٠ ARABIC-INDIC DIGIT ZERO
  [0x0661, '1'],  // ١ ARABIC-INDIC DIGIT ONE
  [0x0662, '2'],  // ٢ ARABIC-INDIC DIGIT TWO
  [0x0663, '3'],  // ٣ ARABIC-INDIC DIGIT THREE
  [0x0664, '4'],  // ٤ ARABIC-INDIC DIGIT FOUR
  [0x0665, '5'],  // ٥ ARABIC-INDIC DIGIT FIVE
  [0x0666, '6'],  // ٦ ARABIC-INDIC DIGIT SIX
  [0x0667, '7'],  // ٧ ARABIC-INDIC DIGIT SEVEN
  [0x0668, '8'],  // ٨ ARABIC-INDIC DIGIT EIGHT
  [0x0669, '9'],  // ٩ ARABIC-INDIC DIGIT NINE
  // Extended Arabic-Indic digits (U+06F0–U+06F9)
  [0x06F0, '0'],  // ۰ EXTENDED ARABIC-INDIC DIGIT ZERO
  [0x06F1, '1'],  // ۱ EXTENDED ARABIC-INDIC DIGIT ONE
  [0x06F2, '2'],  // ۲ EXTENDED ARABIC-INDIC DIGIT TWO
  [0x06F3, '3'],  // ۳ EXTENDED ARABIC-INDIC DIGIT THREE
  [0x06F4, '4'],  // ۴ EXTENDED ARABIC-INDIC DIGIT FOUR
  [0x06F5, '5'],  // ۵ EXTENDED ARABIC-INDIC DIGIT FIVE
  [0x06F6, '6'],  // ۶ EXTENDED ARABIC-INDIC DIGIT SIX
  [0x06F7, '7'],  // ۷ EXTENDED ARABIC-INDIC DIGIT SEVEN
  [0x06F8, '8'],  // ۸ EXTENDED ARABIC-INDIC DIGIT EIGHT
  [0x06F9, '9'],  // ۹ EXTENDED ARABIC-INDIC DIGIT NINE
  // Devanagari digits (U+0966–U+096F)
  [0x0966, '0'],  // ० DEVANAGARI DIGIT ZERO
  [0x0967, '1'],  // १ DEVANAGARI DIGIT ONE
  [0x0968, '2'],  // २ DEVANAGARI DIGIT TWO
  [0x0969, '3'],  // ३ DEVANAGARI DIGIT THREE
  [0x096A, '4'],  // ४ DEVANAGARI DIGIT FOUR
  [0x096B, '5'],  // ५ DEVANAGARI DIGIT FIVE
  [0x096C, '6'],  // ६ DEVANAGARI DIGIT SIX
  [0x096D, '7'],  // ७ DEVANAGARI DIGIT SEVEN
  [0x096E, '8'],  // ८ DEVANAGARI DIGIT EIGHT
  [0x096F, '9'],  // ९ DEVANAGARI DIGIT NINE
]);

// ---------------------------------------------------------------------------
// Mathematical Alphanumeric Symbols helper
// ---------------------------------------------------------------------------

// UTS#39: Mathematical Alphanumeric Symbols block (U+1D400–U+1D7FF) maps
// bold/italic/bold-italic/script/fraktur variants of A-Z/a-z/0-9 to ASCII.
// We handle these programmatically since the mapping is regular.
//
// Mathematical letter ranges: each block is 26 letters starting at a known offset.
// Reference: https://www.unicode.org/charts/PDF/U1D400.pdf
const MATH_ALPHA_RANGES = [
  // [start, end, asciiBase, length]
  [0x1D400, 0x1D419, 0x41, 26],  // Mathematical Bold Capital A-Z
  [0x1D41A, 0x1D433, 0x61, 26],  // Mathematical Bold Small a-z
  [0x1D434, 0x1D44D, 0x41, 26],  // Mathematical Italic Capital A-Z
  [0x1D44E, 0x1D467, 0x61, 26],  // Mathematical Italic Small a-z (g at 1D454 is missing → 0x210E)
  [0x1D468, 0x1D481, 0x41, 26],  // Mathematical Bold Italic Capital A-Z
  [0x1D482, 0x1D49B, 0x61, 26],  // Mathematical Bold Italic Small a-z
  [0x1D49C, 0x1D4B5, 0x41, 26],  // Mathematical Script Capital A-Z (sparse — gaps at 1D49D etc.)
  [0x1D4B6, 0x1D4CF, 0x61, 26],  // Mathematical Script Small a-z
  [0x1D4D0, 0x1D4E9, 0x41, 26],  // Mathematical Bold Script Capital A-Z
  [0x1D4EA, 0x1D503, 0x61, 26],  // Mathematical Bold Script Small a-z
  [0x1D504, 0x1D51D, 0x41, 26],  // Mathematical Fraktur Capital A-Z
  [0x1D51E, 0x1D537, 0x61, 26],  // Mathematical Fraktur Small a-z
  [0x1D538, 0x1D551, 0x41, 26],  // Mathematical Double-Struck Capital A-Z
  [0x1D552, 0x1D56B, 0x61, 26],  // Mathematical Double-Struck Small a-z
  [0x1D56C, 0x1D585, 0x41, 26],  // Mathematical Bold Fraktur Capital A-Z
  [0x1D586, 0x1D59F, 0x61, 26],  // Mathematical Bold Fraktur Small a-z
  [0x1D5A0, 0x1D5B9, 0x41, 26],  // Mathematical Sans-Serif Capital A-Z
  [0x1D5BA, 0x1D5D3, 0x61, 26],  // Mathematical Sans-Serif Small a-z
  [0x1D5D4, 0x1D5ED, 0x41, 26],  // Mathematical Sans-Serif Bold Capital A-Z
  [0x1D5EE, 0x1D607, 0x61, 26],  // Mathematical Sans-Serif Bold Small a-z
  [0x1D608, 0x1D621, 0x41, 26],  // Mathematical Sans-Serif Italic Capital A-Z
  [0x1D622, 0x1D63B, 0x61, 26],  // Mathematical Sans-Serif Italic Small a-z
  [0x1D63C, 0x1D655, 0x41, 26],  // Mathematical Sans-Serif Bold Italic Capital A-Z
  [0x1D656, 0x1D66F, 0x61, 26],  // Mathematical Sans-Serif Bold Italic Small a-z
  [0x1D670, 0x1D689, 0x41, 26],  // Mathematical Monospace Capital A-Z
  [0x1D68A, 0x1D6A3, 0x61, 26],  // Mathematical Monospace Small a-z
  // Mathematical digit variants (bold, double-struck, etc.)
  [0x1D7CE, 0x1D7D7, 0x30, 10],  // Mathematical Bold Digits 0-9
  [0x1D7D8, 0x1D7E1, 0x30, 10],  // Mathematical Double-Struck Digits 0-9
  [0x1D7E2, 0x1D7EB, 0x30, 10],  // Mathematical Sans-Serif Digits 0-9
  [0x1D7EC, 0x1D7F5, 0x30, 10],  // Mathematical Sans-Serif Bold Digits 0-9
  [0x1D7F6, 0x1D7FF, 0x30, 10],  // Mathematical Monospace Digits 0-9
];

/**
 * Returns the ASCII character for a mathematical alphanumeric symbol codepoint,
 * or null if the codepoint is not in a known math alpha range.
 *
 * @param {number} cp
 * @returns {string|null}
 */
function _mathAlphaToAscii(cp) {
  for (const [start, end, asciiBase] of MATH_ALPHA_RANGES) {
    if (cp >= start && cp <= end) {
      return String.fromCharCode(asciiBase + (cp - start));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fullwidth helper
// ---------------------------------------------------------------------------

/**
 * Fullwidth forms block: U+FF01–U+FF5E maps to U+0021–U+007E (ASCII printable).
 * Special: U+FF10–U+FF19 → '0'–'9', U+FF21–U+FF3A → 'A'–'Z',
 *          U+FF41–U+FF5A → 'a'–'z'.
 * The formula is: cp - 0xFEE0 gives the ASCII codepoint for the full range.
 *
 * @param {number} cp
 * @returns {string|null}
 */
function _fullwidthToAscii(cp) {
  if (cp >= 0xFF01 && cp <= 0xFF5E) {
    return String.fromCharCode(cp - 0xFEE0);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fold visually-confusable Unicode codepoints to their ASCII skeleton.
 *
 * Processing order:
 *   1. Fullwidth forms (U+FF01–U+FF5E) — programmatic block shift.
 *   2. Mathematical Alphanumeric Symbols (U+1D400–U+1D7FF) — programmatic range.
 *   3. CONFUSABLES_MAP table lookup — Cyrillic, Greek, Armenian, digit confusables.
 *
 * Non-confusable characters pass through unchanged.
 * The function is idempotent: applying it to already-ASCII text returns the same string.
 * Performance: O(n) linear scan via codePointAt iteration.
 *
 * @param {string} text
 * @returns {string}
 */
function foldToSkeleton(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  let result = '';
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    // Advance i: surrogate pairs are 2 UTF-16 code units; BMP chars are 1.
    const charLen = cp > 0xFFFF ? 2 : 1;

    let replacement = null;

    // 1. Fullwidth forms (BMP, charLen always 1)
    if (cp >= 0xFF01 && cp <= 0xFF5E) {
      replacement = _fullwidthToAscii(cp);
    }
    // 2. Mathematical Alphanumeric Symbols (supplementary plane, charLen 2)
    else if (cp >= 0x1D400 && cp <= 0x1D7FF) {
      replacement = _mathAlphaToAscii(cp);
    }
    // 3. Table lookup
    else {
      replacement = CONFUSABLES_MAP.get(cp) || null;
    }

    if (replacement !== null) {
      result += replacement;
    } else {
      result += text.slice(i, i + charLen);
    }

    i += charLen;
  }

  return result;
}

module.exports = { foldToSkeleton, CONFUSABLES_MAP };
