import * as store from '../db.js';

const clip = (s) => (s.length > 100 ? `${s.slice(0, 99)}…` : s);

export async function handleAutocomplete(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return interaction.respond([]);
  store.ensureGuild(guildId);

  const focused = interaction.options.getFocused(true);
  const q = String(focused.value ?? '').trim().toLowerCase();
  const sub = interaction.options.getSubcommand(false);
  let choices = [];

  if (focused.name === 'categorie' || focused.name === 'code') {
    choices = store
      .getCategories(guildId)
      .filter((c) => `${c.code} ${c.label}`.toLowerCase().includes(q))
      .map((c) => ({ name: clip(`${c.code} — ${c.label}`), value: c.code }));
  } else if (focused.name === 'nom' && sub === 'reinclure') {
    choices = store
      .getExcludedAuthors(guildId)
      .filter((a) => a.name_lc.includes(q))
      .map((a) => ({ name: clip(a.name), value: clip(a.name) }));
  } else if (focused.name === 'auteur' || focused.name === 'nom') {
    choices = store
      .searchAuthors(guildId, q, { hideExcluded: true })
      .map((a) => ({ name: clip(`${a.author} (${a.n} msg)`), value: clip(a.author) }));
  }

  await interaction.respond(choices.slice(0, 25));
}
