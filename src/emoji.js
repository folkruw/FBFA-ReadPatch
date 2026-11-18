const REGIONAL_A = 0x1f1e6;

/** "R" → 🇷 (lettre « regional indicator », celle qu'on obtient avec :regional_indicator_r:). */
export function regionalIndicator(letter) {
  return String.fromCodePoint(REGIONAL_A + (letter.toUpperCase().charCodeAt(0) - 65));
}

/** Supprime le sélecteur de variante (U+FE0F) pour que « ❤ » et « ❤️ » aient la même clé. */
export function normalizeUnicode(s) {
  return s.replace(/️/g, '').trim();
}

/** Clé de stockage d'un emoji de réaction : l'id pour un emoji du serveur, le caractère sinon. */
export function emojiKeyOf(emoji) {
  if (!emoji) return '';
  return emoji.id ?? normalizeUnicode(emoji.name ?? '');
}

const CUSTOM_RE = /^<(a?):([\w~]{1,32}):(\d{15,25})>$/;
const PICTO_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u;

/**
 * Interprète l'emoji saisi dans /config categorie ajouter.
 * Accepte : une lettre seule (R → 🇷), :regional_indicator_r:, un emoji unicode, ou <:nom:id>.
 * Retourne { key, display } ou null.
 */
export function parseEmojiInput(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;

  let m = s.match(CUSTOM_RE);
  if (m) return { key: m[3], display: s };

  m = s.match(/^:?regional_indicator_([a-z]):?$/i);
  if (m) {
    const e = regionalIndicator(m[1]);
    return { key: e, display: e };
  }

  if (/^[a-z]$/i.test(s)) {
    const e = regionalIndicator(s);
    return { key: e, display: e };
  }

  if (s.length <= 32 && !/\s/.test(s) && !/[a-z]/i.test(s) && PICTO_RE.test(s)) {
    return { key: normalizeUnicode(s), display: s };
  }
  return null;
}
