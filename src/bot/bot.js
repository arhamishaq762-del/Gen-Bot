// ============================================================
// Discord bot — custom command engine
// - Per-guild slash commands registered dynamically
// - Role restriction, message-count & status requirements
// - Per-user cooldowns, text or embed replies
// - Delivery: public / ephemeral / DM
// ============================================================
import {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  REST, Routes, SlashCommandBuilder, PermissionsBitField, MessageFlags,
} from 'discord.js';
import { q, audit } from '../db/database.js';

const DEMO = process.env.DEMO_MODE === 'true';

export const client = DEMO ? null : new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,   // count messages for requirements
    GatewayIntentBits.GuildPresences,  // read custom status for requirements
    GatewayIntentBits.GuildMembers,    // role checks
  ],
  partials: [Partials.GuildMember],
});

let rest = null;

// Debounced per-guild slash-command sync so rapid dashboard edits
// don't hammer the Discord API. [rate-limit awareness §8]
const syncTimers = new Map();
export function scheduleGuildSync(guildId) {
  if (DEMO) return;
  clearTimeout(syncTimers.get(guildId));
  syncTimers.set(guildId, setTimeout(() => syncGuildCommands(guildId).catch(e =>
    console.error(`[bot] sync failed for ${guildId}:`, e.message)), 2500));
}

const BUILTIN = [
  new SlashCommandBuilder().setName('help').setDescription('Show available custom commands'),
  new SlashCommandBuilder().setName('rank').setDescription('Show your message count on this server'),
];

export async function syncGuildCommands(guildId) {
  if (DEMO || !rest) return;
  const cmds = q.listEnabledCommands.all(guildId);
  const body = [
    ...BUILTIN.map(b => b.toJSON()),
    ...cmds.map(c =>
      new SlashCommandBuilder()
        .setName(c.name)
        .setDescription((c.description || 'Custom command').slice(0, 100))
        .toJSON()
    ),
  ];
  await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId), { body });
  console.log(`[bot] synced ${cmds.length} custom commands for guild ${guildId}`);
}

