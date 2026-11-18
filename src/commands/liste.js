import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import * as store from '../db.js';
import { discordTs, parseDateInput } from '../dates.js';
import { UserError } from '../errors.js';
import { backfillGuild } from '../scanner.js';
import {
  EPH,
  NO_CHANNEL_MSG,
  buildItemEmbeds,
  embedPosition,
  getSession,
  saveSession,
  truncate,
  userName,
} from './common.js';

export const PAGE_SIZE = 5;
const SEEN_COLOR = 0x57f287;
const DEFAULT_COLOR = 0x5865f2;

export function createSession(params) {
  const s = saveSession({
    kind: 'liste',
    authors: [],
    showSeen: false,
    order: 'asc',
    since: null,
    until: null,
    ...params,
  });
  s.ids = store.queryIds(s);
  return s;
}

function reload(s, { resetPage = false } = {}) {
  s.ids = store.queryIds(s);
  if (resetPage) s.page = 0;
}

/* ───────────── /liste ───────────── */

export async function handleListe(interaction) {
  const guildId = interaction.guildId;
  store.ensureGuild(guildId);

  const code = interaction.options.getString('categorie', true).trim().toUpperCase();
  if (!store.getCategory(guildId, code)) {
    const known = store.getCategories(guildId).map((c) => `\`${c.code}\``).join(', ') || 'aucune';
    throw new UserError(`Catégorie \`${code}\` inconnue. Catégories existantes : ${known}.`);
  }
  const since = parseDateInput(interaction.options.getString('depuis'));
  const until = parseDateInput(interaction.options.getString('jusqua'), { endOfDay: true });
  if (since != null && until != null && until < since) throw new UserError('La date de fin est avant la date de début.');
  if (!store.getChannels(guildId).length) throw new UserError(NO_CHANNEL_MSG);
  const author = interaction.options.getString('auteur')?.trim();

  await interaction.deferReply(EPH);
  if (since != null) await backfillGuild(interaction.client, guildId, since);

  const s = createSession({
    guildId,
    userId: interaction.user.id,
    code,
    since,
    until,
    authors: author ? [author.toLowerCase()] : [],
    showSeen: interaction.options.getBoolean('vus') ?? false,
    order: interaction.options.getString('ordre') ?? 'asc',
  });
  await interaction.editReply(buildView(s));
}

/* ───────────── Boutons / menus ───────────── */

export async function handleListeComponent(interaction) {
  const [, sid, action, arg] = interaction.customId.split(':');
  const s = await getSession(interaction, 'liste', sid);
  if (!s) return;
  const name = userName(interaction);
  const pageIds = () => s.ids.slice(s.page * PAGE_SIZE, (s.page + 1) * PAGE_SIZE);

  switch (action) {
    case 't': // case à cocher d'un embed
      if (s.ids.includes(arg)) {
        if (store.isSeen(arg, s.code)) store.unsetSeen(arg, s.code);
        else store.setSeen(arg, s.code, interaction.user.id, name);
      }
      break;
    case 'all':
      for (const key of pageIds()) store.setSeen(key, s.code, interaction.user.id, name);
      break;
    case 'none':
      for (const key of pageIds()) store.unsetSeen(key, s.code);
      break;
    case 'prev':
      s.page--;
      break;
    case 'next':
      s.page++;
      break;
    case 'seen':
      s.showSeen = !s.showSeen;
      reload(s, { resetPage: true });
      break;
    case 'refresh':
      reload(s);
      break;
    case 'cat':
      if (interaction.values?.[0]) s.code = interaction.values[0];
      reload(s, { resetPage: true });
      break;
    case 'auth':
      s.authors = interaction.values ?? [];
      reload(s, { resetPage: true });
      break;
    default:
      break;
  }
  await interaction.update(buildView(s));
}

/* ───────────── Rendu ───────────── */

