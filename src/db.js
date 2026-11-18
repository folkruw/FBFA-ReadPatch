import { ROOT } from './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { regionalIndicator } from './emoji.js';

const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || 'data/bot.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');

/** Réaction « à trier » par défaut : 🚮 */
export const SORT_EMOJI_DEFAULT = String.fromCodePoint(0x1f6ae);

/*
 * Un « élément » = un embed d'un message (clé "messageId.index").
 * Un élément appartient à une catégorie si :
 *  - il a été trié avec /trier → les catégories choisies ;
 *  - sinon, le message porte la réaction de la catégorie ET ne porte pas la réaction « à trier ».
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS guilds (
  guild_id           TEXT PRIMARY KEY,
  created_at         INTEGER NOT NULL,
  sort_emoji_key     TEXT,
  sort_emoji_display TEXT
);

-- Salons surveillés. scanned_since = date la plus ancienne déjà parcourue.
CREATE TABLE IF NOT EXISTS channels (
  channel_id    TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL,
  scanned_since INTEGER NOT NULL,
  added_at      INTEGER NOT NULL
);

-- Catégories = une réaction (R, G, M…)
CREATE TABLE IF NOT EXISTS categories (
  guild_id      TEXT NOT NULL,
  code          TEXT NOT NULL,
  label         TEXT NOT NULL,
  emoji_key     TEXT NOT NULL,
  emoji_display TEXT NOT NULL,
  color         INTEGER,
  PRIMARY KEY (guild_id, code)
);

CREATE TABLE IF NOT EXISTS excluded_authors (
  guild_id TEXT NOT NULL,
  name_lc  TEXT NOT NULL,
  name     TEXT NOT NULL,
  PRIMARY KEY (guild_id, name_lc)
);

-- Copie locale des messages qui ont au moins une réaction (reconstruite par les scans).
CREATE TABLE IF NOT EXISTS messages (
  message_id  TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  embed_count INTEGER NOT NULL,
  fingerprint TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_guild_date ON messages (guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel_date ON messages (channel_id, created_at);

CREATE TABLE IF NOT EXISTS embeds (
  message_id  TEXT NOT NULL REFERENCES messages (message_id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  author      TEXT NOT NULL,
  author_lc   TEXT NOT NULL,
  author_icon TEXT,
  title       TEXT,
  description TEXT,
  footer      TEXT,
  url         TEXT,
  color       INTEGER,
  PRIMARY KEY (message_id, idx)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages (message_id) ON DELETE CASCADE,
  emoji_key  TEXT NOT NULL,
  count      INTEGER NOT NULL,
  PRIMARY KEY (message_id, emoji_key)
);
CREATE INDEX IF NOT EXISTS idx_reactions_emoji ON message_reactions (emoji_key);

-- Données saisies par les utilisateurs (jamais effacées par un scan) --

-- « Déjà vu » : par embed ET par catégorie.
CREATE TABLE IF NOT EXISTS seen (
  message_id    TEXT NOT NULL,
  embed_idx     INTEGER NOT NULL,
  category_code TEXT NOT NULL,
  seen_by       TEXT NOT NULL,
  seen_by_name  TEXT,
  seen_at       INTEGER NOT NULL,
  PRIMARY KEY (message_id, embed_idx, category_code)
);

-- Tri manuel (/trier) : l'embed a été trié (éventuellement dans aucune catégorie = ignoré).
CREATE TABLE IF NOT EXISTS embed_sort (
  message_id     TEXT NOT NULL,
  embed_idx      INTEGER NOT NULL,
  sorted_by      TEXT NOT NULL,
  sorted_by_name TEXT,
  sorted_at      INTEGER NOT NULL,
  PRIMARY KEY (message_id, embed_idx)
);
CREATE TABLE IF NOT EXISTS embed_categories (
  message_id    TEXT NOT NULL,
  embed_idx     INTEGER NOT NULL,
  category_code TEXT NOT NULL,
  PRIMARY KEY (message_id, embed_idx, category_code)
);
`;

const MAX_TS = Number.MAX_SAFE_INTEGER;
const ph = (arr) => arr.map(() => '?').join(',');

let inTransaction = false;
export function transaction(fn) {
  if (inTransaction) return fn();
  inTransaction = true;
  sqlite.exec('BEGIN');
  try {
    const result = fn();
    sqlite.exec('COMMIT');
    return result;
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  } finally {
    inTransaction = false;
  }
}

/* ───────────── Migrations ───────────── */

