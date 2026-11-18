import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Base de test isolée (à définir avant d'importer db.js)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlogs-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.TZ = 'Europe/Paris';

const { Collection, embedLength } = await import('discord.js');
const store = await import('../src/db.js');
const { parseDateInput } = await import('../src/dates.js');
const { parseEmojiInput, regionalIndicator } = await import('../src/emoji.js');
const { extractMessage, scanChannel } = await import('../src/scanner.js');
const { createSession, buildView, PAGE_SIZE } = await import('../src/commands/liste.js');
const { createSortSession, buildSortView } = await import('../src/commands/trier.js');
const { commandsJSON } = await import('../src/commands/definitions.js');

const R = regionalIndicator('R');
const G = regionalIndicator('G');
const M = regionalIndicator('M');
const SORT = store.SORT_EMOJI_DEFAULT;
const BASE = new Date(2026, 10, 1, 12, 0).getTime(); // 01/11/2026 12:00

let nextId = 1000n;
function fakeMsg({ guild = 'g1', channel = 'c1', ts, embeds = [{}], reactions = [], content = '' }) {
  nextId += 1n;
  return {
    id: String(nextId),
    guildId: guild,
    channelId: channel,
    createdTimestamp: ts,
    content,
    embeds: embeds.map((e, i) => ({
      author: { name: e.author ?? 'william' },
      title: e.title ?? `feat: truc ${i}`,
      description: e.desc ?? 'Description',
      footer: { text: 'adv-main: main' },
      fields: [],
    })),
    reactions: {
      cache: new Map(reactions.map((e, i) => [String(i), { emoji: { id: null, name: e }, count: 1 }])),
    },
  };
}
const keysOf = (msg) => msg.embeds.map((_, i) => store.itemKey(msg.id, i));

function checkView(view, maxEmbeds) {
  assert.ok(view.content.length <= 2000);
  assert.ok(view.embeds.length <= maxEmbeds);
  const total = view.embeds.reduce((sum, e) => sum + embedLength(e.toJSON()), 0);
  assert.ok(total <= 6000, `embeds trop longs : ${total}`);
  assert.ok(view.components.length <= 5);
  for (const row of view.components) row.toJSON(); // valide les boutons / menus
  // Discord fusionne (et masque) les embeds qui partagent la même URL de titre
  const urls = view.embeds.map((e) => e.data.url).filter(Boolean);
  assert.equal(new Set(urls).size, urls.length, `URLs en double : ${urls.join(', ')}`);
}

test('dates', () => {
  const now = new Date(2026, 10, 17, 18, 47);
  assert.equal(parseDateInput('01/11/2026'), new Date(2026, 10, 1).getTime());
  assert.equal(parseDateInput('1/11', { now }), new Date(2026, 10, 1).getTime());
  assert.equal(parseDateInput('01/11/26 18h30'), new Date(2026, 10, 1, 18, 30).getTime());
  assert.equal(parseDateInput('2026-11-01 18:30'), new Date(2026, 10, 1, 18, 30).getTime());
  assert.equal(parseDateInput('01/11/2026', { endOfDay: true }), new Date(2026, 10, 1, 23, 59, 59, 999).getTime());
  assert.equal(parseDateInput('7j', { now }), new Date(2026, 10, 10, 18, 47).getTime());
  assert.equal(parseDateInput('24h', { now }), new Date(2026, 10, 16, 18, 47).getTime());
  assert.equal(parseDateInput('2sem', { now }), new Date(2026, 10, 3, 18, 47).getTime());
  assert.equal(parseDateInput('hier', { now }), new Date(2026, 10, 16).getTime());
  assert.equal(parseDateInput("Aujourd'hui", { now }), new Date(2026, 10, 17).getTime());
  assert.equal(parseDateInput(''), null);
  assert.equal(parseDateInput(null), null);
  assert.throws(() => parseDateInput('31/02/2026'), /Date invalide/);
  assert.throws(() => parseDateInput('n’importe quoi'), /Date invalide/);
});

test('emojis', () => {
  assert.deepEqual(parseEmojiInput('R'), { key: R, display: R });
  assert.deepEqual(parseEmojiInput(':regional_indicator_g:'), { key: G, display: G });
  assert.deepEqual(parseEmojiInput(R), { key: R, display: R });
  assert.deepEqual(parseEmojiInput('✅'), { key: '✅', display: '✅' });
  assert.deepEqual(parseEmojiInput('🚮'), { key: SORT, display: SORT });
  assert.deepEqual(parseEmojiInput('❤️'), { key: '❤', display: '❤️' });
  assert.deepEqual(parseEmojiInput('<:Resp:123456789012345678>'), {
    key: '123456789012345678',
    display: '<:Resp:123456789012345678>',
  });
  assert.equal(parseEmojiInput('bonjour'), null);
  assert.equal(parseEmojiInput(''), null);
});

test('extractMessage : un élément par embed', () => {
  const row = extractMessage(fakeMsg({ ts: BASE, embeds: [{ author: 'William' }, { author: 'Bob' }], reactions: [R, '👍'] }));
  assert.equal(row.data.embed_count, 2);
  assert.deepEqual(row.embeds.map((e) => [e.idx, e.author_lc]), [[0, 'william'], [1, 'bob']]);
  assert.equal(row.embeds[0].footer, 'adv-main: main');
  assert.deepEqual(row.reactions.map((r) => r.key), [R, '👍']);
  // Pas de réaction : renvoyé quand même, c'est saveMessages qui l'oublie
  assert.deepEqual(extractMessage(fakeMsg({ ts: BASE })).reactions, []);
  // Ni embed ni texte : rien à lire
  assert.equal(extractMessage(fakeMsg({ ts: BASE, embeds: [] })), null);
  // Texte sans embed
  const txt = extractMessage(fakeMsg({ ts: BASE, embeds: [], content: 'coucou', reactions: [R] }));
  assert.equal(txt.embeds[0].description, 'coucou');
});

test('commandes slash valides', () => {
  assert.deepEqual(commandsJSON.map((c) => c.name), ['liste', 'trier', 'resume', 'sync', 'config']);
  // Plus besoin de « Gérer le serveur »
  assert.ok(commandsJSON.every((c) => c.default_member_permissions == null));
});

test('scan, filtres, déjà vu et rendu', async () => {
  const GUILD = 'g1';
  const CHAN = 'c1';
  store.ensureGuild(GUILD);
  assert.deepEqual(store.getCategories(GUILD).map((c) => c.code), ['R', 'G', 'M']);
  store.addChannel(GUILD, CHAN);

  // 250 messages, un toutes les heures
  const msgs = [];
  for (let i = 0; i < 250; i++) {
    const reactions = [];
    if (i % 2 === 0) reactions.push(R);
    if (i % 3 === 0) reactions.push(G);
    if (i % 5 === 0) reactions.push(M);
    msgs.push(
      fakeMsg({
        ts: BASE + i * 3600_000,
        embeds: [{ author: i % 4 === 0 ? 'bob' : 'william', title: `commit ${i}`, desc: `Ligne\n${'x'.repeat(50)}` }],
        reactions,
      }),
    );
  }
  const newestFirst = [...msgs].reverse();
  const fakeChannel = {
    id: CHAN,
    messages: {
      async fetch({ limit, before }) {
        const start = before ? newestFirst.findIndex((m) => m.id === before) + 1 : 0;
        return new Collection(newestFirst.slice(start, start + limit).map((m) => [m.id, m]));
      },
    },
  };

  // Scan depuis le message 20 → 230 messages lus
  const since = BASE + 20 * 3600_000;
  const res = await scanChannel(fakeChannel, since);
  assert.equal(res.read, 230);
  assert.equal(res.stored, msgs.slice(20).filter((m) => m.reactions.cache.size > 0).length);
  assert.ok(store.getChannel(CHAN).scanned_since <= since);
  assert.equal(store.hasMessage(msgs[23].id), false, 'sans réaction → pas gardé'); // 23 : ni pair, ni ×3, ni ×5

  // Catégorie R = indices pairs ≥ 20
  const base = { guildId: GUILD, code: 'R', since: null, until: null, authors: [], showSeen: false, order: 'asc' };
  const idsR = store.queryIds(base);
  assert.equal(idsR.length, msgs.slice(20).filter((_, k) => (k + 20) % 2 === 0).length);
  assert.equal(idsR[0], store.itemKey(msgs[20].id, 0));

  // Filtre date
  assert.equal(store.queryIds({ ...base, since: BASE + 100 * 3600_000 })[0], store.itemKey(msgs[100].id, 0));

  // Filtre auteur
  const bobIds = store.queryIds({ ...base, authors: ['bob'] });
  assert.ok(bobIds.length > 0);
  assert.ok(store.getItems(bobIds, 'R').every((m) => m.author_lc === 'bob'));

  // Auteur exclu
  store.excludeAuthor(GUILD, 'Bob');
  assert.equal(store.queryIds({ ...base, authors: ['bob'] }).length, 0);
  assert.equal(store.searchAuthors(GUILD, '', { hideExcluded: true }).some((a) => a.author_lc === 'bob'), false);
  store.includeAuthor(GUILD, 'bob');
  assert.equal(store.queryIds({ ...base, authors: ['bob'] }).length, bobIds.length);

  // Déjà vu : par catégorie
  const target = idsR[0];
  store.setSeen(target, 'R', 'u1', 'Nicolas');
  assert.equal(store.queryIds(base).includes(target), false);
  assert.equal(store.queryIds({ ...base, showSeen: true }).includes(target), true);
  assert.deepEqual(store.countMessages(base), { total: idsR.length, unseen: idsR.length - 1 });
  store.unsetSeen(target, 'R');

  // Rendu de toutes les pages
  const s = createSession({ ...base, userId: 'u1' });
  for (s.page = 0; s.page * PAGE_SIZE < s.ids.length; s.page++) checkView(buildView(s), PAGE_SIZE);

  // Cocher un élément ne le retire pas de la page tant qu'on n'actualise pas
  s.page = 0;
  const firstId = s.ids[0];
  store.setSeen(firstId, 'R', 'u1', 'Nicolas');
  const view = buildView(s);
  assert.ok(view.embeds[0].data.title.startsWith('✅'));
  assert.match(view.embeds[0].data.footer.text, /Vu par Nicolas/);
  s.ids = store.queryIds(s); // = bouton 🔄
  assert.equal(s.ids.includes(firstId), false);

  // Message supprimé côté Discord → nettoyé au scan suivant
  const removed = msgs[22];
  newestFirst.splice(newestFirst.indexOf(removed), 1);
  assert.equal((await scanChannel(fakeChannel, since)).pruned, 1);
  assert.equal(store.hasMessage(removed.id), false);

  // Réaction retirée → le message sort de la base
  msgs[24].reactions.cache.clear();
  await scanChannel(fakeChannel, since);
  assert.equal(store.hasMessage(msgs[24].id), false);

  // Retirer le salon vide la base
  store.removeChannel(CHAN);
  assert.equal(store.queryIds({ ...base, showSeen: true }).length, 0);
});

test('plusieurs embeds dans un message + tri 🚮', () => {
  const guild = 'g3';
  const channel = 'c3';
  store.ensureGuild(guild);
  store.addChannel(guild, channel);
  const three = [{ title: 'a' }, { title: 'b', author: 'bob' }, { title: 'c' }];

  const msgR = fakeMsg({ guild, channel, ts: BASE, embeds: three, reactions: [R] });
  const msgSort = fakeMsg({ guild, channel, ts: BASE + 1000, embeds: three, reactions: [SORT, G] });
  store.saveMessages([extractMessage(msgR), extractMessage(msgSort)]);
  const f = (code, extra = {}) => ({ guildId: guild, code, showSeen: true, ...extra });

  // Réaction R sans 🚮 → les 3 embeds vont dans R
  assert.deepEqual(store.queryIds(f('R')), keysOf(msgR));
  // Message 🚮 → dans aucune catégorie tant qu'il n'est pas trié, même avec la réaction G
  assert.deepEqual(store.queryIds(f('G')), []);
  assert.deepEqual(store.querySortIds({ guildId: guild }), keysOf(msgSort));
  assert.deepEqual(store.countToSort({ guildId: guild }), { embeds: 3, messages: 1 });
  const items = store.getItems(keysOf(msgSort));
  const info = store.describeItems(guild, items);
  assert.deepEqual(info.get(items[0].key), { codes: [], sorted: false, toSort: true, suggested: ['G'] });

  // Tri : embed 0 → R + G, embed 1 → ignoré, embed 2 pas encore trié
  const [k0, k1, k2] = keysOf(msgSort);
  store.setSort(k0, ['R', 'G'], 'u1', 'Nicolas');
  store.setSort(k1, [], 'u1', 'Nicolas');
  assert.ok(store.queryIds(f('R')).includes(k0));
  assert.deepEqual(store.queryIds(f('G')), [k0]);
  assert.ok(!store.queryIds(f('R')).includes(k1) && !store.queryIds(f('M')).includes(k1));
  assert.deepEqual(store.querySortIds({ guildId: guild }), [k2]);
  assert.deepEqual(store.countToSort({ guildId: guild }), { embeds: 1, messages: 1 });
  assert.deepEqual(store.querySortIds({ guildId: guild, includeSorted: true }), [k0, k1, k2]);
  const d = store.describeItems(guild, store.getItems([k0, k1]));
  assert.deepEqual(d.get(k0).codes, ['R', 'G']);
  assert.equal(d.get(k1).sorted, true);

  // « Déjà vu » d'un embed n'affecte pas les autres embeds du même message
  const [r0, r1] = keysOf(msgR);
  store.setSeen(r0, 'R', 'u1', 'Nicolas');
  assert.ok(!store.queryIds(f('R', { showSeen: false })).includes(r0));
  assert.ok(store.queryIds(f('R', { showSeen: false })).includes(r1));

  // Remettre à trier puis re-trier
  store.unsetSort(k0);
  assert.deepEqual(store.querySortIds({ guildId: guild }), [k0, k2]);
  store.setSort(k0, ['M'], 'u1', 'Nicolas');
  assert.deepEqual(store.queryIds(f('M')), [k0]);

  // Un message déjà trié reste en base même si on retire toutes ses réactions
  msgSort.reactions.cache.clear();
  store.saveMessages([extractMessage(msgSort)]);
  assert.ok(store.hasMessage(msgSort.id));
  assert.deepEqual(store.queryIds(f('M')), [k0]);

  // Rendu des vues
  const ss = createSortSession({ guildId: guild, userId: 'u1', includeSorted: true });
  checkView(buildSortView(ss), 4);
  checkView(buildView(createSession({ guildId: guild, code: 'R', userId: 'u1', showSeen: true })), PAGE_SIZE);
});

test('rendu avec des descriptions très longues', () => {
  const guild = 'g2';
  store.ensureGuild(guild);
  store.addChannel(guild, 'c2');
  const ops = [];
  for (let i = 0; i < 5; i++) {
    const embeds = Array.from({ length: 10 }, () => ({ desc: 'é'.repeat(4096), title: 't'.repeat(256) }));
    ops.push(extractMessage(fakeMsg({ guild, channel: 'c2', ts: BASE + i, embeds, reactions: [R, SORT] })));
  }
  store.saveMessages(ops);
  for (const k of store.querySortIds({ guildId: guild }).slice(0, 12)) store.setSort(k, ['R'], 'u1', 'X');

  const s = createSession({ guildId: guild, code: 'R', userId: 'u1' });
  const view = buildView(s);
  assert.equal(view.embeds.length, 5);
  checkView(view, 5);
  const ss = createSortSession({ guildId: guild, userId: 'u1' });
  assert.equal(ss.ids.length, 50 - 12);
  checkView(buildSortView(ss), 4);
});

test("migration d'une base de la version précédente", () => {
  const dbFile = path.join(tmp, 'old.db');
  const old = new DatabaseSync(dbFile);
  old.exec(`
    CREATE TABLE guilds (guild_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE channels (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, scanned_since INTEGER NOT NULL, added_at INTEGER NOT NULL);
    CREATE TABLE categories (guild_id TEXT NOT NULL, code TEXT NOT NULL, label TEXT NOT NULL, emoji_key TEXT NOT NULL,
      emoji_display TEXT NOT NULL, color INTEGER, PRIMARY KEY (guild_id, code));
    CREATE TABLE messages (message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, author TEXT NOT NULL,
      author_lc TEXT NOT NULL, author_icon TEXT, title TEXT, description TEXT, footer TEXT, url TEXT, color INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE message_reactions (message_id TEXT NOT NULL REFERENCES messages (message_id) ON DELETE CASCADE,
      emoji_key TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (message_id, emoji_key));
    CREATE TABLE seen (message_id TEXT NOT NULL, category_code TEXT NOT NULL, seen_by TEXT NOT NULL, seen_by_name TEXT,
      seen_at INTEGER NOT NULL, PRIMARY KEY (message_id, category_code));
    INSERT INTO guilds VALUES ('gX', 1);
    INSERT INTO channels VALUES ('cX', 'gX', 5, 5);
    INSERT INTO messages VALUES ('m1', 'gX', 'cX', 'w', 'w', NULL, 't', 'd', NULL, NULL, NULL, 10, 10);
    INSERT INTO message_reactions VALUES ('m1', 'x', 1);
    INSERT INTO seen VALUES ('m1', 'R', 'u1', 'Nicolas', 99);
  `);
  old.close();

  const dbModule = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db.js');
  const script = `
    const db = await import(${JSON.stringify(dbModule)});
    const q = (sql) => db.sqlite.prepare(sql).all();
    console.log(JSON.stringify({
      version: db.sqlite.prepare('PRAGMA user_version').get().user_version,
      seen: q('SELECT * FROM seen'),
      guild: db.getSortEmoji('gX'),
      channels: q('SELECT channel_id, scanned_since FROM channels'),
      messageCols: q('PRAGMA table_info(messages)').map((c) => c.name),
      messages: q('SELECT COUNT(*) AS n FROM messages')[0].n,
    }));`;
  const out = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
    env: { ...process.env, DB_PATH: dbFile },
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(r.version, 2);
  assert.deepEqual(r.seen.map((x) => [x.message_id, x.embed_idx, x.category_code, x.seen_by_name]), [['m1', 0, 'R', 'Nicolas']]);
  assert.deepEqual(r.guild, { key: SORT, display: SORT });
  assert.deepEqual(r.channels, [{ channel_id: 'cX', scanned_since: 5 }]);
  assert.ok(r.messageCols.includes('embed_count') && !r.messageCols.includes('author'));
  assert.equal(r.messages, 0, 'le cache des messages est vidé (relu au prochain scan)');
});

test('on ne voit que les salons que l’on peut lire', () => {
  const guild = 'g4';
  store.ensureGuild(guild);
  store.addChannel(guild, 'pub');
  store.addChannel(guild, 'priv');
  const pub = fakeMsg({ guild, channel: 'pub', ts: BASE, embeds: [{ author: 'alice' }], reactions: [R] });
  const priv = fakeMsg({ guild, channel: 'priv', ts: BASE + 1, embeds: [{ author: 'secret' }], reactions: [R, SORT] });
  store.saveMessages([extractMessage(pub), extractMessage(priv)]);
  const f = { guildId: guild, code: 'R', showSeen: true };

  // Sans restriction (API) : tout ; restreint à « pub » : seulement pub ; aucun salon visible : rien
  assert.deepEqual(store.queryIds(f), keysOf(pub));
  assert.equal(store.querySortIds({ guildId: guild }).length, 1);
  assert.deepEqual(store.queryIds({ ...f, channelIds: ['pub'] }), keysOf(pub));
  assert.deepEqual(store.querySortIds({ guildId: guild, channelIds: ['pub'] }), []);
  assert.deepEqual(store.countToSort({ guildId: guild, channelIds: ['pub'] }), { embeds: 0, messages: 0 });
  assert.deepEqual(store.queryIds({ ...f, channelIds: [] }), []);
  assert.deepEqual(store.countMessages({ ...f, channelIds: [] }), { total: 0, unseen: 0 });
  assert.deepEqual(store.searchAuthors(guild, '', { channelIds: ['pub'] }).map((a) => a.author_lc), ['alice']);
  assert.equal(store.searchAuthors(guild, '').length, 2);
});

test('droits retirés pendant une session : la liste est rechargée', async () => {
  const { refreshVisibility } = await import('../src/commands/common.js');
  const guild = 'g4'; // salons « pub » et « priv » du test précédent
  const s = createSession({ guildId: guild, code: 'R', userId: 'u1', showSeen: true, channelIds: ['pub', 'priv'] });
  // Faux membre qui ne peut plus lire que « pub »
  const interaction = {
    guildId: guild,
    member: { id: 'u1' },
    user: { id: 'u1' },
    guild: {
      channels: {
        cache: new Map(['pub', 'priv'].map((id) => [id, { permissionsFor: () => ({ has: () => id === 'pub' }) }])),
      },
    },
  };
  assert.equal(refreshVisibility(interaction, s), true);
  assert.deepEqual(s.channelIds, ['pub']);
  assert.equal(refreshVisibility(interaction, s), false, 'pas de rechargement si rien ne change');
});
