import './env.js';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { startApi } from './api.js';
import * as store from './db.js';
import { handleAutocomplete } from './commands/autocomplete.js';
import { handleConfig } from './commands/config.js';
import { commandsJSON } from './commands/definitions.js';
import { handleListe, handleListeComponent } from './commands/liste.js';
import { handleResume, handleSync } from './commands/resume.js';
import { handleTrier, handleTrierComponent } from './commands/trier.js';
import { UserError } from './errors.js';
import { refreshMessage, startupSync } from './scanner.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN manquant : copie .env.example en .env et remplis-le.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent, // nécessaire pour lire le contenu des embeds
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

// Commandes enregistrées par serveur : elles apparaissent immédiatement (les globales peuvent tarder).
async function registerCommands(guild) {
  try {
    await guild.commands.set(commandsJSON);
    console.log(`✅ Commandes slash enregistrées sur « ${guild.name} »`);
  } catch (err) {
    console.error(`❌ Impossible d'enregistrer les commandes sur « ${guild.name} » :`, err.message);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Connecté en tant que ${c.user.tag} (${c.guilds.cache.size} serveur(s))`);

  // Supprime d'éventuelles commandes globales (sinon elles apparaîtraient en double).
  await c.application.commands.set([]).catch((err) => console.error('Nettoyage des commandes globales :', err.message));

  for (const guild of c.guilds.cache.values()) {
    store.ensureGuild(guild.id);
    await registerCommands(guild);
  }

  apiServer = startApi(c);
  await startupSync(c);
  console.log('✅ Synchronisation de démarrage terminée');
});

client.on(Events.GuildCreate, async (guild) => {
  store.ensureGuild(guild.id);
  await registerCommands(guild);
});

/* ───── Interactions ───── */

async function replyError(interaction, content) {
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content, embeds: [], components: [] });
    } else if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch {
    /* interaction expirée */
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);

    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'liste':
          return await handleListe(interaction);
        case 'trier':
          return await handleTrier(interaction);
        case 'resume':
          return await handleResume(interaction);
        case 'sync':
          return await handleSync(interaction);
        case 'config':
          return await handleConfig(interaction);
        default:
          return;
      }
    }

    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('lv:')) return await handleListeComponent(interaction);
      if (interaction.customId.startsWith('lt:')) return await handleTrierComponent(interaction);
    }
  } catch (err) {
    if (err instanceof UserError) return replyError(interaction, `❌ ${err.message}`);
    if (err?.code === 50001 || err?.code === 50013) {
      return replyError(interaction, "❌ Je n'ai pas accès à ce salon (permissions manquantes).");
    }
    console.error(err);
    if (!interaction.isAutocomplete()) await replyError(interaction, '❌ Une erreur inattendue est survenue.');
  }
});

/* ───── Synchro en direct des réactions ───── */

const onReaction = (reaction) => refreshMessage(client, reaction.message.channelId, reaction.message.id);
client.on(Events.MessageReactionAdd, onReaction);
client.on(Events.MessageReactionRemove, onReaction);
client.on(Events.MessageReactionRemoveEmoji, onReaction);
client.on(Events.MessageReactionRemoveAll, (message) => refreshMessage(client, message.channelId, message.id));
client.on(Events.MessageUpdate, (_old, message) => {
  if (store.hasMessage(message.id)) refreshMessage(client, message.channelId, message.id);
});
client.on(Events.MessageDelete, (message) => {
  if (store.hasMessage(message.id)) store.deleteMessages([message.id]);
});
client.on(Events.MessageBulkDelete, (messages) => {
  store.deleteMessages([...messages.keys()].filter((id) => store.hasMessage(id)));
});

client.on(Events.Error, (err) => console.error('[discord]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

let apiServer = null;

function shutdown() {
  console.log('Arrêt…');
  apiServer?.close();
  client.destroy().finally(() => {
    store.sqlite.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(token).catch((err) => {
  if (/disallowed intents/i.test(err.message)) {
    console.error(
      '❌ Intent refusé : active « MESSAGE CONTENT INTENT » dans le portail développeur Discord (onglet Bot → Privileged Gateway Intents).',
    );
  } else {
    console.error('❌ Connexion impossible :', err.message);
  }
  process.exit(1);
});
