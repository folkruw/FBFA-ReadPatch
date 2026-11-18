import crypto from 'node:crypto';
import { EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import * as store from '../db.js';

export const EPH = { flags: MessageFlags.Ephemeral };
export const NO_CHANNEL_MSG = "Aucun salon n'est surveillé. Il faut d'abord faire `/config salon ajouter`.";

const EMBED_BUDGET = 5600; // Discord : 6000 caractères max pour l'ensemble des embeds d'un message
const SESSION_TTL = 12 * 3600_000;

export const truncate = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

/*
 * Une « session » = une vue ouverte par un utilisateur (/liste ou /trier) avec ses filtres.
 * La liste des éléments est figée à l'ouverture / à l'actualisation : cocher ou trier un élément
 * ne le fait pas disparaître tout de suite (pas de décalage des pages), il part au prochain 🔄.
 */
const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL) sessions.delete(id);
}, 15 * 60_000).unref();

export function saveSession(params) {
  const s = { id: crypto.randomBytes(5).toString('hex'), page: 0, ids: [], touched: Date.now(), ...params };
  sessions.set(s.id, s);
  return s;
}

/** Retrouve la session d'un bouton/menu, ou répond « expirée » et retourne null. */
export async function getSession(interaction, kind, sid) {
  const s = sessions.get(sid);
  if (!s || s.kind !== kind || s.userId !== interaction.user.id) {
    await interaction.reply({
      content: `⌛ Cette vue a expiré (bot redémarré ou inactivité). Relance \`/${kind}\`.`,
      ...EPH,
    });
    return null;
  }
  s.touched = Date.now();
  return s;
}

const READ_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

/** Le membre peut-il lire ce salon (voir le salon + son historique) ? */
export function memberCanRead(interaction, channel) {
  return !!channel?.permissionsFor(interaction.member ?? interaction.user)?.has(READ_PERMS);
}

/** Salons surveillés que le membre peut lire : on ne lui montre jamais le contenu des autres. */
export function visibleChannelIds(interaction) {
  return store
    .getChannels(interaction.guildId)
    .filter((ch) => memberCanRead(interaction, interaction.guild?.channels.cache.get(ch.channel_id)))
    .map((ch) => ch.channel_id);
}

export const userName = (interaction) =>
  interaction.member?.displayName ?? interaction.user.displayName ?? interaction.user.username;

export const jumpUrl = (item) => `https://discord.com/channels/${item.guild_id}/${item.channel_id}/${item.message_id}`;

/**
 * Construit les embeds d'une page. entries = [{ item, title, color, footer }]
 * Le budget de caractères restant est réparti entre les descriptions.
 */
export function buildItemEmbeds(entries) {
  const prepared = entries.map((en) => {
    const jump = jumpUrl(en.item);
    return {
      ...en,
      jump,
      title: truncate(en.title, 256),
      author: truncate(en.item.author, 256),
      footer: truncate(en.footer ?? '', 2048),
      links: `\n\n[↪ Voir le message](${jump})${en.item.url ? ` · [🔗 Lien](${en.item.url})` : ''}`,
    };
  });
  const fixed = prepared.reduce((sum, p) => sum + p.title.length + p.author.length + p.footer.length + p.links.length, 0);
  const perDesc = Math.max(100, Math.floor((EMBED_BUDGET - fixed) / Math.max(1, prepared.length)));

  // Discord fusionne les embeds qui ont la même URL de titre (galerie d'images) et n'en affiche
  // qu'un : les embeds d'un même message auraient tous le même lien. Chaque titre reçoit donc
  // une URL différente (lien du message, sinon lien de l'embed, sinon aucune).
  const usedUrls = new Set();
  return prepared.map((p) => {
    const url = [p.jump, p.item.url].find((u) => u && !usedUrls.has(u));
    if (url) usedUrls.add(url);
    const e = new EmbedBuilder()
      .setColor(p.color)
      .setTitle(p.title)
      .setAuthor({ name: p.author, iconURL: p.item.author_icon || undefined })
      .setDescription(truncate(p.item.description || '*Pas de description*', Math.min(perDesc, 4000)) + p.links)
      .setTimestamp(p.item.created_at);
    if (url) e.setURL(url);
    if (p.footer) e.setFooter({ text: p.footer });
    return e;
  });
}

/** « Embed 2/3 » si le message en contient plusieurs. */
export const embedPosition = (item) => (item.embed_count > 1 ? `Embed ${item.idx + 1}/${item.embed_count}` : null);