function buildEmbed(c) {
  const e = new EmbedBuilder();
  if (c.embed_title) e.setTitle(c.embed_title.slice(0, 256));
  if (c.embed_description) e.setDescription(c.embed_description.slice(0, 4000));
  if (c.embed_footer) e.setFooter({ text: c.embed_footer.slice(0, 2048) });
  if (c.embed_image && /^https:\/\//i.test(c.embed_image)) e.setImage(c.embed_image);
  try { e.setColor(c.embed_color || '#5865F2'); } catch { e.setColor('#5865F2'); }
  return e;
}

// Placeholders are substituted server-side with known-safe values only.
function fillPlaceholders(text, interaction) {
  if (!text) return text;
  return text
    .replaceAll('{user}', `<@${interaction.user.id}>`)
    .replaceAll('{username}', interaction.user.username.slice(0, 32))
    .replaceAll('{server}', interaction.guild?.name?.slice(0, 100) ?? 'this server');
}

async function handleCustomCommand(interaction) {
  const c = q.getCommandByName.get(interaction.guildId, interaction.commandName);
  if (!c) return false;

  const member = interaction.member;

  // --- Permission check: required role [§4 permission checks] ---
  if (c.required_role_id) {
    const hasRole = member?.roles?.cache?.has?.(c.required_role_id)
      ?? member?.roles?.includes?.(c.required_role_id);
    if (!hasRole) {
      await interaction.reply({
        content: `🔒 You need the <@&${c.required_role_id}> role to use this command.`,
        flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
      });
      return true;
    }
  }

  // --- Requirement: minimum message count ---
  if (c.req_min_messages > 0) {
    const row = q.getMsgCount.get(interaction.guildId, interaction.user.id);
    const count = row?.count ?? 0;
    if (count < c.req_min_messages) {
      await interaction.reply({
        content: `📊 You need **${c.req_min_messages}** messages on this server to unlock this command. You have **${count}** (${c.req_min_messages - count} to go).`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
  }

  // --- Requirement: custom status contains text ---
  if (c.req_status_text) {
    const presence = member?.presence ?? interaction.guild?.presences?.cache?.get(interaction.user.id);
    const custom = presence?.activities?.find(a => a.type === 4); // ActivityType.Custom
    const statusText = (custom?.state || '').toLowerCase();
    if (!statusText.includes(c.req_status_text.toLowerCase())) {
      await interaction.reply({
        content: `✏️ To unlock this command, set your Discord custom status to include: **${c.req_status_text}**`,
        flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] },
      });
      return true;
    }
  }

  // --- Cooldown [§8 rate limiting] ---
  if (c.cooldown_seconds > 0) {
    const now = Math.floor(Date.now() / 1000);
    const row = q.getCooldown.get(c.id, interaction.user.id);
    if (row && now - row.last_used < c.cooldown_seconds) {
      const wait = c.cooldown_seconds - (now - row.last_used);
      await interaction.reply({
        content: `⏳ Slow down! You can use \`/${c.name}\` again in **${wait}s**.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    q.setCooldown.run(c.id, interaction.user.id, now);
  }

  // --- Build response ---
  // allowedMentions blocks @everyone / role pings even if an admin put them
  // in the response text — prevents mention-abuse via the dashboard.
  const safeMentions = { parse: ['users'] };
  const payload = {};
  if (c.response_type === 'embed') {
    payload.embeds = [buildEmbed({
      ...c,
      embed_title: fillPlaceholders(c.embed_title, interaction),
      embed_description: fillPlaceholders(c.embed_description, interaction),
    })];
    if (c.response_text) payload.content = fillPlaceholders(c.response_text, interaction).slice(0, 2000);
  } else {
    payload.content = fillPlaceholders(c.response_text, interaction).slice(0, 2000);
  }
  payload.allowedMentions = safeMentions;

  // --- Delivery mode ---
  try {
    if (c.delivery === 'dm') {
      await interaction.user.send(payload);
      await interaction.reply({ content: '📬 Check your DMs!', flags: MessageFlags.Ephemeral });
    } else if (c.delivery === 'ephemeral') {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply(payload);
    }
    q.incrementUses.run(c.id);
  } catch (err) {
    // Generic error to user, details only to server logs [§5 no data leaks]
    console.error(`[bot] failed to deliver /${c.name}:`, err.message);
    const msg = c.delivery === 'dm'
      ? '⚠️ I couldn\'t DM you — your DMs may be closed.'
      : '⚠️ Something went wrong running that command.';
    if (!interaction.replied) {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  return true;
}

export function startBot() {
  if (DEMO) {
    console.log('[bot] DEMO_MODE — Discord connection skipped');
    return;
  }

  rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  client.once('clientReady', async () => {
    console.log(`[bot] logged in as ${client.user.tag}`);
    for (const [guildId] of client.guilds.cache) {
      await syncGuildCommands(guildId).catch(e => console.error('[bot] initial sync:', e.message));
    }
  });

  client.on('guildCreate', (guild) => {
    console.log(`[bot] joined guild ${guild.id}`);
    syncGuildCommands(guild.id).catch(() => {});
  });

  // Count messages for the message-count requirement (bots excluded)
  client.on('messageCreate', (msg) => {
    if (msg.author.bot || !msg.guildId) return;
    q.bumpMsgCount.run(msg.guildId, msg.author.id);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.guildId) return;
    try {
      if (interaction.commandName === 'help') {
        const cmds = q.listEnabledCommands.all(interaction.guildId);
        const list = cmds.length
          ? cmds.map(c => `• \`/${c.name}\` — ${c.description}`).join('\n').slice(0, 3900)
          : '*No custom commands yet. Ask an admin to create some on the dashboard!*';
        const e = new EmbedBuilder().setTitle('📋 Custom Commands').setDescription(list).setColor('#5865F2');
        return interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
      }
      if (interaction.commandName === 'rank') {
        const row = q.getMsgCount.get(interaction.guildId, interaction.user.id);
        return interaction.reply({
          content: `💬 You have sent **${row?.count ?? 0}** messages on this server (since the bot joined).`,
          flags: MessageFlags.Ephemeral,
        });
      }
      await handleCustomCommand(interaction);
    } catch (err) {
      console.error('[bot] interaction error:', err);
      if (!interaction.replied && !interaction.deferred) {
        interaction.reply({ content: '⚠️ Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  client.login(process.env.DISCORD_TOKEN).catch((e) => {
    console.error('[bot] LOGIN FAILED:', e.message);
    console.error('[bot] The dashboard will still run, but bot features are offline until DISCORD_TOKEN is valid.');
  });
}