const columns = (table) => sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

function migrate() {
  const { user_version: version } = sqlite.prepare('PRAGMA user_version').get();
  if (version < 1) {
    // v0 → v1 : un élément = un embed (et plus un message), réaction « à trier ».
    transaction(() => {
      // messages / réactions ne sont qu'un cache : ils seront relus au prochain scan.
      if (columns('messages').includes('author')) {
        sqlite.exec('DROP TABLE IF EXISTS message_reactions; DROP TABLE messages;');
      }
      const seenCols = columns('seen');
      const migrateSeen = seenCols.length > 0 && !seenCols.includes('embed_idx');
      if (migrateSeen) sqlite.exec('ALTER TABLE seen RENAME TO seen_v0;');
      const guildCols = columns('guilds');
      if (guildCols.length && !guildCols.includes('sort_emoji_key')) {
        sqlite.exec('ALTER TABLE guilds ADD COLUMN sort_emoji_key TEXT; ALTER TABLE guilds ADD COLUMN sort_emoji_display TEXT;');
      }
      sqlite.exec(SCHEMA);
      if (migrateSeen) {
        sqlite.exec(`
          INSERT OR IGNORE INTO seen (message_id, embed_idx, category_code, seen_by, seen_by_name, seen_at)
          SELECT message_id, 0, category_code, seen_by, seen_by_name, seen_at FROM seen_v0;
          DROP TABLE seen_v0;`);
      }
      sqlite
        .prepare('UPDATE guilds SET sort_emoji_key = ?, sort_emoji_display = ? WHERE sort_emoji_key IS NULL')
        .run(SORT_EMOJI_DEFAULT, SORT_EMOJI_DEFAULT);
      sqlite.exec('PRAGMA user_version = 1');
    });
  }
  if (version < 2) {
    // v1 → v2 : empreinte des messages (un rescan ne réécrit pas les messages inchangés).
    transaction(() => {
      sqlite.exec(SCHEMA);
      if (!columns('messages').includes('fingerprint')) sqlite.exec('ALTER TABLE messages ADD COLUMN fingerprint TEXT;');
      sqlite.exec('PRAGMA user_version = 2');
    });
  }
  sqlite.exec(SCHEMA);
}
migrate();

/*
 * Numéro de version des données : augmente à chaque modification réelle (scan, réaction, déjà vu,
 * tri, config). Basé sur l'horloge pour rester croissant après un redémarrage. Utilisé par l'API.
 */
let dataVersion = Date.now();
export const getVersion = () => dataVersion;
function bump() {
  dataVersion = Math.max(dataVersion + 1, Date.now());
}

/* ───────────── Requêtes préparées ───────────── */

