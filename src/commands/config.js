import { EmbedBuilder, MessageFlags } from 'discord.js';
import * as store from '../db.js';
import * as actions from '../actions.js';
import { memberCanRead } from './common.js';
import { discordTs, parseDateInput } from '../dates.js';
import { UserError } from '../errors.js';

const EPH = { flags: MessageFlags.Ephemeral };
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function handleConfig(interaction) {
  store.ensureGuild(interaction.guildId);
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  switch (group ? `${group}.${sub}` : sub) {
    case 'voir':
      return showConfig(interaction);
    case 'tri':
      return setSortEmoji(interaction);
    case 'salon.ajouter':
      return addChannel(interaction);
    case 'salon.retirer':
      return removeChannel(interaction);
    case 'categorie.ajouter':
      return addCategory(interaction);
    case 'categorie.retirer':
      return removeCategory(interaction);
    case 'auteur.exclure':
      return excludeAuthor(interaction);
    case 'auteur.reinclure':
      return includeAuthor(interaction);
    default:
      throw new UserError('Sous-commande inconnue.');
  }
}

async function showConfig(interaction) {
  const guildId = interaction.guildId;
  const channels = store.getChannels(guildId);
  const cats = store.getCategories(guildId);
  const excluded = store.getExcludedAuthors(guildId);

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Configuration du bot de logs')
    .setColor(0x5865f2)
    .addFields(
      {
        name: '📺 Salons surveillés',
        value: truncate(
          channels.map((c) => `<#${c.channel_id}> — historique lu depuis le ${discordTs(c.scanned_since, 'd')}`).join('\n') ||
            '*Aucun — utilise `/config salon ajouter`*',
          1024,
        ),
      },
      {
        name: '🏷️ Catégories (réaction → catégorie)',
        value: truncate(cats.map((c) => `${c.emoji_display} **${c.code}** — ${c.label}`).join('\n') || '*Aucune*', 1024),
      },
      {
        name: '🗂️ Réaction « à trier »',
        value: `${store.getSortEmoji(guildId).display} — ses embeds se répartissent avec \`/trier\``,
      },
      {
        name: '🚫 Auteurs exclus',
        value: truncate(excluded.map((a) => a.name).join(', ') || '*Aucun*', 1024),
      },
    );
  await interaction.reply({ embeds: [embed], ...EPH });
}

async function addChannel(interaction) {
  const option = interaction.options.getChannel('salon', true);
  const since = parseDateInput(interaction.options.getString('depuis') ?? '30j');
  const channel = await actions.resolveTextChannel(interaction.guild, option.id);
  if (!memberCanRead(interaction, channel)) {
    throw new UserError(`Tu dois pouvoir lire ${channel} toi-même pour le faire surveiller.`);
  }

  await interaction.deferReply(EPH);
  const result = await actions.watchChannel(interaction.guild, channel, since);
  await interaction.editReply(
    `✅ ${channel} ${result.isNew ? 'est maintenant surveillé' : 'était déjà surveillé, historique complété'}.\n` +
      `📥 ${result.read} message(s) lus depuis le ${discordTs(since)}, dont **${result.stored}** avec réaction(s).`,
  );
}

async function removeChannel(interaction) {
  const channel = interaction.options.getChannel('salon', true);
  const removed = actions.unwatchChannel(interaction.guildId, channel.id);
  await interaction.reply({
    content: removed ? `🗑️ ${channel} n'est plus surveillé.` : `ℹ️ ${channel} n'était pas surveillé.`,
    ...EPH,
  });
}

async function setSortEmoji(interaction) {
  const emoji = actions.setSortEmoji(interaction.guild, interaction.options.getString('emoji', true));
  await interaction.reply({
    content: `✅ Réaction « à trier » : ${emoji.display}. Les messages qui la portent se trient avec \`/trier\`.`,
    ...EPH,
  });
}

async function addCategory(interaction) {
  const { created, category: c } = actions.saveCategory(interaction.guild, {
    code: interaction.options.getString('code', true),
    label: interaction.options.getString('libelle', true),
    emoji: interaction.options.getString('emoji', true),
    color: interaction.options.getString('couleur'),
  });
  await interaction.reply({
    content: `${created ? '✅ Catégorie créée' : '✏️ Catégorie modifiée'} : ${c.emoji_display} **${c.code}** — ${c.label}`,
    ...EPH,
  });
}

async function removeCategory(interaction) {
  const code = interaction.options.getString('code', true).trim().toUpperCase();
  const removed = actions.removeCategory(interaction.guildId, code);
  await interaction.reply({
    content: removed ? `🗑️ Catégorie **${code}** supprimée.` : `ℹ️ La catégorie **${code}** n'existe pas.`,
    ...EPH,
  });
}

async function excludeAuthor(interaction) {
  const name = actions.excludeAuthor(interaction.guildId, interaction.options.getString('nom', true));
  await interaction.reply({
    content: `🚫 Les messages de **${name}** ne seront plus affichés. (\`/config auteur reinclure\` pour annuler)`,
    ...EPH,
  });
}

async function includeAuthor(interaction) {
  const name = interaction.options.getString('nom', true).trim();
  const ok = actions.includeAuthor(interaction.guildId, name);
  await interaction.reply({
    content: ok ? `✅ Les messages de **${name}** sont de nouveau affichés.` : `ℹ️ **${name}** n'était pas exclu.`,
    ...EPH,
  });
}
