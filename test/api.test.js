import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'botlogs-api-'));
process.env.DB_PATH = path.join(tmp, 'api.db');
process.env.TZ = 'Europe/Paris';

const { Collection, ChannelType } = await import('discord.js');
const store = await import('../src/db.js');
const { regionalIndicator } = await import('../src/emoji.js');
const { createApiServer } = await import('../src/api.js');

const KEY = 'cle-de-test-1234567890';
const R = regionalIndicator('R');
const G = regionalIndicator('G');
const SORT = store.SORT_EMOJI_DEFAULT;
const GUILD = '900000000000000001';
const CHAN = '900000000000000002';
const OTHER = '900000000000000003';
const BASE = new Date(2026, 10, 1, 12, 0).getTime();

/* ───── Faux client Discord ───── */
let nextId = 1_000_000_000_000_000_000n;
function fakeMsg({ ts, embeds, reactions }) {
  nextId += 1n;
  return {
    id: String(nextId),
    guildId: GUILD,
    channelId: CHAN,
    createdTimestamp: ts,
    content: '',
    embeds: embeds.map((e) => ({ author: { name: e.author }, title: e.title, description: 'desc', footer: { text: 'adv-main: main' }, fields: [] })),
    reactions: { cache: new Map(reactions.map((e, i) => [String(i), { emoji: { id: null, name: e }, count: 1 }])) },
  };
}
const msgs = [
  fakeMsg({ ts: BASE, embeds: [{ author: 'william', title: 'feat: casino' }], reactions: [R] }),
  fakeMsg({ ts: BASE + 1000, embeds: [{ author: 'bob', title: 'fix: garage' }], reactions: [R, G] }),
  fakeMsg({ ts: BASE + 2000, embeds: [{ author: 'william', title: 'a' }, { author: 'william', title: 'b' }], reactions: [SORT] }),
  fakeMsg({ ts: BASE + 3000, embeds: [{ author: 'william', title: 'sans réaction' }], reactions: [] }),
];
const newestFirst = [...msgs].reverse();

function fakeChannel(id, name, withMessages) {
  return {
    id,
    name,
    type: ChannelType.GuildText,
    rawPosition: id === CHAN ? 0 : 1,
    parent: null,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    toString: () => `<#${id}>`,
    messages: {
      async fetch({ limit, before }) {
        const list = withMessages ? newestFirst : [];
        const start = before ? list.findIndex((m) => m.id === before) + 1 : 0;
        return new Collection(list.slice(start, start + limit).map((m) => [m.id, m]));
      },
    },
  };
}
const channels = new Collection([
  [CHAN, fakeChannel(CHAN, 'github', true)],
  [OTHER, fakeChannel(OTHER, 'general', false)],
]);
const client = {
  user: {},
  channels: { cache: channels, fetch: async (id) => channels.get(id) },
};
const guild = {
  id: GUILD,
  client,
  members: { me: {} },
  emojis: { cache: new Collection() },
  channels: {
    cache: channels,
    async fetch(id) {
      const ch = channels.get(id);
      if (!ch) throw new Error('Unknown Channel');
      return ch;
    },
  },
};
client.guilds = { cache: new Collection([[GUILD, guild]]) };

