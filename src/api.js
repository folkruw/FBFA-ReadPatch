// API HTTP locale (127.0.0.1) pour la page « Patch notes » de Flash.
// Activée seulement si API_PORT et API_CLE sont définis dans le .env.
// Chaque requête doit porter l'en-tête « x-cle-api » = API_CLE. Réponses en JSON,
// erreurs sous la forme { erreur: "texte lisible" } avec un code 4xx (500 si bug).
import crypto from 'node:crypto';
import http from 'node:http';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import * as actions from './actions.js';
import * as store from './db.js';
import { parseDateInput } from './dates.js';
import { UserError } from './errors.js';
import { backfillGuild, syncGuild } from './scanner.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY = 1_000_000;
const KEY_RE = /^\d{5,25}\.\d{1,3}$/;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/* ───────────── Serveur ───────────── */

export function startApi(client) {
  const rawPort = process.env.API_PORT;
  const apiKey = process.env.API_CLE ?? '';
  if (!rawPort) {
    console.log('ℹ️ API locale désactivée (API_PORT absent du .env)');
    return null;
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`❌ API locale non démarrée : API_PORT invalide (${rawPort}).`);
    return null;
  }
  if (apiKey.length < 16) {
    console.error('❌ API locale non démarrée : API_CLE absente ou trop courte (16 caractères minimum).');
    return null;
  }

  const server = createApiServer(client, apiKey);
  server.on('error', (err) => console.error('❌ API locale :', err.message));
  server.listen(port, '127.0.0.1', () => console.log(`✅ API locale sur http://127.0.0.1:${port}`));
  return server;
}

export function createApiServer(client, apiKey) {
  const keyHash = sha256(apiKey);
  return http.createServer((req, res) => {
    handle(client, keyHash, req, res).catch((err) => {
      console.error('[api]', err);
      if (!res.headersSent) send(res, 500, { erreur: 'Erreur interne du bot.' });
    });
  });
}

async function handle(client, keyHash, req, res) {
  try {
    const provided = req.headers['x-cle-api'];
    if (typeof provided !== 'string' || !crypto.timingSafeEqual(sha256(provided), keyHash)) {
      throw new HttpError(401, 'Clé API manquante ou invalide (en-tête x-cle-api).');
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const route = ROUTES[`${req.method} ${path}`];
    if (!route) {
      const exists = Object.keys(ROUTES).some((k) => k.endsWith(` ${path}`));
      throw exists
        ? new HttpError(405, `Méthode ${req.method} non autorisée sur ${path}.`)
        : new HttpError(404, `Route inconnue : ${req.method} ${path}`);
    }
    const body = req.method === 'POST' ? await readJson(req) : {};
    const query = url.searchParams;
    const guildId = resolveGuild(client, body.guild_id ?? query.get('guild_id'));
    const result = await route({ client, guild: client.guilds.cache.get(guildId), guildId, query, body });
    send(res, 200, result);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { erreur: err.message });
    if (err instanceof UserError) return send(res, 400, { erreur: err.message });
    if (err?.code === 50001 || err?.code === 50013) {
      return send(res, 403, { erreur: "Le bot n'a pas accès à ce salon (permissions manquantes)." });
    }
    throw err;
  }
}

function send(res, status, data) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Corps de requête trop gros.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pas un objet');
        resolve(value);
      } catch {
        reject(new HttpError(400, 'Corps JSON invalide (un objet est attendu).'));
      }
    });
    req.on('error', reject);
  });
}

/* ───────────── Paramètres ───────────── */

/** guild_id fourni, sinon API_GUILD_ID, sinon l'unique serveur du bot. */
function resolveGuild(client, requested) {
  let guildId = requested ? String(requested) : process.env.API_GUILD_ID || null;
  if (!guildId) {
    const size = client.guilds.cache.size;
    if (size === 1) guildId = client.guilds.cache.first().id;
    else throw new HttpError(400, size ? 'Le bot est sur plusieurs serveurs : précise guild_id.' : "Le bot n'est sur aucun serveur.");
  }
  if (!client.guilds.cache.has(guildId)) throw new HttpError(404, `Serveur inconnu : ${guildId}`);
  store.ensureGuild(guildId);
  return guildId;
}