const st = {
  getGuild: sqlite.prepare('SELECT * FROM guilds WHERE guild_id = ?'),
  insertGuild: sqlite.prepare(
    'INSERT OR IGNORE INTO guilds (guild_id, created_at, sort_emoji_key, sort_emoji_display) VALUES (?, ?, ?, ?)',
  ),
  setSortEmoji: sqlite.prepare('UPDATE guilds SET sort_emoji_key = ?, sort_emoji_display = ? WHERE guild_id = ?'),

  getChannel: sqlite.prepare('SELECT * FROM channels WHERE channel_id = ?'),
  getChannels: sqlite.prepare('SELECT * FROM channels WHERE guild_id = ? ORDER BY added_at'),
  getAllChannels: sqlite.prepare('SELECT * FROM channels ORDER BY added_at'),
  insertChannel: sqlite.prepare(
    'INSERT INTO channels (channel_id, guild_id, scanned_since, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (channel_id) DO NOTHING',
  ),
  setScannedSince: sqlite.prepare('UPDATE channels SET scanned_since = MIN(scanned_since, ?) WHERE channel_id = ?'),
  deleteChannel: sqlite.prepare('DELETE FROM channels WHERE channel_id = ?'),
  channelMessageIds: sqlite.prepare('SELECT message_id FROM messages WHERE channel_id = ?'),
  channelIdsInRange: sqlite.prepare(
    'SELECT message_id FROM messages WHERE channel_id = ? AND created_at >= ? AND created_at <= ?',
  ),

  getCategories: sqlite.prepare('SELECT * FROM categories WHERE guild_id = ? ORDER BY rowid'),
  getCategory: sqlite.prepare('SELECT * FROM categories WHERE guild_id = ? AND code = ?'),
  getCategoryByEmoji: sqlite.prepare('SELECT * FROM categories WHERE guild_id = ? AND emoji_key = ?'),
  upsertCategory: sqlite.prepare(`
    INSERT INTO categories (guild_id, code, label, emoji_key, emoji_display, color)
    VALUES (:guild_id, :code, :label, :emoji_key, :emoji_display, :color)
    ON CONFLICT (guild_id, code) DO UPDATE SET
      label = excluded.label, emoji_key = excluded.emoji_key,
      emoji_display = excluded.emoji_display, color = excluded.color`),
  deleteCategory: sqlite.prepare('DELETE FROM categories WHERE guild_id = ? AND code = ?'),

  getExcluded: sqlite.prepare('SELECT * FROM excluded_authors WHERE guild_id = ? ORDER BY name_lc'),
  excludeAuthor: sqlite.prepare('INSERT OR REPLACE INTO excluded_authors (guild_id, name_lc, name) VALUES (?, ?, ?)'),
  includeAuthor: sqlite.prepare('DELETE FROM excluded_authors WHERE guild_id = ? AND name_lc = ?'),

  hasMessage: sqlite.prepare('SELECT 1 AS ok FROM messages WHERE message_id = ?'),
  getFingerprint: sqlite.prepare('SELECT fingerprint FROM messages WHERE message_id = ?'),
  upsertMessage: sqlite.prepare(`
    INSERT INTO messages (message_id, guild_id, channel_id, embed_count, fingerprint, created_at, updated_at)
    VALUES (:message_id, :guild_id, :channel_id, :embed_count, :fingerprint, :created_at, :updated_at)
    ON CONFLICT (message_id) DO UPDATE SET
      embed_count = excluded.embed_count, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`),
  deleteMessage: sqlite.prepare('DELETE FROM messages WHERE message_id = ?'),
  deleteEmbeds: sqlite.prepare('DELETE FROM embeds WHERE message_id = ?'),
  insertEmbed: sqlite.prepare(`
    INSERT INTO embeds (message_id, idx, author, author_lc, author_icon, title, description, footer, url, color)
    VALUES (:message_id, :idx, :author, :author_lc, :author_icon, :title, :description, :footer, :url, :color)`),
  deleteReactions: sqlite.prepare('DELETE FROM message_reactions WHERE message_id = ?'),
  insertReaction: sqlite.prepare(
    'INSERT OR REPLACE INTO message_reactions (message_id, emoji_key, count) VALUES (?, ?, ?)',
  ),

  isSeen: sqlite.prepare('SELECT 1 AS ok FROM seen WHERE message_id = ? AND embed_idx = ? AND category_code = ?'),
  setSeen: sqlite.prepare(`
    INSERT INTO seen (message_id, embed_idx, category_code, seen_by, seen_by_name, seen_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (message_id, embed_idx, category_code) DO NOTHING`),
  unsetSeen: sqlite.prepare('DELETE FROM seen WHERE message_id = ? AND embed_idx = ? AND category_code = ?'),

  hasSort: sqlite.prepare('SELECT 1 AS ok FROM embed_sort WHERE message_id = ? LIMIT 1'),
  setSort: sqlite.prepare(`
    INSERT OR REPLACE INTO embed_sort (message_id, embed_idx, sorted_by, sorted_by_name, sorted_at) VALUES (?, ?, ?, ?, ?)`),
  deleteSort: sqlite.prepare('DELETE FROM embed_sort WHERE message_id = ? AND embed_idx = ?'),
  deleteSortCategories: sqlite.prepare('DELETE FROM embed_categories WHERE message_id = ? AND embed_idx = ?'),
  insertSortCategory: sqlite.prepare(
    'INSERT OR IGNORE INTO embed_categories (message_id, embed_idx, category_code) VALUES (?, ?, ?)',
  ),
};

/* ───────────── Clés d'éléments ───────────── */

