import { ChannelType, InteractionContextType, SlashCommandBuilder } from 'discord.js';

const DATE_EX = '01/11/2026, 01/11 18:30, 7j, 24h, 2sem, hier';

const liste = new SlashCommandBuilder()
  .setName('liste')
  .setDescription("Affiche les messages d'une catégorie (R, G, M…) avec cases « déjà vu »")
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o.setName('categorie').setDescription('Catégorie (réaction) à afficher').setRequired(true).setAutocomplete(true),
  )
  .addStringOption((o) => o.setName('depuis').setDescription(`Date de début. Ex. : ${DATE_EX}`))
  .addStringOption((o) => o.setName('jusqua').setDescription(`Date de fin (incluse). Ex. : ${DATE_EX}`))
  .addStringOption((o) =>
    o.setName('auteur').setDescription('Ne montrer que cet auteur (modifiable ensuite)').setAutocomplete(true),
  )
  .addBooleanOption((o) => o.setName('vus').setDescription('Afficher aussi les messages déjà vus (défaut : non)'))
  .addStringOption((o) =>
    o
      .setName('ordre')
      .setDescription("Ordre d'affichage (défaut : plus anciens d'abord)")
      .addChoices({ name: "Plus anciens d'abord", value: 'asc' }, { name: "Plus récents d'abord", value: 'desc' }),
  );

const trier = new SlashCommandBuilder()
  .setName('trier')
  .setDescription('Répartir dans les catégories les embeds des messages marqués « à trier » (🚮)')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('depuis').setDescription(`Date de début. Ex. : ${DATE_EX}`))
  .addBooleanOption((o) => o.setName('tous').setDescription('Afficher aussi les embeds déjà triés (pour corriger)'));

const resume = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('Nombre de messages à traiter par catégorie')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('depuis').setDescription(`Date de début. Ex. : ${DATE_EX}`));

const sync = new SlashCommandBuilder()
  .setName('sync')
  .setDescription("Relit l'historique des salons surveillés (réactions ajoutées/retirées)")
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) =>
    o.setName('depuis').setDescription('Relire depuis (défaut : tout ce qui a déjà été lu). Ex. : 01/11/2026, 7j'),
  );

const config = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Configurer le bot de logs')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('voir').setDescription('Afficher la configuration actuelle'))
  .addSubcommand((s) =>
    s
      .setName('tri')
      .setDescription('Changer la réaction « à trier » (par défaut 🚮)')
      .addStringOption((o) =>
        o.setName('emoji').setDescription('Réaction : un emoji (🚮) ou :emoji_du_serveur:').setRequired(true),
      ),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('salon')
      .setDescription('Salons contenant les embeds à lire')
      .addSubcommand((s) =>
        s
          .setName('ajouter')
          .setDescription("Surveiller un salon et récupérer son historique")
          .addChannelOption((o) =>
            o
              .setName('salon')
              .setDescription('Salon des logs')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addStringOption((o) =>
            o.setName('depuis').setDescription("Récupérer l'historique depuis (défaut : 30j). Ex. : 01/11/2026, 7j, 2sem"),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('retirer')
          .setDescription('Ne plus surveiller un salon (oublie ses messages)')
          .addChannelOption((o) =>
            o
              .setName('salon')
              .setDescription('Salon à retirer')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      ),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('categorie')
      .setDescription('Catégories = réactions (R → Responsable…)')
      .addSubcommand((s) =>
        s
          .setName('ajouter')
          .setDescription('Créer ou modifier une catégorie')
          .addStringOption((o) =>
            o.setName('code').setDescription('Code court, ex. R').setRequired(true).setMaxLength(10),
          )
          .addStringOption((o) =>
            o.setName('libelle').setDescription('Nom affiché, ex. Responsable').setRequired(true).setMaxLength(50),
          )
          .addStringOption((o) =>
            o
              .setName('emoji')
              .setDescription('Réaction : une lettre (R → 🇷), un emoji (✅) ou :emoji_du_serveur:')
              .setRequired(true),
          )
          .addStringOption((o) => o.setName('couleur').setDescription('Couleur hexadécimale, ex. #E67E22')),
      )
      .addSubcommand((s) =>
        s
          .setName('retirer')
          .setDescription('Supprimer une catégorie')
          .addStringOption((o) =>
            o.setName('code').setDescription('Catégorie à supprimer').setRequired(true).setAutocomplete(true),
          ),
      ),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('auteur')
      .setDescription('Auteurs dont on ne veut pas voir les messages')
      .addSubcommand((s) =>
        s
          .setName('exclure')
          .setDescription("Masquer tous les messages d'un auteur")
          .addStringOption((o) =>
            o.setName('nom').setDescription("Nom de l'auteur (tel qu'affiché dans l'embed)").setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('reinclure')
          .setDescription("Réafficher les messages d'un auteur exclu")
          .addStringOption((o) =>
            o.setName('nom').setDescription('Auteur exclu').setRequired(true).setAutocomplete(true),
          ),
      ),
  );

export const commandsJSON = [liste, trier, resume, sync, config].map((c) => c.toJSON());