/** Timestamp en ms, ou texte (« 01/11/2026 », « 7j »…) ; vide → null. */
function dateParam(value, { endOfDay = false } = {}) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d{10,}$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `Date invalide : ${value}`);
    return n;
  }
  return parseDateInput(String(value), { endOfDay });
}

function intParam(value, def, min, max, name) {
  if (value == null || value === '') return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `« ${name} » doit être un entier entre ${min} et ${max}.`);
  return n;
}

function boolParam(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'oui'].includes(String(value ?? '').toLowerCase());
}

/** ?auteurs=a,b ou ?auteurs=a&auteurs=b */
function listParam(query, name) {
  return query
    .getAll(name)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

function parParam(par, required) {
  if (par == null) {
    if (required) throw new HttpError(400, '« par » { id, nom } est requis.');
    return null;
  }
  if (typeof par !== 'object' || par.id == null || par.id === '' || typeof par.nom !== 'string' || !par.nom.trim()) {
    throw new HttpError(400, '« par » doit être { id, nom }.');
  }
  return { id: String(par.id).slice(0, 64), nom: par.nom.trim().slice(0, 100) };
}

function categoryParam(guildId, value) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!code) throw new HttpError(400, '« categorie » est requis.');
  if (!store.getCategory(guildId, code)) throw new HttpError(404, `Catégorie inconnue : ${code}`);
  return code;
}

/** Vérifie la clé « messageId.index » et que l'embed existe sur ce serveur. */
function itemParam(guildId, value) {
  const key = String(value ?? '');
  if (!KEY_RE.test(key)) throw new HttpError(400, '« key » invalide (format attendu : "messageId.index").');
  const [item] = store.getItems([key]);
  if (!item || item.guild_id !== guildId) throw new HttpError(404, `Élément introuvable : ${key}`);
  return key;
}

/* ───────────── Mise en forme ───────────── */

const jumpUrl = (i) => `https://discord.com/channels/${i.guild_id}/${i.channel_id}/${i.message_id}`;

function serializeItem(item, info) {
  const d = info.get(item.key) ?? { codes: [], sorted: false, toSort: false, suggested: [] };
  return {
    key: item.key,
    message_id: item.message_id,
    idx: item.idx,
    channel_id: item.channel_id,
    created_at: item.created_at,
    embed_count: item.embed_count,
    author: item.author,
    author_icon: item.author_icon,
    title: item.title,
    description: item.description,
    footer: item.footer,
    url: item.url,
    color: item.color,
    lien_message: jumpUrl(item),
    vu: item.seen_at != null ? { par_nom: item.seen_by_name, le: item.seen_at } : null,
    codes: d.codes,
    sorted: d.sorted,
    toSort: d.toSort,
    suggested: d.suggested,
    tri: d.sorted ? { par_nom: item.sorted_by_name, le: item.sorted_at } : null,
  };
}

function pageOf(guildId, keys, code, query) {
  const limit = intParam(query.get('limite'), 50, 1, 200, 'limite');
  const offset = intParam(query.get('decalage'), 0, 0, 1e9, 'decalage');
  const items = store.getItems(keys.slice(offset, offset + limit), code);
  const info = store.describeItems(guildId, items);
  return { total: keys.length, limite: limit, decalage: offset, items: items.map((i) => serializeItem(i, info)) };
}

const ok = (extra = {}) => ({ ok: true, ...extra, version: store.getVersion() });

/* ───────────── Routes ───────────── */