export const itemKey = (messageId, idx) => `${messageId}.${idx}`;
export function parseKey(key) {
  const [messageId, idx] = String(key).split('.');
  return { messageId, idx: Number(idx) };
}
function pairsWhere(keys, alias, idxCol) {
  const pairs = keys.map(parseKey);
  return {
    sql: pairs.map(() => `(${alias}.message_id = ? AND ${alias}.${idxCol} = ?)`).join(' OR '),
    params: pairs.flatMap((p) => [p.messageId, p.idx]),
  };
}

/* ───────────── Serveurs ───────────── */

export const DEFAULT_CATEGORIES = [
  { code: 'R', label: 'Responsable', letter: 'R', color: 0xe67e22 },
  { code: 'G', label: 'Gestionnaire', letter: 'G', color: 0x3498db },
  { code: 'M', label: 'Mise à jour', letter: 'M', color: 0x9b59b6 },
];

/** Crée l'entrée du serveur et les catégories par défaut (R, G, M) la première fois. */
export function ensureGuild(guildId) {
  if (st.getGuild.get(guildId)) return;
  transaction(() => {
    st.insertGuild.run(guildId, Date.now(), SORT_EMOJI_DEFAULT, SORT_EMOJI_DEFAULT);
    for (const c of DEFAULT_CATEGORIES) {
      const emoji = regionalIndicator(c.letter);
      st.upsertCategory.run({
        guild_id: guildId,
        code: c.code,
        label: c.label,
        emoji_key: emoji,
        emoji_display: emoji,
        color: c.color,
      });
    }
  });
  bump();
}

export function getSortEmoji(guildId) {
  const g = st.getGuild.get(guildId);
  return {
    key: g?.sort_emoji_key ?? SORT_EMOJI_DEFAULT,
    display: g?.sort_emoji_display ?? SORT_EMOJI_DEFAULT,
  };
}
export function setSortEmoji(guildId, key, display) {
  st.setSortEmoji.run(key, display, guildId);
  bump();
}

/* ───────────── Salons ───────────── */

export const getChannel = (channelId) => st.getChannel.get(channelId);
export const getChannels = (guildId) => st.getChannels.all(guildId);
export const getAllChannels = () => st.getAllChannels.all();
export const isWatched = (channelId) => !!st.getChannel.get(channelId);

/** Retourne true si le salon vient d'être ajouté. */
export function addChannel(guildId, channelId) {
  const now = Date.now();
  const added = st.insertChannel.run(channelId, guildId, now, now).changes > 0;
  if (added) bump();
  return added;
}

export function updateScannedSince(channelId, since) {
  const ch = st.getChannel.get(channelId);
  if (ch && since < ch.scanned_since) {
    st.setScannedSince.run(since, channelId);
    bump();
  }
}

/** Retire un salon et oublie ses messages. */
export function removeChannel(channelId) {
  const removed = transaction(() => {
    for (const { message_id: id } of st.channelMessageIds.all(channelId)) deleteMessageRows(id);
    return st.deleteChannel.run(channelId).changes > 0;
  });
  if (removed) bump();
  return removed;
}

/* ───────────── Catégories ───────────── */

export const getCategories = (guildId) => st.getCategories.all(guildId);
export const getCategory = (guildId, code) => st.getCategory.get(guildId, code);
export const findCategoryByEmoji = (guildId, key) => st.getCategoryByEmoji.get(guildId, key);
export function upsertCategory(cat) {
  st.upsertCategory.run(cat);
  bump();
}
export function deleteCategory(guildId, code) {
  const removed = st.deleteCategory.run(guildId, code).changes > 0;
  if (removed) bump();
  return removed;
}

/* ───────────── Auteurs ───────────── */

