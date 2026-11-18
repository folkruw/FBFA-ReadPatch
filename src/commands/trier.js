import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import * as store from '../db.js';
import { parseDateInput } from '../dates.js';
import { UserError } from '../errors.js';
import { backfillGuild } from '../scanner.js';
import {
  EPH,
  NO_CHANNEL_MSG,
  buildItemEmbeds,
  embedPosition,
  getSession,
  saveSession,
  refreshVisibility,
  truncate,
  userName,
  visibleChannelIds,
} from './common.js';

export const SORT_PAGE_SIZE = 4; // 4 menus (un par embed) + 1 ligne de navigation = 5 lignes max
const IGNORE = '__ignore';
const PENDING_COLOR = 0x99aab5;
const IGNORED_COLOR = 0x4f545c;
const DEFAULT_COLOR = 0x5865f2;

export function createSortSession(params) {
  const s = saveSession({ kind: 'trier', since: null, until: null, includeSorted: false, ...params });
  s.ids = store.querySortIds(s);
  return s;
}

function reload(s, { resetPage = false } = {}) {
  s.ids = store.querySortIds(s);
  if (resetPage) s.page = 0;
}

/* ───────────── /trier ───────────── */

export async function handleTrier(interaction) {
  const guildId = interaction.guildId;
  store.ensureGuild(guildId);
  if (!store.getChannels(guildId).length) throw new UserError(NO_CHANNEL_MSG);
  if (!store.getCategories(guildId).length) throw new UserError('Aucune catégorie : crée-en avec `/config categorie ajouter`.');
  const since = parseDateInput(interaction.options.getString('depuis'));

  await interaction.deferReply(EPH);
  if (since != null) await backfillGuild(interaction.client, guildId, since);

  const s = createSortSession({
    guildId,
    userId: interaction.user.id,
    since,
    includeSorted: interaction.options.getBoolean('tous') ?? false,
    channelIds: visibleChannelIds(interaction),
  });
  await interaction.editReply(buildSortView(s));
}

/* ───────────── Menus / boutons ───────────── */

export async function handleTrierComponent(interaction) {
  const [, sid, action, arg] = interaction.customId.split(':');
  const s = await getSession(interaction, 'trier', sid);
  if (!s) return;
  if (refreshVisibility(interaction, s)) reload(s); // droits modifiés : on retire ce qui n'est plus visible

  switch (action) {
    case 's': {
      // Choix des catégories d'un embed. Menu vidé = remis « à trier ».
      if (!s.ids.includes(arg)) break;
      const values = interaction.values ?? [];
      const codes = values.filter((v) => v !== IGNORE && store.getCategory(s.guildId, v));
      if (!values.length) store.unsetSort(arg);
      else store.setSort(arg, codes, interaction.user.id, userName(interaction));
      break;
    }
    case 'prev':
      s.page--;
      break;
    case 'next':
      s.page++;
      break;
    case 'sorted':
      s.includeSorted = !s.includeSorted;
      reload(s, { resetPage: true });
      break;
    case 'refresh':
      reload(s);
      break;
    default:
      break;
  }
  await interaction.update(buildSortView(s));
}

/* ───────────── Rendu ───────────── */

export function buildSortView(s) {
  const sortEmoji = store.getSortEmoji(s.guildId);
  const cats = store.getCategories(s.guildId);
  const catByCode = new Map(cats.map((c) => [c.code, c]));
  const pages = Math.max(1, Math.ceil(s.ids.length / SORT_PAGE_SIZE));
  s.page = Math.min(Math.max(0, s.page), pages - 1);
  const pageIds = s.ids.slice(s.page * SORT_PAGE_SIZE, (s.page + 1) * SORT_PAGE_SIZE);
  const items = store.getItems(pageIds);
  const info = store.describeItems(s.guildId, items);
  const remaining = store.countToSort(s);

  const lines = [
    `## ${sortEmoji.display} À trier`,
    `**${remaining.embeds}** embed(s) à trier dans **${remaining.messages}** message(s) · page ${s.page + 1}/${pages}`,
    '-# Choisis la ou les catégories de chaque embed dans son menu (ou « Ignorer »). Vider un menu = le remettre à trier.',
  ];
  if (!items.length) {
    lines.push(
      '',
      `✨ Rien à trier ! Mets la réaction ${sortEmoji.display} sur un message pour répartir ses embeds ici.`,
    );
  }

  const number = (i) => s.page * SORT_PAGE_SIZE + i + 1;
  const embeds = buildItemEmbeds(
    items.map((item, i) => {
      const d = info.get(item.key);
      let status;
      if (d.sorted) {
        status = d.codes.length ? `Rangé dans : ${d.codes.join(', ')}` : 'Ignoré';
        if (item.sorted_by_name) status += ` (par ${item.sorted_by_name})`;
      } else if (d.suggested.length) {
        status = `Réactions sur le message : ${d.suggested.join(', ')}`;
      }
      return {
        item,
        title: `${d.sorted ? (d.codes.length ? '✅' : '🗑️') : sortEmoji.display} #${number(i)} · ${item.title || 'Sans titre'}`,
        color: d.sorted
          ? d.codes.length
            ? (catByCode.get(d.codes[0])?.color ?? DEFAULT_COLOR)
            : IGNORED_COLOR
          : PENDING_COLOR,
        footer: [item.footer, embedPosition(item), status].filter(Boolean).join('  •  '),
      };
    }),
  );

  const components = items.map((item, i) => {
    const d = info.get(item.key);
    const placeholder = d.suggested.length
      ? `#${number(i)} — catégorie(s) ? (réactions : ${d.suggested.join(', ')})`
      : `#${number(i)} — choisir la ou les catégories…`;
    const options = cats.slice(0, 24).map((c) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(truncate(`${c.code} — ${c.label}`, 100))
        .setValue(c.code)
        .setEmoji(c.emoji_display)
        .setDefault(d.sorted && d.codes.includes(c.code)),
    );
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('Ignorer (aucune catégorie)')
        .setValue(IGNORE)
        .setEmoji('🗑️')
        .setDefault(d.sorted && d.codes.length === 0),
    );
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`lt:${s.id}:s:${item.key}`)
        .setPlaceholder(truncate(placeholder, 150))
        .setMinValues(0)
        .setMaxValues(options.length)
        .addOptions(options),
    );
  });

  const btn = (action) => new ButtonBuilder().setCustomId(`lt:${s.id}:${action}`);
  components.push(
    new ActionRowBuilder().addComponents(
      btn('prev').setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(s.page === 0),
      btn('noop').setLabel(`Page ${s.page + 1}/${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      btn('next').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(s.page >= pages - 1),
      btn('sorted')
        .setEmoji(s.includeSorted ? '👁️' : '🙈')
        .setLabel(s.includeSorted ? 'Déjà triés affichés' : 'Déjà triés masqués')
        .setStyle(ButtonStyle.Secondary),
      btn('refresh').setEmoji('🔄').setLabel('Actualiser').setStyle(ButtonStyle.Secondary),
    ),
  );

  return { content: truncate(lines.join('\n'), 2000), embeds, components };
}