export function buildView(s) {
  const cat = store.getCategory(s.guildId, s.code);
  if (!cat) {
    return { content: `❌ La catégorie \`${s.code}\` n'existe plus. Relance \`/liste\`.`, embeds: [], components: [] };
  }

  const pages = Math.max(1, Math.ceil(s.ids.length / PAGE_SIZE));
  s.page = Math.min(Math.max(0, s.page), pages - 1);
  const pageIds = s.ids.slice(s.page * PAGE_SIZE, (s.page + 1) * PAGE_SIZE);
  const items = store.getItems(pageIds, s.code);
  const info = store.describeItems(s.guildId, items);
  const counts = store.countMessages(s);
  const authorOptions = store.authorsForFilter(s);
  const authorNames = new Map(authorOptions.map((a) => [a.author_lc, a.author]));
  const toSort = store.countToSort(s);

  // En-tête
  const filters = [
    s.since != null ? `📅 du ${discordTs(s.since)}` : '📅 depuis le début',
    s.until != null ? `au ${discordTs(s.until)}` : null,
    s.authors.length ? `👤 ${s.authors.map((a) => authorNames.get(a) ?? a).join(', ')}` : '👤 tous les auteurs',
    s.showSeen ? '👁️ déjà vus affichés' : '🙈 déjà vus masqués',
  ].filter(Boolean);
  const lines = [
    `## ${cat.emoji_display} ${cat.label} (${cat.code})`,
    filters.join(' · '),
    `**${counts.unseen}** à traiter sur **${counts.total}** · ${s.ids.length} dans cette liste · page ${s.page + 1}/${pages}`,
  ];
  if (toSort.embeds) {
    lines.push(`-# ${store.getSortEmoji(s.guildId).display} ${toSort.embeds} embed(s) attendent d'être triés : \`/trier\``);
  }
  if (!items.length) {
    lines.push(
      '',
      counts.total && !s.showSeen
        ? '✨ Tout est déjà vu ! (bouton « Déjà vus masqués » pour les réafficher)'
        : '✨ Aucun message pour cette catégorie avec ces filtres.',
    );
  }

  const embeds = buildItemEmbeds(
    items.map((item, i) => {
      const seen = item.seen_at != null;
      const codes = info.get(item.key)?.codes ?? [];
      return {
        item,
        title: `${seen ? '✅' : '⬜'} #${s.page * PAGE_SIZE + i + 1} · ${item.title || 'Sans titre'}`,
        color: seen ? SEEN_COLOR : (cat.color ?? item.color ?? DEFAULT_COLOR),
        footer: [
          item.footer,
          embedPosition(item),
          codes.length && `Catégories : ${codes.join(', ')}`,
          seen && `Vu par ${item.seen_by_name ?? '?'}`,
        ]
          .filter(Boolean)
          .join('  •  '),
      };
    }),
  );

  return {
    content: truncate(lines.join('\n'), 2000),
    embeds,
    components: buildComponents(s, items, pages, authorOptions),
  };
}

function buildComponents(s, items, pages, authorOptions) {
  const btn = (action) => new ButtonBuilder().setCustomId(`lv:${s.id}:${action}`);
  const components = [];

  // 1. Cases à cocher « déjà vu »
  if (items.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        items.map((item, i) =>
          btn(`t:${item.key}`)
            .setLabel(`#${s.page * PAGE_SIZE + i + 1}`)
            .setEmoji(item.seen_at != null ? '✅' : '⬜')
            .setStyle(item.seen_at != null ? ButtonStyle.Success : ButtonStyle.Secondary),
        ),
      ),
    );
  }

  // 2. Navigation
  components.push(
    new ActionRowBuilder().addComponents(
      btn('prev').setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(s.page === 0),
      btn('noop').setLabel(`Page ${s.page + 1}/${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      btn('next').setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(s.page >= pages - 1),
      btn('seen')
        .setEmoji(s.showSeen ? '👁️' : '🙈')
        .setLabel(s.showSeen ? 'Déjà vus affichés' : 'Déjà vus masqués')
        .setStyle(ButtonStyle.Secondary),
      btn('refresh').setEmoji('🔄').setLabel('Actualiser').setStyle(ButtonStyle.Secondary),
    ),
  );

  // 3. Tout cocher / décocher
  if (items.length) {
    const allSeen = items.every((r) => r.seen_at != null);
    const noneSeen = items.every((r) => r.seen_at == null);
    components.push(
      new ActionRowBuilder().addComponents(
        btn('all').setEmoji('☑️').setLabel('Tout cocher (page)').setStyle(ButtonStyle.Success).setDisabled(allSeen),
        btn('none').setEmoji('⬜').setLabel('Tout décocher (page)').setStyle(ButtonStyle.Secondary).setDisabled(noneSeen),
      ),
    );
  }

  // 4. Changer de catégorie
  const cats = store.getCategories(s.guildId).slice(0, 25);
  if (cats.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`lv:${s.id}:cat`)
          .setPlaceholder('Catégorie')
          .addOptions(
            cats.map((c) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(truncate(`${c.code} — ${c.label}`, 100))
                .setValue(c.code)
                .setEmoji(c.emoji_display)
                .setDefault(c.code === s.code),
            ),
          ),
      ),
    );
  }

  // 5. Filtrer par auteur (plusieurs choix possibles, aucun = tous)
  const options = [...authorOptions];
  for (const lc of s.authors) {
    if (!options.some((a) => a.author_lc === lc)) options.push({ author: lc, author_lc: lc, n: 0 });
  }
  const authorList = options.slice(0, 25);
  if (authorList.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`lv:${s.id}:auth`)
          .setPlaceholder('👤 Filtrer par auteur (tous)')
          .setMinValues(0)
          .setMaxValues(authorList.length)
          .addOptions(
            authorList.map((a) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(truncate(a.author, 100))
                .setValue(a.author_lc.slice(0, 100))
                .setDescription(`${a.n} embed(s)`)
                .setDefault(s.authors.includes(a.author_lc)),
            ),
          ),
      ),
    );
  }

  return components;
}