export const getExcludedAuthors = (guildId) => st.getExcluded.all(guildId);
export function excludeAuthor(guildId, name) {
  st.excludeAuthor.run(guildId, name.trim().toLowerCase(), name.trim());
  bump();
}
export function includeAuthor(guildId, name) {
  const ok = st.includeAuthor.run(guildId, name.trim().toLowerCase()).changes > 0;
  if (ok) bump();
  return ok;
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Auteurs connus (pour l'autocomplétion). */
export function searchAuthors(guildId, query = '', { hideExcluded = false, channelIds } = {}) {
  const ch = channelWhere(channelIds);
  const sql = `
    SELECT MAX(e.author) AS author, e.author_lc AS author_lc, COUNT(*) AS n
    FROM embeds e JOIN messages m ON m.message_id = e.message_id
    WHERE m.guild_id = ? AND e.author_lc LIKE ? ESCAPE '\\'
      ${hideExcluded ? 'AND e.author_lc NOT IN (SELECT name_lc FROM excluded_authors WHERE guild_id = m.guild_id)' : ''}
      ${ch.sql.map((c) => `AND ${c}`).join(' ')}
    GROUP BY e.author_lc
    ORDER BY n DESC, e.author_lc
    LIMIT 25`;
  return sqlite.prepare(sql).all(guildId, `%${likeEscape(query.toLowerCase())}%`, ...ch.params);
}

/* ───────────── Messages ───────────── */

export const hasMessage = (messageId) => !!st.hasMessage.get(messageId);

/** Retourne true si le message était en base. */
function deleteMessageRows(id) {
  st.deleteReactions.run(id);
  st.deleteEmbeds.run(id);
  return st.deleteMessage.run(id).changes > 0;
}

function fingerprintOf(op) {
  const reactions = [...op.reactions].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return JSON.stringify({ n: op.data.embed_count, e: op.embeds, r: reactions });
}

/**
 * Enregistre un lot d'opérations dans une seule transaction.
 * op = { data, embeds, reactions }  ou  { deleteId }
 * Un message sans réaction est oublié… sauf s'il a déjà été trié à la main.
 * Un message identique à ce qui est en base n'est pas réécrit.
 */
export function saveMessages(ops) {
  if (!ops.length) return;
  let changed = false;
  transaction(() => {
    for (const op of ops) {
      const id = op.deleteId ?? op.data.message_id;
      if (op.deleteId || (!op.reactions.length && !st.hasSort.get(id))) {
        if (deleteMessageRows(id)) changed = true;
        continue;
      }
      const fingerprint = fingerprintOf(op);
      if (st.getFingerprint.get(id)?.fingerprint === fingerprint) continue;
      st.upsertMessage.run({ ...op.data, fingerprint });
      st.deleteEmbeds.run(id);
      for (const e of op.embeds) st.insertEmbed.run(e);
      st.deleteReactions.run(id);
      for (const r of op.reactions) st.insertReaction.run(id, r.key, r.count);
      changed = true;
    }
  });
  if (changed) bump();
}

export function deleteMessages(ids) {
  saveMessages(ids.map((id) => ({ deleteId: id })));
}

/** Supprime les messages du salon (dans l'intervalle) qui n'existent plus sur Discord. */
export function pruneChannel(channelId, since, until, keepIds) {
  const ids = st.channelIdsInRange.all(channelId, since, until).map((r) => r.message_id);
  const gone = ids.filter((id) => !keepIds.has(id));
  deleteMessages(gone);
  return gone.length;
}

/* ───────────── Listes par catégorie ───────────── */

/** Restreint aux salons donnés (ceux que le membre peut voir). undefined/null = pas de restriction. */
function channelWhere(channelIds) {
  if (!Array.isArray(channelIds)) return { sql: [], params: [] };
  if (!channelIds.length) return { sql: ['1 = 0'], params: [] };
  return { sql: [`m.channel_id IN (${ph(channelIds)})`], params: [...channelIds] };
}

const COMMON_WHERE = [
  'm.created_at >= ?',
  'm.created_at <= ?',
  'm.channel_id IN (SELECT channel_id FROM channels WHERE guild_id = m.guild_id)',
  'e.author_lc NOT IN (SELECT name_lc FROM excluded_authors WHERE guild_id = m.guild_id)',
];
const HAS_SORT_REACTION =
  'EXISTS (SELECT 1 FROM message_reactions rs WHERE rs.message_id = m.message_id AND rs.emoji_key = g.sort_emoji_key)';

/** f = { guildId, code, since, until, authors: [author_lc], showSeen, channelIds } */
function buildFilter({ guildId, code, since, until, authors, showSeen, channelIds }) {
  const ch = channelWhere(channelIds);
  const where = [
    'm.guild_id = ?',
    ...COMMON_WHERE,
    `(
      (es.message_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM embed_categories ec
        WHERE ec.message_id = e.message_id AND ec.embed_idx = e.idx AND ec.category_code = c.code))
      OR (es.message_id IS NULL
        AND EXISTS (SELECT 1 FROM message_reactions r WHERE r.message_id = m.message_id AND r.emoji_key = c.emoji_key)
        AND NOT ${HAS_SORT_REACTION})
    )`,
  ];
  const params = [code, guildId, since ?? 0, until ?? MAX_TS];
  where.push(...ch.sql);
  params.push(...ch.params);
  if (!showSeen) where.push('s.message_id IS NULL');
  if (authors?.length) {
    where.push(`e.author_lc IN (${ph(authors)})`);
    params.push(...authors);
  }
  return {
    from: `
      FROM embeds e
      JOIN messages m ON m.message_id = e.message_id
      JOIN guilds g ON g.guild_id = m.guild_id
      JOIN categories c ON c.guild_id = m.guild_id AND c.code = ?
      LEFT JOIN embed_sort es ON es.message_id = e.message_id AND es.embed_idx = e.idx
      LEFT JOIN seen s ON s.message_id = e.message_id AND s.embed_idx = e.idx AND s.category_code = c.code
      WHERE ${where.join(' AND ')}`,
    params,
  };
}

/** Clés des éléments correspondant aux filtres, triés par date. */
export function queryIds(f) {
  const { from, params } = buildFilter(f);
  const dir = f.order === 'desc' ? 'DESC' : 'ASC';
  return sqlite
    .prepare(
      `SELECT e.message_id || '.' || e.idx AS key ${from}
       ORDER BY m.created_at ${dir}, m.message_id ${dir}, e.idx ASC`,
    )
    .all(...params)
    .map((r) => r.key);
}

/** { total, unseen } pour les filtres donnés (le filtre « vus » est ignoré). */
export function countMessages(f) {
  const { from, params } = buildFilter({ ...f, showSeen: true });
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN s.message_id IS NULL THEN 1 ELSE 0 END), 0) AS unseen ${from}`,
    )
    .get(...params);
  return { total: Number(row.total), unseen: Number(row.unseen) };
}

/** Auteurs présents dans la catégorie / période (pour le menu de filtre). */
export function authorsForFilter(f) {
  const { from, params } = buildFilter({ ...f, authors: null, showSeen: true });
  return sqlite
    .prepare(
      `SELECT MAX(e.author) AS author, e.author_lc AS author_lc, COUNT(*) AS n ${from}
       GROUP BY e.author_lc ORDER BY n DESC, e.author_lc LIMIT 25`,
    )
    .all(...params);
}

/* ───────────── File « à trier » ───────────── */

function sortFilter({ guildId, since, until, includeSorted, channelIds }) {
  const ch = channelWhere(channelIds);
  const where = ['m.guild_id = ?', ...COMMON_WHERE, HAS_SORT_REACTION, ...ch.sql];
  if (!includeSorted) where.push('es.message_id IS NULL');
  return {
    from: `
      FROM embeds e
      JOIN messages m ON m.message_id = e.message_id
      JOIN guilds g ON g.guild_id = m.guild_id
      LEFT JOIN embed_sort es ON es.message_id = e.message_id AND es.embed_idx = e.idx
      WHERE ${where.join(' AND ')}`,
    params: [guildId, since ?? 0, until ?? MAX_TS, ...ch.params],
  };
}

/** Clés des embeds des messages marqués « à trier » (non triés, sauf includeSorted). */
export function querySortIds(f) {
  const { from, params } = sortFilter(f);
  return sqlite
    .prepare(`SELECT e.message_id || '.' || e.idx AS key ${from} ORDER BY m.created_at ASC, m.message_id ASC, e.idx ASC`)
    .all(...params)
    .map((r) => r.key);
}

/** { embeds, messages } restant à trier. */
export function countToSort(f) {
  const { from, params } = sortFilter({ ...f, includeSorted: false });
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS embeds, COUNT(DISTINCT m.message_id) AS messages ${from}`)
    .get(...params);
  return { embeds: Number(row.embeds), messages: Number(row.messages) };
}

