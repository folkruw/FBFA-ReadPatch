import { EmbedBuilder, MessageFlags } from 'discord.js';
import * as store from '../db.js';
import { discordTs, parseDateInput } from '../dates.js';
import { UserError } from '../errors.js';
import { backfillGuild, syncGuild } from '../scanner.js';
import { NO_CHANNEL_MSG, visibleChannelIds } from './common.js';

export async function handleResume(interaction) {
  const guildId = interaction.guildId;
  store.ensureGuild(guildId);
  const since = parseDateInput(interaction.options.getString('depuis'));
  if (!store.getChannels(guildId).length) throw new UserError(NO_CHANNEL_MSG);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (since != null) await backfillGuild(interaction.client, guildId, since);

  const channelIds = visibleChannelIds(interaction);
  const lines = store.getCategories(guildId).map((c) => {
    const { total, unseen } = store.countMessages({ guildId, code: c.code, since, channelIds });
    const status = unseen ? `**${unseen}** à traiter` : '✅ rien à traiter';
    return `${c.emoji_display} **${c.label}** (\`${c.code}\`) — ${status} · ${total} au total`;
  });

  const toSort = store.countToSort({ guildId, since, channelIds });
  if (toSort.embeds) {
    lines.push(
      '',
      `${store.getSortEmoji(guildId).display} **${toSort.embeds}** embed(s) à trier dans ${toSort.messages} message(s) → \`/trier\``,
    );
  }

  const embed = new EmbedBuilder()
    .setTitle('📊 Résumé')
    .setColor(0x5865f2)
    .setDescription(lines.join('\n') || '*Aucune catégorie configurée.*')
    .setFooter({ text: 'Détail : /liste categorie:<code>' });
  if (since != null) embed.setTitle(`📊 Résumé depuis le ${new Date(since).toLocaleDateString('fr-FR')}`);
  await interaction.editReply({ embeds: [embed] });
}

export async function handleSync(interaction) {
  const guildId = interaction.guildId;
  store.ensureGuild(guildId);
  const since = parseDateInput(interaction.options.getString('depuis'));
  if (!store.getChannels(guildId).length) throw new UserError(NO_CHANNEL_MSG);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const results = await syncGuild(interaction.client, guildId, since);
  const lines = results.map((r) =>
    r.error
      ? `❌ <#${r.channelId}> : ${r.error}`
      : `✅ <#${r.channelId}> : ${r.read} lus, **${r.stored}** avec réaction(s), ${r.pruned} supprimé(s) de la base`,
  );
  const header = since != null ? `🔄 Synchronisation depuis le ${discordTs(since)}` : '🔄 Synchronisation terminée';
  await interaction.editReply(`${header}\n${lines.join('\n')}`.slice(0, 2000));
}