/* ───── Serveur ───── */
const server = createApiServer(client, KEY);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function call(method, route, body, key = KEY) {
  const res = await fetch(baseUrl + route, {
    method,
    headers: { ...(key ? { 'x-cle-api': key } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
const par = { id: '123456789012345678', nom: 'Nicolas' };

test('sécurité et erreurs', async () => {
  assert.equal((await call('GET', '/etat', undefined, null)).status, 401);
  assert.equal((await call('GET', '/etat', undefined, 'mauvaise-cle-xxxxxxxx')).status, 401);
  const unknown = await call('GET', '/nimporte');
  assert.equal(unknown.status, 404);
  assert.ok(unknown.data.erreur);
  assert.equal((await call('GET', '/vu')).status, 405);
  assert.equal((await call('POST', '/vu', '{pas du json')).status, 400);
  assert.equal((await call('GET', '/etat?guild_id=42')).status, 404);
});

test('parcours complet', async () => {
  // Ajout du salon → scan
  let r = await call('POST', '/config/salon', { action: 'ajouter', salon_id: CHAN, depuis: BASE - 1000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.nouveau, true);
  assert.equal(r.data.lus, 4);
  assert.equal(r.data.avec_reactions, 3);

  // État
  r = await call('GET', '/etat');
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.version, 'number');
  assert.deepEqual(r.data.categories.map((c) => c.code), ['R', 'G', 'M']);
  assert.deepEqual(r.data.salons, [{ id: CHAN, nom: 'github', scanned_since: BASE - 1000 }]);
  assert.equal(r.data.emoji_tri, SORT);
  assert.deepEqual(r.data.resume.categories[0], { code: 'R', a_traiter: 2, total: 2 });
  assert.deepEqual(r.data.resume.a_trier, { embeds: 2, messages: 1 });

  // Éléments
  r = await call('GET', '/elements?categorie=r');
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 2);
  const first = r.data.items[0];
  assert.equal(first.key, `${msgs[0].id}.0`);
  assert.equal(first.author, 'william');
  assert.equal(first.title, 'feat: casino');
  assert.equal(first.lien_message, `https://discord.com/channels/${GUILD}/${CHAN}/${msgs[0].id}`);
  assert.equal(first.vu, null);
  assert.deepEqual(first.codes, ['R']);
  assert.deepEqual(r.data.items[1].codes, ['R', 'G']);
  assert.equal((await call('GET', '/elements?categorie=R&auteurs=Bob')).data.total, 1);
  assert.equal((await call('GET', '/elements?categorie=R&ordre=desc&limite=1&decalage=0')).data.items[0].title, 'fix: garage');
  assert.equal((await call('GET', '/elements?categorie=Z')).status, 404);
  assert.equal((await call('GET', '/elements')).status, 400);

  // Déjà vu
  const v0 = (await call('GET', '/etat')).data.version;
  r = await call('POST', '/vu', { key: first.key, categorie: 'R', vu: true, par });
  assert.equal(r.status, 200);
  assert.ok(r.data.version > v0);
  assert.equal((await call('GET', '/elements?categorie=R')).data.total, 1);
  const withSeen = await call('GET', '/elements?categorie=R&vus=1');
  assert.equal(withSeen.data.items[0].vu.par_nom, 'Nicolas');
  assert.equal((await call('POST', '/vu', { key: first.key, categorie: 'R', vu: true })).status, 400, 'par requis');
  assert.equal((await call('POST', '/vu', { key: 'abc', categorie: 'R', vu: true, par })).status, 400);
  assert.equal((await call('POST', '/vu', { key: '1234567.0', categorie: 'R', vu: true, par })).status, 404);
  await call('POST', '/vu', { key: first.key, categorie: 'R', vu: false });
  assert.equal((await call('GET', '/elements?categorie=R')).data.total, 2);

  // Tri
  r = await call('GET', '/a-trier');
  assert.equal(r.data.total, 2);
  assert.deepEqual(r.data.restant, { embeds: 2, messages: 1 });
  const [a, b] = r.data.items;
  assert.equal(a.toSort, true);
  assert.equal(a.embed_count, 2);
  assert.equal((await call('POST', '/trier', { key: a.key, categories: ['R', 'G'], par })).status, 200);
  assert.equal((await call('POST', '/trier', { key: b.key, categories: [], par })).status, 200);
  assert.equal((await call('GET', '/a-trier')).data.total, 0);
  const all = await call('GET', '/a-trier?tous=1');
  assert.equal(all.data.total, 2);
  assert.equal(all.data.items[0].tri.par_nom, 'Nicolas');
  assert.deepEqual(all.data.items[0].codes, ['R', 'G']);
  assert.equal((await call('GET', '/elements?categorie=G')).data.total, 2);
  assert.equal((await call('POST', '/trier', { key: a.key, categories: ['Z'], par })).status, 404);
  assert.equal((await call('POST', '/trier', { key: a.key, par })).status, 400);
  await call('POST', '/trier', { key: a.key, categories: null });
  assert.equal((await call('GET', '/a-trier')).data.total, 1);

  // Catégories
  r = await call('POST', '/config/categorie', { action: 'ajouter', code: 'x', libelle: 'Extra', emoji: 'X', couleur: '#112233' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.categorie, { code: 'X', label: 'Extra', emoji_display: regionalIndicator('X'), color: 0x112233 });
  assert.equal(r.data.cree, true);
  assert.equal((await call('POST', '/config/categorie', { action: 'ajouter', code: 'Y', libelle: 'Y', emoji: 'R' })).status, 400);
  assert.equal((await call('POST', '/config/categorie', { action: 'ajouter', code: 'Y', libelle: 'Y', emoji: '🚮' })).status, 400);
  assert.equal((await call('POST', '/config/categorie', { action: 'retirer', code: 'X' })).data.retire, true);

  // Auteurs
  r = await call('GET', '/auteurs');
  assert.deepEqual(r.data.auteurs.map((x) => x.nom).sort(), ['bob', 'william']);
  await call('POST', '/config/auteur', { action: 'exclure', nom: 'Bob' });
  assert.equal((await call('GET', '/elements?categorie=R')).data.total, 1);
  assert.equal((await call('GET', '/auteurs?q=bo')).data.auteurs[0].exclu, true);
  assert.deepEqual((await call('GET', '/etat')).data.auteurs_exclus, ['Bob']);
  assert.equal((await call('POST', '/config/auteur', { action: 'reinclure', nom: 'bob' })).data.etait_exclu, true);

  // Réaction « à trier »
  assert.equal((await call('POST', '/config/tri', { emoji: R })).status, 400, 'déjà une catégorie');
  assert.equal((await call('POST', '/config/tri', { emoji: '📥' })).data.emoji_tri, '📥');
  await call('POST', '/config/tri', { emoji: '🚮' });

  // Salons disponibles
  r = await call('GET', '/salons-disponibles');
  assert.deepEqual(r.data.salons, [
    { id: CHAN, nom: 'github', categorie_discord: null, surveille: true },
    { id: OTHER, nom: 'general', categorie_discord: null, surveille: false },
  ]);

  // Sync : rien n'a changé sur Discord → la version ne bouge pas
  const before = (await call('GET', '/etat')).data.version;
  r = await call('POST', '/sync', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.salons, [{ salon_id: CHAN, nom: 'github', lus: 4, avec_reactions: 3, supprimes: 0 }]);
  assert.equal(r.data.version, before);

  // Une réaction retirée sur Discord → la version augmente
  msgs[1].reactions.cache.clear();
  r = await call('POST', '/sync', {});
  assert.ok(r.data.version > before);
  assert.equal((await call('GET', '/elements?categorie=R')).data.total, 1);

  // Retrait du salon
  assert.equal((await call('POST', '/config/salon', { action: 'retirer', salon_id: CHAN })).data.retire, true);
  assert.equal((await call('GET', '/etat')).data.salons.length, 0);
});