/* ───────────── Détail des éléments ───────────── */

/** Éléments (dans l'ordre des clés) avec leur état « vu » pour la catégorie `code` (peut être null). */
export function getItems(keys, code = null) {
  if (!keys.length) return [];
  const w = pairsWhere(keys, 'e', 'idx');
  const rows = sqlite
    .prepare(
      `SELECT e.*, m.guild_id, m.channel_id, m.created_at, m.embed_count,
              s.seen_by_name, s.seen_at, es.sorted_at, es.sorted_by_name
       FROM embeds e
       JOIN messages m ON m.message_id = e.message_id
       LEFT JOIN seen s ON s.message_id = e.message_id AND s.embed_idx = e.idx AND s.category_code = ?
       LEFT JOIN embed_sort es ON es.message_id = e.message_id AND es.embed_idx = e.idx
       WHERE ${w.sql}`,
    )
    .all(code ?? '', ...w.params);
  const byKey = new Map(rows.map((r) => [itemKey(r.message_id, r.idx), { ...r, key: itemKey(r.message_id, r.idx) }]));
  return keys.map((k) => byKey.get(k)).filter(Boolean);
}

/**
 * Pour chaque élément : catégories actuelles, tri, réaction « à trier », catégories suggérées par les réactions.
 * Retourne Map key → { codes, sorted, toSort, suggested }
 */