/** GET /etat?depuis= : config + compteurs de /resume + version. */
async function etat({ client, guildId, query }) {
  const since = dateParam(query.get('depuis'));
  const cats = store.getCategories(guildId);
  return {
    version: store.getVersion(),
    guild_id: guildId,
    categories: cats.map((c) => ({ code: c.code, label: c.label, emoji_display: c.emoji_display, color: c.color })),
    salons: store.getChannels(guildId).map((ch) => ({
      id: ch.channel_id,
      nom: client.channels.cache.get(ch.channel_id)?.name ?? null,
      scanned_since: ch.scanned_since,
    })),
    auteurs_exclus: store.getExcludedAuthors(guildId).map((a) => a.name),
    emoji_tri: store.getSortEmoji(guildId).display,
    resume: {
      categories: cats.map((c) => {
        const { total, unseen } = store.countMessages({ guildId, code: c.code, since });
        return { code: c.code, a_traiter: unseen, total };
      }),
      a_trier: store.countToSort({ guildId, since }),
    },
  };
}

/** GET /elements?categorie=R&depuis=&jusqua=&auteurs=a,b&vus=0|1&ordre=asc|desc&limite=&decalage= */
async function elements({ client, guildId, query }) {
  const code = categoryParam(guildId, query.get('categorie'));
  const since = dateParam(query.get('depuis'));
  const until = dateParam(query.get('jusqua'), { endOfDay: true });
  if (since != null && until != null && until < since) throw new HttpError(400, 'La date de fin est avant la date de début.');
  if (since != null) await backfillGuild(client, guildId, since);
  const keys = store.queryIds({
    guildId,
    code,
    since,
    until,
    authors: listParam(query, 'auteurs').map((a) => a.toLowerCase()),
    showSeen: boolParam(query.get('vus')),
    order: query.get('ordre') === 'desc' ? 'desc' : 'asc',
  });
  return { version: store.getVersion(), categorie: code, ...pageOf(guildId, keys, code, query) };
}

/** POST /vu { key, categorie, vu, par } */
async function vu({ guildId, body }) {
  const key = itemParam(guildId, body.key);
  const code = categoryParam(guildId, body.categorie);
  if (typeof body.vu !== 'boolean') throw new HttpError(400, '« vu » doit être true ou false.');
  if (body.vu) {
    const par = parParam(body.par, true);
    store.setSeen(key, code, par.id, par.nom);
  } else {
    store.unsetSeen(key, code);
  }
  return ok();
}

/** GET /a-trier?tous=0|1&depuis=&jusqua=&limite=&decalage= */
async function aTrier({ client, guildId, query }) {
  const since = dateParam(query.get('depuis'));
  const until = dateParam(query.get('jusqua'), { endOfDay: true });
  if (since != null) await backfillGuild(client, guildId, since);
  const keys = store.querySortIds({ guildId, since, until, includeSorted: boolParam(query.get('tous')) });
  return {
    version: store.getVersion(),
    restant: store.countToSort({ guildId, since, until }),
    ...pageOf(guildId, keys, null, query),
  };
}

/** POST /trier { key, categories: [...] | [] (ignorer) | null (remettre à trier), par } */
async function trier({ guildId, body }) {
  const key = itemParam(guildId, body.key);
  if (!('categories' in body)) throw new HttpError(400, '« categories » est requis (tableau, [] pour ignorer, null pour remettre à trier).');
  if (body.categories === null) {
    store.unsetSort(key);
    return ok();
  }
  if (!Array.isArray(body.categories)) throw new HttpError(400, '« categories » doit être un tableau ou null.');
  const codes = [...new Set(body.categories.map((c) => categoryParam(guildId, c)))];
  const par = parParam(body.par, true);
  store.setSort(key, codes, par.id, par.nom);
  return ok();
}

