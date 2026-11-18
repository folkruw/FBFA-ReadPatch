# Bot de logs par réactions

Le bot lit les messages **embed** d'un ou plusieurs salons (ex. les commits postés par un webhook) et les classe selon les **réactions** qu'on y met :

| Réaction | Catégorie (par défaut) |
|---|---|
| 🇷 | **R** — Responsable |
| 🇬 | **G** — Gestionnaire |
| 🇲 | **M** — Mise à jour |
| 🚮 | **À trier** : on choisit la catégorie de chaque embed avec `/trier` |

- Un message **sans réaction n'est pas lu**.
- **Chaque embed compte séparément.** Un message de 3 embeds réagi 🇷 donne 3 éléments dans R.
- Pour chaque embed on garde : date et heure, auteur (« william » dans l'embed), titre, description, footer.
- `/liste` affiche les embeds d'une catégorie, avec des **cases à cocher « déjà vu »**. Un embed coché n'apparaît plus, sauf si on active « Déjà vus affichés ».
- Le « déjà vu » est **par catégorie** : un embed coché dans R reste à traiter dans G.
- Les réactions ajoutées ou retirées sont suivies en direct. Au redémarrage, le bot rattrape ce qui a changé pendant qu'il était éteint.

## Installation

**Prérequis :** Node.js 22.13 ou plus récent (testé avec Node 24). Il n'y a rien d'autre à installer : la base SQLite est intégrée à Node.

1. Sur le [portail développeur Discord](https://discord.com/developers/applications), crée une application, puis dans l'onglet **Bot** :
   - copie le token (bouton *Reset Token*) ;
   - active **MESSAGE CONTENT INTENT** (sans lui, le contenu des embeds est vide).
2. Invite le bot. Remplace `TON_CLIENT_ID` par l'*Application ID* (onglet General Information) :
   ```
   https://discord.com/oauth2/authorize?client_id=TON_CLIENT_ID&scope=bot+applications.commands&permissions=66560
   ```
   L'invitation donne deux permissions : *Voir les salons* et *Voir l'historique des messages*.
3. Dans le dossier du bot :
   ```bash
   cp .env.example .env     # puis colle le token dans DISCORD_TOKEN
   npm install
   npm start
   ```
   Les commandes slash s'enregistrent toutes seules sur chaque serveur au démarrage (et quand le bot rejoint un nouveau serveur).

## Configuration

| Commande | Rôle |
|---|---|
| `/config salon ajouter salon:#logs depuis:01/11/2026` | Surveille le salon et lit son historique (30 derniers jours par défaut) |
| `/config salon retirer salon:#logs` | Arrête de surveiller le salon |
| `/config categorie ajouter code:R libelle:Responsable emoji:R` | Crée ou modifie une catégorie. `emoji` accepte une lettre (`R` → 🇷), un emoji (`✅`) ou un emoji du serveur (`:nom:`). `couleur:#E67E22` est optionnel |
| `/config categorie retirer code:R` | Supprime la catégorie |
| `/config auteur exclure nom:william` | Masque partout les messages de cet auteur |
| `/config auteur reinclure nom:william` | Annule l'exclusion |
| `/config tri emoji:🚮` | Change la réaction « à trier » (🚮 par défaut) |
| `/config voir` | Affiche la configuration |
| `/sync [depuis]` | Relit l'historique à la main |

## Utilisation

```
/liste categorie:R depuis:01/11/2026 jusqua:15/11/2026 auteur:william vus:False ordre:asc
```

Seule `categorie` est obligatoire. Les dates acceptent `01/11/2026`, `01/11 18:30`, `2026-11-01`, `7j`, `24h`, `2sem`, `1mois`, `hier` et `aujourd'hui`. Si tu demandes une date plus ancienne que ce qui a déjà été lu, le bot va chercher les messages manquants.

La liste n'est visible que par toi et affiche 5 messages par page :

- **⬜ #1 … ⬜ #5** : cocher ou décocher « déjà vu ». Un message coché reste affiché, en vert, jusqu'au prochain **🔄 Actualiser**, pour éviter de décaler les pages.
- **◀️ ▶️** : changer de page.
- **🙈 Déjà vus masqués / 👁️ Déjà vus affichés** : affiche ou cache les messages déjà traités.
- **☑️ Tout cocher (page)** et **Tout décocher (page)**.
- Un menu pour **changer de catégorie**, et un menu pour **filtrer les auteurs** (choix multiple ; aucun choix = tous les auteurs).
- Le titre de chaque message renvoie vers le message d'origine.

`/resume [depuis]` donne le nombre d'embeds à traiter dans chaque catégorie, et le nombre d'embeds à trier.

### Trier un message à plusieurs embeds (🚮)

1. Mets la réaction **🚮** sur le message. Tant qu'il n'est pas trié, il n'apparaît dans **aucune** catégorie, même s'il a aussi 🇷 ou 🇬.
2. `/trier` affiche chaque embed de ces messages, 4 par page. Le footer indique « Embed 2/3 » et les réactions présentes sur le message.
3. Dans le menu de chaque embed, choisis une ou plusieurs catégories, ou **🗑️ Ignorer**. Le choix est enregistré tout de suite.
4. L'embed apparaît ensuite dans `/liste` pour les catégories choisies.

Pour corriger un tri, utilise `/trier tous:True`, qui réaffiche aussi les embeds déjà triés. Vider le menu d'un embed le remet « à trier ». Un tri reste valable même si on retire ensuite la réaction 🚮.

### Qui peut utiliser quoi

Par défaut, tout le monde peut utiliser toutes les commandes, `/config` compris. Pour réserver une commande à certains rôles : *Paramètres du serveur → Intégrations → Auto Read Log*.

## API locale (pour la page « Patch notes » de Flash)

L'API est désactivée par défaut. Pour l'activer, ajoute dans `.env` :
```
API_PORT=3021
API_CLE=<clé secrète de 16 caractères minimum, la même dans le .env de Flash>
```
Elle n'écoute que sur `127.0.0.1`, et chaque requête doit porter l'en-tête `x-cle-api: <API_CLE>`. Les réponses sont en JSON ; les erreurs prennent la forme `{ "erreur": "…" }`, avec le code HTTP 400, 401, 403, 404, 405 ou 413.

| Route | Rôle |
|---|---|
| `GET /etat?depuis=` | Catégories, salons, auteurs exclus, réaction de tri, compteurs de `/resume`, et `version` (augmente à chaque changement) |
| `GET /elements?categorie=R&depuis=&jusqua=&auteurs=a,b&vus=0\|1&ordre=asc\|desc&limite=50&decalage=0` | Embeds d'une catégorie, avec le `total` |
| `POST /vu` `{ key, categorie, vu: true\|false, par: { id, nom } }` | Coche ou décoche « déjà vu » |
| `GET /a-trier?tous=0\|1&depuis=&jusqua=&limite=&decalage=` | Embeds des messages 🚮 |
| `POST /trier` `{ key, categories: [..] \| [] \| null, par }` | Trie un embed (`[]` = ignorer, `null` = remettre à trier) |
| `GET /salons-disponibles` | Salons texte lisibles par le bot |
| `POST /config/salon` `{ action: "ajouter"\|"retirer", salon_id, depuis }` | Comme `/config salon` (ajouter lance la lecture de l'historique) |
| `POST /config/categorie` `{ action, code, libelle, emoji, couleur }` | Comme `/config categorie` |
| `POST /config/auteur` `{ action: "exclure"\|"reinclure", nom }` | Comme `/config auteur` |
| `POST /config/tri` `{ emoji }` | Comme `/config tri` |
| `POST /sync` `{ depuis }` | Comme `/sync` |
| `GET /auteurs?q=` | Auteurs connus, avec le drapeau `exclu` |

Les dates acceptent un timestamp en millisecondes ou le texte des commandes (`01/11/2026`, `7j`…). Si le bot est sur plusieurs serveurs, ajoute `guild_id` (dans l'URL ou le corps) ou `API_GUILD_ID` dans `.env`.

## Fichiers

```
src/index.js               connexion Discord, événements (réactions en direct)
src/scanner.js             lecture de l'historique et des réactions
src/db.js                  base SQLite (data/bot.db)
src/api.js                 API locale pour Flash
src/actions.js             actions de config partagées (commandes et API)
src/commands/liste.js      vue /liste (pages, cases à cocher, filtres)
src/commands/trier.js      vue /trier (catégorie de chaque embed)
src/commands/common.js     sessions et mise en page partagées
src/commands/config.js     /config
src/commands/resume.js     /resume et /sync
src/commands/definitions.js déclaration des commandes slash
test/core.test.js          tests (npm test)
```