export function describeItems(guildId, items) {
  const result = new Map();
  if (!items.length) return result;
  const order = new Map(getCategories(guildId).map((c, i) => [c.code, i]));
  const byOrder = (a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99);
  const sortKey = getSortEmoji(guildId).key;
  const messageIds = [...new Set(items.map((i) => i.message_id))];

  const reactionCodes = new Map();
  const toSort = new Set();
  const reactions = sqlite
    .prepare(
      `SELECT r.message_id, r.emoji_key, c.code
       FROM message_reactions r
       LEFT JOIN categories c ON c.guild_id = ? AND c.emoji_key = r.emoji_key
       WHERE r.message_id IN (${ph(messageIds)})`,
    )
    .all(guildId, ...messageIds);
  for (const r of reactions) {
    if (r.emoji_key === sortKey) toSort.add(r.message_id);
    if (r.code) {
      if (!reactionCodes.has(r.message_id)) reactionCodes.set(r.message_id, []);
      reactionCodes.get(r.message_id).push(r.code);
    }
  }

  const w = pairsWhere(items.map((i) => i.key), 'ec', 'embed_idx');
  const sortedCodes = new Map();
  for (const r of sqlite
    .prepare(`SELECT ec.message_id, ec.embed_idx, ec.category_code FROM embed_categories ec WHERE ${w.sql}`)
    .all(...w.params)) {
    const k = itemKey(r.message_id, r.embed_idx);
    if (!sortedCodes.has(k)) sortedCodes.set(k, []);
    sortedCodes.get(k).push(r.category_code);
  }

  for (const item of items) {
    const sorted = item.sorted_at != null;
    const fromReactions = (reactionCodes.get(item.message_id) ?? []).sort(byOrder);
    const pending = toSort.has(item.message_id);
    let codes;
    if (sorted) codes = (sortedCodes.get(item.key) ?? []).filter((c) => order.has(c)).sort(byOrder);
    else codes = pending ? [] : fromReactions;
    result.set(item.key, { codes, sorted, toSort: pending, suggested: fromReactions });
  }
  return result;
}

/* ───────────── Déjà vu ───────────── */

export function isSeen(key, code) {
  const { messageId, idx } = parseKey(key);
  return !!st.isSeen.get(messageId, idx, code);
}
export function setSeen(key, code, userId, userName) {
  const { messageId, idx } = parseKey(key);
  if (st.setSeen.run(messageId, idx, code, userId, userName ?? null, Date.now()).changes > 0) bump();
}
export function unsetSeen(key, code) {
  const { messageId, idx } = parseKey(key);
  if (st.unsetSeen.run(messageId, idx, code).changes > 0) bump();
}

/* ───────────── Tri manuel ───────────── */

/** Range l'embed dans `codes` (tableau vide = ignoré : n'apparaît dans aucune catégorie). */
export function setSort(key, codes, userId, userName) {
  const { messageId, idx } = parseKey(key);
  transaction(() => {
    st.setSort.run(messageId, idx, userId, userName ?? null, Date.now());
    st.deleteSortCategories.run(messageId, idx);
    for (const code of codes) st.insertSortCategory.run(messageId, idx, code);
  });
  bump();
}

/** Remet l'embed « à trier ». */
export function unsetSort(key) {
  const { messageId, idx } = parseKey(key);
  const removed = transaction(() => {
    const n = st.deleteSort.run(messageId, idx).changes;
    st.deleteSortCategories.run(messageId, idx);
    return n > 0;
  });
  if (removed) bump();
}
