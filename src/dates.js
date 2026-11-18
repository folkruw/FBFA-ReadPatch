import { UserError } from './errors.js';

export const DATE_HELP =
  "Formats acceptés : 01/11/2026, 01/11 18:30, 2026-11-01, 7j, 24h, 2sem, 1mois, hier, aujourd'hui.";

function dayBound(now, offsetDays, endOfDay) {
  return endOfDay
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, 23, 59, 59, 999).getTime()
    : new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays).getTime();
}

/**
 * Convertit une saisie utilisateur en timestamp (ms).
 * - absolu : 01/11/2026, 01/11/26, 01/11, 01/11/2026 18:30, 01/11 18h, 2026-11-01, 2026-11-01 18:30
 * - relatif : 24h, 7j, 2sem, 1mois (= il y a …)
 * - mots-clés : aujourd'hui, hier, maintenant
 * `endOfDay` : si aucune heure n'est donnée, prend la fin de journée (pour une date de fin incluse).
 * Retourne null si la saisie est vide, lève une UserError si elle est invalide.
 */
export function parseDateInput(input, { endOfDay = false, now = new Date() } = {}) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/\s+/g, ' ').replace(/’/g, "'");

  if (s === 'maintenant' || s === 'now') return now.getTime();
  if (["aujourd'hui", 'aujourdhui', 'auj', 'today'].includes(s)) return dayBound(now, 0, endOfDay);
  if (s === 'hier' || s === 'yesterday') return dayBound(now, -1, endOfDay);

  let m = s.match(/^(\d+) ?(h|heures?|j|jours?|d|s|sem|semaines?|w|mois)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const d = new Date(now);
    if (unit.startsWith('h')) d.setHours(d.getHours() - n);
    else if (unit === 'mois') d.setMonth(d.getMonth() - n);
    else if (unit === 'j' || unit === 'd' || unit.startsWith('jour')) d.setDate(d.getDate() - n);
    else d.setDate(d.getDate() - 7 * n);
    return d.getTime();
  }

  let year;
  let month;
  let day;
  let hour;
  let minute;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2})[:h](\d{2})?)?$/);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
    hour = m[4];
    minute = m[5];
  } else {
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?(?: (?:à )?(\d{1,2})[:h](\d{2})?)?$/);
    if (!m) throw new UserError(`Date invalide : « ${raw} ». ${DATE_HELP}`);
    day = Number(m[1]);
    month = Number(m[2]);
    year = m[3] === undefined ? now.getFullYear() : m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    hour = m[4];
    minute = m[5];
  }

  const hasTime = hour !== undefined;
  const h = hasTime ? Number(hour) : 0;
  const mi = minute !== undefined ? Number(minute) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || h > 23 || mi > 59) {
    throw new UserError(`Date invalide : « ${raw} ». ${DATE_HELP}`);
  }

  let date;
  if (!hasTime) date = endOfDay ? new Date(year, month - 1, day, 23, 59, 59, 999) : new Date(year, month - 1, day);
  else date = new Date(year, month - 1, day, h, mi, endOfDay ? 59 : 0, endOfDay ? 999 : 0);

  // Rejette les dates impossibles (31/02 → 03/03 en JS).
  if (date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new UserError(`Date invalide : « ${raw} ». ${DATE_HELP}`);
  }
  return date.getTime();
}

/** Timestamp Discord : s'affiche dans le fuseau horaire de chaque utilisateur. */
export function discordTs(ms, style = 'f') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}
