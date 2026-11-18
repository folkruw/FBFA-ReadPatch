// Actions de configuration partagées entre les commandes Discord (/config) et l'API locale.
// Elles valident les entrées et lèvent une UserError avec un message lisible.
import { ChannelType } from 'discord.js';
import * as store from './db.js';
import { parseEmojiInput } from './emoji.js';
import { UserError } from './errors.js';
import { checkChannelAccess, scanChannel } from './scanner.js';

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** Emoji saisi → { key, display }. « :nom: » = emoji personnalisé du serveur portant ce nom. */
export function resolveEmoji(guild, raw) {
  const s = String(raw ?? '').trim();
  const named = s.match(/^:([\w~]{2,32}):$/);
  if (named && !/^regional_indicator_/i.test(named[1])) {
    const found = guild?.emojis?.cache?.find((e) => e.name === named[1]);
    if (found) return { key: found.id, display: found.toString() };
  }
  return parseEmojiInput(s);
}

/** « #E67E22 », « E67E22 » ou un nombre → entier ; vide → null. */
export function parseColor(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number') {
    if (Number.isInteger(input) && input >= 0 && input <= 0xffffff) return input;
    throw new UserError('Couleur invalide. Exemple : `#E67E22`.');
  }
  const m = String(input).trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new UserError('Couleur invalide. Exemple : `#E67E22`.');
  return parseInt(m[1], 16);
}

/* ───────────── Salons ───────────── */

/** Vérifie que le salon existe sur ce serveur, est textuel et lisible par le bot. */
export async function resolveTextChannel(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) throw new UserError('Salon introuvable sur ce serveur.');
  if (!channel.isTextBased() || !TEXT_TYPES.includes(channel.type)) {
    throw new UserError("Ce salon n'est pas un salon textuel.");
  }
  checkChannelAccess(channel, guild.members.me ?? guild.client.user);
  return channel;
}

/** Surveille le salon et lit son historique depuis `since`. */
export async function watchChannel(guild, channel, since) {
  const isNew = store.addChannel(guild.id, channel.id);
  try {
    const result = await scanChannel(channel, since);
    return { isNew, ...result };
  } catch (err) {
    if (isNew) store.removeChannel(channel.id);
    throw err;
  }
}

export function unwatchChannel(guildId, channelId) {
  const ch = store.getChannel(channelId);
  if (!ch || ch.guild_id !== guildId) return false;
  return store.removeChannel(channelId);
}

/* ───────────── Catégories ───────────── */

/** Crée ou modifie une catégorie. Retourne { created, category }. */
export function saveCategory(guild, { code: rawCode, label: rawLabel, emoji: rawEmoji, color: rawColor }) {
  const guildId = guild.id;
  const code = String(rawCode ?? '').trim().toUpperCase();
  if (!/^[\p{L}\p{N}_-]{1,10}$/u.test(code)) throw new UserError('Code invalide : 1 à 10 lettres ou chiffres, sans espace.');
  const label = String(rawLabel ?? '').trim();
  if (!label || label.length > 50) throw new UserError('Libellé invalide : 1 à 50 caractères.');
  const color = parseColor(rawColor);

  const emoji = resolveEmoji(guild, rawEmoji);
  if (!emoji) {
    throw new UserError('Emoji invalide. Exemples : `R` (→ 🇷), `🇷`, `✅`, `:nom_emoji_du_serveur:` ou `<:nom:id>`.');
  }
  if (emoji.key === store.getSortEmoji(guildId).key) {
    throw new UserError(`${emoji.display} est la réaction « à trier ». Choisis un autre emoji (ou change-la avec \`/config tri\`).`);
  }
  const other = store.findCategoryByEmoji(guildId, emoji.key);
  if (other && other.code !== code) {
    throw new UserError(`Cette réaction est déjà utilisée par la catégorie **${other.code}** (${other.label}).`);
  }

  const existing = store.getCategory(guildId, code);
  store.upsertCategory({
    guild_id: guildId,
    code,
    label,
    emoji_key: emoji.key,
    emoji_display: emoji.display,
    color: color ?? existing?.color ?? null,
  });
  return { created: !existing, category: store.getCategory(guildId, code) };
}

export function removeCategory(guildId, rawCode) {
  return store.deleteCategory(guildId, String(rawCode ?? '').trim().toUpperCase());
}

/* ───────────── Auteurs ───────────── */

export function excludeAuthor(guildId, rawName) {
  const name = String(rawName ?? '').trim();
  if (!name) throw new UserError('Nom vide.');
  store.excludeAuthor(guildId, name);
  return name;
}

export function includeAuthor(guildId, rawName) {
  const name = String(rawName ?? '').trim();
  if (!name) throw new UserError('Nom vide.');
  return store.includeAuthor(guildId, name);
}

/* ───────────── Réaction « à trier » ───────────── */

export function setSortEmoji(guild, raw) {
  const emoji = resolveEmoji(guild, raw);
  if (!emoji) throw new UserError('Emoji invalide. Exemples : `🚮`, `📥`, `:nom_emoji_du_serveur:`.');
  const cat = store.findCategoryByEmoji(guild.id, emoji.key);
  if (cat) throw new UserError(`${emoji.display} est déjà la réaction de la catégorie **${cat.code}** (${cat.label}).`);
  store.setSortEmoji(guild.id, emoji.key, emoji.display);
  return emoji;
}