/** GET /salons-disponibles : salons texte que le bot peut lire. */
async function salonsDisponibles({ client, guild, guildId }) {
  const me = guild.members.me ?? client.user;
  const watched = new Set(store.getChannels(guildId).map((c) => c.channel_id));
  const salons = [...guild.channels.cache.values()]
    .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
    .filter((ch) => ch.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]))
    .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
    .map((ch) => ({ id: ch.id, nom: ch.name, categorie_discord: ch.parent?.name ?? null, surveille: watched.has(ch.id) }));
  return { salons };
}

/** POST /config/salon { action: "ajouter"|"retirer", salon_id, depuis } */
async function configSalon({ guild, guildId, body }) {
  const channelId = String(body.salon_id ?? '');
  if (!/^\d{15,25}$/.test(channelId)) throw new HttpError(400, '« salon_id » invalide.');
  if (body.action === 'ajouter') {
    const since = dateParam(body.depuis) ?? parseDateInput('30j');
    const channel = await actions.resolveTextChannel(guild, channelId);
    const r = await actions.watchChannel(guild, channel, since);
    return ok({ nouveau: r.isNew, lus: r.read, avec_reactions: r.stored, supprimes: r.pruned, depuis: since });
  }
  if (body.action === 'retirer') return ok({ retire: actions.unwatchChannel(guildId, channelId) });
  throw new HttpError(400, '« action » doit être "ajouter" ou "retirer".');
}

/** POST /config/categorie { action: "ajouter"|"retirer", code, libelle, emoji, couleur } */
async function configCategorie({ guild, guildId, body }) {
  if (body.action === 'ajouter') {
    const { created, category: c } = actions.saveCategory(guild, {
      code: body.code,
      label: body.libelle,
      emoji: body.emoji,
      color: body.couleur,
    });
    return ok({ cree: created, categorie: { code: c.code, label: c.label, emoji_display: c.emoji_display, color: c.color } });
  }
  if (body.action === 'retirer') return ok({ retire: actions.removeCategory(guildId, body.code) });
  throw new HttpError(400, '« action » doit être "ajouter" ou "retirer".');
}

/** POST /config/auteur { action: "exclure"|"reinclure", nom } */
async function configAuteur({ guildId, body }) {
  if (body.action === 'exclure') return ok({ nom: actions.excludeAuthor(guildId, body.nom) });
  if (body.action === 'reinclure') return ok({ etait_exclu: actions.includeAuthor(guildId, body.nom) });
  throw new HttpError(400, '« action » doit être "exclure" ou "reinclure".');
}

/** POST /config/tri { emoji } */
async function configTri({ guild, body }) {
  const emoji = actions.setSortEmoji(guild, body.emoji);
  return ok({ emoji_tri: emoji.display });
}

/** POST /sync { depuis } */
async function sync({ client, guildId, body }) {
  const since = dateParam(body.depuis);
  const results = await syncGuild(client, guildId, since);
  return ok({
    salons: results.map((r) => ({
      salon_id: r.channelId,
      nom: client.channels.cache.get(r.channelId)?.name ?? null,
      ...(r.error ? { erreur: r.error } : { lus: r.read, avec_reactions: r.stored, supprimes: r.pruned }),
    })),
  });
}

/** GET /auteurs?q= */
async function auteurs({ guildId, query }) {
  const excluded = new Set(store.getExcludedAuthors(guildId).map((a) => a.name_lc));
  return {
    auteurs: store
      .searchAuthors(guildId, query.get('q') ?? '')
      .map((a) => ({ nom: a.author, nom_lc: a.author_lc, embeds: a.n, exclu: excluded.has(a.author_lc) })),
  };
}

const ROUTES = {
  'GET /etat': etat,
  'GET /elements': elements,
  'POST /vu': vu,
  'GET /a-trier': aTrier,
  'POST /trier': trier,
  'GET /salons-disponibles': salonsDisponibles,
  'POST /config/salon': configSalon,
  'POST /config/categorie': configCategorie,
  'POST /config/auteur': configAuteur,
  'POST /config/tri': configTri,
  'POST /sync': sync,
  'GET /auteurs': auteurs,
};
