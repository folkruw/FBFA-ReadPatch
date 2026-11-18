import { PermissionFlagsBits } from 'discord.js';
import * as store from './db.js';
import { emojiKeyOf } from './emoji.js';
import { UserError } from './errors.js';

const embedType = (e) => e?.data?.type ?? e?.type ?? 'rich';

/**
 * Transforme un message Discord en lignes de base de données : le message, CHAQUE embed, les réactions.
 * Retourne null s'il n'y a rien à lire (ni embed ni texte).
 * (Un message sans réaction est quand même renvoyé : c'est saveMessages qui décide de l'oublier.)
 */
export function extractMessage(msg) {
  const reactions = [];
  for (const r of msg.reactions?.cache?.values?.() ?? []) {
    const key = emojiKeyOf(r.emoji);
    if (key && r.count > 0) reactions.push({ key, count: r.count });
  }

  // Embeds « riches » (ceux des webhooks/bots) ; à défaut le texte du message.
  const rich = (msg.embeds ?? []).filter((e) => embedType(e) === 'rich');
  const sources = rich.length ? rich : msg.content ? [null] : [];
  if (!sources.length) return null;

  const fallbackAuthor = msg.member?.displayName || msg.author?.globalName || msg.author?.username || 'Inconnu';
  const embeds = sources.map((embed, idx) => {
    let description = embed ? (embed.description ?? '') : msg.content;
    if (embed?.fields?.length) {
      const fields = embed.fields.map((f) => `**${f.name}**\n${f.value}`).join('\n');
      description = description ? `${description}\n\n${fields}` : fields;
    }
    // Auteur = l'auteur de l'embed (« william »), sinon celui qui a posté le message.
    const author = (embed?.author?.name || fallbackAuthor).trim().slice(0, 100) || 'Inconnu';
    return {
      message_id: msg.id,
      idx,
      author,
      author_lc: author.toLowerCase(),
      author_icon: embed?.author?.iconURL ?? embed?.author?.icon_url ?? null,
      title: embed?.title ?? null,
      description: description || null,
      footer: embed?.footer?.text ?? null,
      url: embed?.url ?? null,
      color: embed?.color ?? null,
    };
  });

  return {
    data: {
      message_id: msg.id,
      guild_id: msg.guildId,
      channel_id: msg.channelId,
      embed_count: embeds.length,
      created_at: msg.createdTimestamp,
      updated_at: Date.now(),
    },
    embeds,
    reactions,
  };
}

/* File d'attente par salon : jamais deux scans du même salon en parallèle. */
const queues = new Map();
function enqueue(key, fn) {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, next);
  next
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    })
    .catch(() => {});
  return next;
}

export function checkChannelAccess(channel, me) {
  const perms = channel.permissionsFor(me);
  const missing = [];
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) missing.push('Voir le salon');
  if (!perms?.has(PermissionFlagsBits.ReadMessageHistory)) missing.push("Voir l'historique des messages");
  if (missing.length) throw new UserError(`Il me manque des permissions dans ${channel} : ${missing.join(', ')}.`);
}

/**
 * Parcourt l'historique du salon jusqu'à `sinceMs` et met la base à jour :
 * messages avec réaction(s) enregistrés, réactions retirées / messages supprimés nettoyés.
 */
export function scanChannel(channel, sinceMs) {
  return enqueue(channel.id, async () => {
    const startedAt = Date.now();
    const keep = new Set();
    let before;
    let read = 0;
    let stored = 0;

    for (;;) {
      const batch = await channel.messages.fetch({ limit: 100, before, cache: false });
      if (batch.size === 0) break;

      const ops = [];
      let oldest = null;
      let reachedLimit = false;
      for (const msg of batch.values()) {
        if (oldest === null || BigInt(msg.id) < BigInt(oldest)) oldest = msg.id;
        if (msg.createdTimestamp < sinceMs) {
          reachedLimit = true;
          continue;
        }
        read++;
        keep.add(msg.id);
        const row = extractMessage(msg);
        if (row) {
          ops.push(row);
          if (row.reactions.length) stored++;
        } else {
          ops.push({ deleteId: msg.id });
        }
      }
      store.saveMessages(ops);

      if (reachedLimit || batch.size < 100) break;
      before = oldest;
    }

    const pruned = store.pruneChannel(channel.id, sinceMs, startedAt, keep);
    store.updateScannedSince(channel.id, sinceMs);
    return { read, stored, pruned };
  });
}

async function resolveChannel(client, channelId) {
  return client.channels.cache.get(channelId) ?? client.channels.fetch(channelId);
}

/** Complète l'historique des salons du serveur si on demande une date plus ancienne que ce qui a été lu. */
export async function backfillGuild(client, guildId, since) {
  for (const ch of store.getChannels(guildId)) {
    if (ch.scanned_since <= since) continue;
    const channel = await resolveChannel(client, ch.channel_id).catch(() => null);
    if (!channel) continue;
    await scanChannel(channel, since);
  }
}

/** Relit tous les salons du serveur (depuis `since`, ou depuis ce qui a déjà été lu). */
export async function syncGuild(client, guildId, since = null) {
  const results = [];
  for (const ch of store.getChannels(guildId)) {
    try {
      const channel = await resolveChannel(client, ch.channel_id);
      const r = await scanChannel(channel, since ?? ch.scanned_since);
      results.push({ channelId: ch.channel_id, ...r });
    } catch (err) {
      results.push({ channelId: ch.channel_id, error: err.message });
    }
  }
  return results;
}

/** Au démarrage : rattrape les réactions ajoutées/retirées pendant que le bot était éteint. */
export async function startupSync(client) {
  const days = Number(process.env.STARTUP_RESCAN_DAYS || 0);
  for (const ch of store.getAllChannels()) {
    if (!client.guilds.cache.has(ch.guild_id)) continue;
    const since = days > 0 ? Math.max(ch.scanned_since, Date.now() - days * 86_400_000) : ch.scanned_since;
    try {
      const channel = await resolveChannel(client, ch.channel_id);
      const r = await scanChannel(channel, since);
      console.log(`[sync] #${channel.name} : ${r.read} lus, ${r.stored} avec réaction(s), ${r.pruned} nettoyés`);
    } catch (err) {
      console.warn(`[sync] salon ${ch.channel_id} : ${err.message}`);
    }
  }
}

/* Mise à jour en direct quand une réaction est ajoutée/retirée (regroupée sur 1 s). */
const pending = new Map();
export function refreshMessage(client, channelId, messageId) {
  if (!store.isWatched(channelId)) return;
  clearTimeout(pending.get(messageId));
  pending.set(
    messageId,
    setTimeout(async () => {
      pending.delete(messageId);
      try {
        const channel = await resolveChannel(client, channelId);
        const msg = await channel.messages.fetch({ message: messageId, force: true, cache: false });
        store.saveMessages([extractMessage(msg) ?? { deleteId: messageId }]);
      } catch (err) {
        if (err.code === 10008) store.deleteMessages([messageId]); // Unknown Message
        else console.error(`[live] message ${messageId} :`, err.message);
      }
    }, 1000),
  );
}
