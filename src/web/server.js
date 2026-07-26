// ============================================================
// Web dashboard server
// Security measures applied (per Security Prompt Pack):
//  §2  All secrets via env vars, never in code
//  §3  httpOnly/sameSite session cookies, real logout, OAuth2 state
//  §4  Every guild API route verifies the user is an ADMIN of that
//      guild AND the bot is in it — server-side, per request
//  §5  Generic error messages to clients, details to server logs
//  §6  Parameterized SQL, JSON API + CSP, sameSite CSRF defense
//  §8  Rate limiting on auth + API routes
//  §13 Audit log of every command change
// ============================================================
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { q, qAdmin, validateCommandInput, isSnowflake, audit } from '../db/database.js';
import { client, scheduleGuildSync } from '../bot/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO = process.env.DEMO_MODE === 'true';
const PROD = process.env.NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Security headers [§9, §11] ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      // https: needed so the live preview can show user-supplied embed
      // image URLs (validated server-side to be https-only)
      imgSrc: ["'self'", 'https:', 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '32kb' })); // small body limit [§1]

// --- Sessions [§3: httpOnly, sameSite, secure in prod, rolling expiry] ---
if (!DEMO && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.warn('[web] WARNING: SESSION_SECRET is missing or too short. Set a 48+ char random value in .env');
}
app.use(session({
  name: 'ccb.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex'),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',       // CSRF defense [§6]
    secure: PROD,          // HTTPS-only cookie in production [§9]
    maxAge: 1000 * 60 * 60 * 6, // 6h sessions
  },
}));

// --- Rate limiters [§8] ---
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use('/auth', authLimiter);
app.use('/api', apiLimiter);

// --- Static files ---
app.use(express.static(path.join(__dirname, '../../public'), { index: false, maxAge: PROD ? '1h' : 0 }));

// ============ Discord OAuth2 ============
const DISCORD_API = 'https://discord.com/api/v10';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

app.get('/auth/login', (req, res) => {
  if (DEMO) {
    // Demo login — mock user, no Discord needed
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.user = { id: '100000000000000001', username: 'demo_admin', avatar: null, global_name: 'Demo Admin' };
      res.redirect('/dashboard');
    });
    return;
  }
  // OAuth2 state param prevents CSRF on the callback [§3]
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const url = new URL(`${DISCORD_API.replace('/api/v10', '')}/oauth2/authorize`);
  url.searchParams.set('client_id', process.env.DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify guilds');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'none');
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  if (DEMO) return res.redirect('/dashboard');
  try {
    const { code, state } = req.query;
    if (!code || typeof code !== 'string' || !state || state !== req.session.oauthState) {
      return res.redirect('/?error=auth');
    }
    delete req.session.oauthState;

    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
    const token = await tokenRes.json();

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userRes.ok) throw new Error(`user fetch failed: ${userRes.status}`);
    const user = await userRes.json();

    // Regenerate session on login — prevents session fixation [§3]
    const accessToken = token.access_token;
    req.session.regenerate((err) => {
      if (err) return res.redirect('/?error=auth');
      req.session.user = {
        id: user.id, username: user.username,
        global_name: user.global_name || user.username, avatar: user.avatar,
      };
      // Access token stays server-side only; never sent to the browser [§2]
      req.session.discordAccessToken = accessToken;
      req.session.guildCacheAt = 0;
      res.redirect('/dashboard');
    });
  } catch (err) {
    console.error('[web] oauth error:', err.message); // details to logs only [§5]
    res.redirect('/?error=auth');
  }
});

app.post('/auth/logout', (req, res) => {
  // Real logout: destroy server-side session, not just the cookie [§3]
  req.session.destroy(() => {
    res.clearCookie('ccb.sid');
    res.json({ ok: true });
  });
});

// ============ Auth middleware ============
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

// Fetch user's guilds from Discord (cached in session 60s to respect rate limits)
async function getUserAdminGuilds(req) {
  if (DEMO) {
    return [
      { id: '200000000000000001', name: 'Genspark Gaming', icon: null, botIn: true },
      { id: '200000000000000002', name: 'Dev Lounge', icon: null, botIn: true },
      { id: '200000000000000003', name: 'Anime Club', icon: null, botIn: false },
    ];
  }
  const now = Date.now();
  if (req.session.adminGuilds && now - (req.session.guildCacheAt || 0) < 60_000) {
    return req.session.adminGuilds;
  }
  const r = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${req.session.discordAccessToken}` },
  });
  if (r.status === 401) { req.session.destroy(() => {}); throw Object.assign(new Error('token expired'), { code: 401 }); }
  if (!r.ok) throw new Error(`guilds fetch failed: ${r.status}`);
  const guilds = await r.json();

  // Only guilds where the USER has Administrator or Manage Server [§4]
  const admin = guilds.filter(g => {
    const perms = BigInt(g.permissions ?? 0);
    return g.owner || (perms & ADMINISTRATOR) === ADMINISTRATOR || (perms & MANAGE_GUILD) === MANAGE_GUILD;
  }).map(g => ({
    id: g.id, name: g.name, icon: g.icon,
    botIn: Boolean(client?.guilds?.cache?.has(g.id)),
  }));

  req.session.adminGuilds = admin;
  req.session.guildCacheAt = now;
  return admin;
}

// Per-request server-side guild permission check.
// Prevents IDOR: changing the guild ID in the URL gets you a 403. [§4]
async function requireGuildAdmin(req, res, next) {
  try {
    const { guildId } = req.params;
    if (!isSnowflake(guildId)) return res.status(400).json({ error: 'Invalid guild ID' });
    const guilds = await getUserAdminGuilds(req);
    const guild = guilds.find(g => g.id === guildId);
    if (!guild) return res.status(403).json({ error: 'You are not an administrator of this server' });
    if (!guild.botIn) return res.status(403).json({ error: 'The bot is not in this server yet' });
    req.guild = guild;
    next();
  } catch (err) {
    if (err.code === 401) return res.status(401).json({ error: 'Session expired, please log in again' });
    console.error('[web] guild check error:', err.message);
    res.status(502).json({ error: 'Could not verify server permissions, try again' });
  }
}

// ============ API ============
app.get('/api/me', requireAuth, (req, res) => {
  const u = req.session.user;
  res.json({
    id: u.id, username: u.username, global_name: u.global_name,
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
    demo: DEMO,
  });
});

app.get('/api/guilds', requireAuth, async (req, res) => {
  try {
    const guilds = await getUserAdminGuilds(req);
    const inviteUrl = DEMO ? '#' :
      `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&permissions=277025507392&scope=bot%20applications.commands`;
    res.json({ guilds, inviteUrl });
  } catch (err) {
    if (err.code === 401) return res.status(401).json({ error: 'Session expired' });
    console.error('[web] /api/guilds:', err.message);
    res.status(502).json({ error: 'Could not load your servers, try again' });
  }
});

// Guild info: roles for the role-picker + stats
app.get('/api/guilds/:guildId', requireAuth, requireGuildAdmin, async (req, res) => {
  try {
    let roles = [];
    let memberCount = null;
    if (DEMO) {
      roles = [
        { id: '300000000000000001', name: 'Moderator', color: '#e67e22' },
        { id: '300000000000000002', name: 'VIP', color: '#9b59b6' },
        { id: '300000000000000003', name: 'Member', color: '#3498db' },
      ];
      memberCount = 128;
    } else {
      const g = client.guilds.cache.get(req.params.guildId);
      if (g) {
        memberCount = g.memberCount;
        roles = g.roles.cache
          .filter(r => r.id !== g.id && !r.managed)
          .sort((a, b) => b.position - a.position)
          .map(r => ({ id: r.id, name: r.name.slice(0, 100), color: r.hexColor === '#000000' ? '#99aab5' : r.hexColor }));
      }
    }
    const count = q.countCommands.get(req.params.guildId)?.n ?? 0;
    const totalUses = q.listCommands.all(req.params.guildId).reduce((s, c) => s + c.uses, 0);
    res.json({ guild: req.guild, roles, memberCount, commandCount: count, totalUses });
  } catch (err) {
    console.error('[web] guild info:', err.message);
    res.status(500).json({ error: 'Could not load server info' });
  }
});

app.get('/api/guilds/:guildId/commands', requireAuth, requireGuildAdmin, (req, res) => {
  res.json({ commands: q.listCommands.all(req.params.guildId) });
});

const MAX_COMMANDS_PER_GUILD = 80; // Discord caps guild slash commands at 100

app.post('/api/guilds/:guildId/commands', requireAuth, requireGuildAdmin, writeLimiter, (req, res) => {
  const { errors, data } = validateCommandInput(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(' • ') });

  if ((q.countCommands.get(req.params.guildId)?.n ?? 0) >= MAX_COMMANDS_PER_GUILD) {
    return res.status(400).json({ error: `Limit of ${MAX_COMMANDS_PER_GUILD} commands per server reached` });
  }
  try {
    const info = q.insertCommand.run({ ...data, guild_id: req.params.guildId, created_by: req.session.user.id });
    audit(req.params.guildId, req.session.user.id, req.session.user.username, 'command.create', `/${data.name}`);
    scheduleGuildSync(req.params.guildId);
    res.status(201).json({ command: q.getCommand.get(info.lastInsertRowid, req.params.guildId) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: `A command named /${data.name} already exists` });
    }
    console.error('[web] create command:', err.message);
    res.status(500).json({ error: 'Could not create command' });
  }
});

app.put('/api/guilds/:guildId/commands/:id', requireAuth, requireGuildAdmin, writeLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid command ID' });
  // Ownership check: command must belong to THIS guild [§4 IDOR]
  const existing = q.getCommand.get(id, req.params.guildId);
  if (!existing) return res.status(404).json({ error: 'Command not found' });

  const { errors, data } = validateCommandInput(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(' • ') });

  try {
    q.updateCommand.run({ ...data, id, guild_id: req.params.guildId });
    audit(req.params.guildId, req.session.user.id, req.session.user.username, 'command.update', `/${data.name}`);
    scheduleGuildSync(req.params.guildId);
    res.json({ command: q.getCommand.get(id, req.params.guildId) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: `A command named /${data.name} already exists` });
    }
    console.error('[web] update command:', err.message);
    res.status(500).json({ error: 'Could not update command' });
  }
});

app.delete('/api/guilds/:guildId/commands/:id', requireAuth, requireGuildAdmin, writeLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid command ID' });
  const existing = q.getCommand.get(id, req.params.guildId);
  if (!existing) return res.status(404).json({ error: 'Command not found' });
  q.deleteCommand.run(id, req.params.guildId);
  audit(req.params.guildId, req.session.user.id, req.session.user.username, 'command.delete', `/${existing.name}`);
  scheduleGuildSync(req.params.guildId);
  res.json({ ok: true });
});

app.get('/api/guilds/:guildId/audit', requireAuth, requireGuildAdmin, (req, res) => {
  res.json({ entries: q.listAudit.all(req.params.guildId) });
});

app.get('/api/guilds/:guildId/leaderboard', requireAuth, requireGuildAdmin, (req, res) => {
  res.json({ top: q.topMsgCounts.all(req.params.guildId) });
});

// ============ Custom emojis (all guilds the bot is in) ============
// Authenticated users only. Emoji IDs/names are not sensitive (they are
// public in any message that uses them), but we still gate the listing.
app.get('/api/emojis', requireAuth, (req, res) => {
  try {
    if (DEMO) {
      return res.json({
        emojis: [
          { id: '400000000000000001', name: 'pepe_ok', animated: false, guild: 'Genspark Gaming' },
          { id: '400000000000000002', name: 'hype', animated: true, guild: 'Genspark Gaming' },
          { id: '400000000000000003', name: 'catjam', animated: true, guild: 'Dev Lounge' },
          { id: '400000000000000004', name: 'verified', animated: false, guild: 'Dev Lounge' },
          { id: '400000000000000005', name: 'thonk', animated: false, guild: 'Dev Lounge' },
        ],
      });
    }
    const emojis = [];
    for (const [, g] of client.guilds.cache) {
      for (const [, e] of g.emojis.cache) {
        if (!e.available) continue;
        emojis.push({ id: e.id, name: String(e.name).slice(0, 64), animated: Boolean(e.animated), guild: g.name.slice(0, 100) });
        if (emojis.length >= 500) break;
      }
      if (emojis.length >= 500) break;
    }
    res.json({ emojis });
  } catch (err) {
    console.error('[web] emojis:', err.message);
    res.status(500).json({ error: 'Could not load emojis' });
  }
});

// ============ Admin panel (bot owners only) ============
// Owner IDs come from the ADMIN_USER_IDS env var (comma-separated Discord
// user IDs). Checked server-side on every request — the panel is invisible
// and inaccessible to everyone else. [§4 permission checks]
const ADMIN_IDS = new Set(
  (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(isSnowflake)
);
if (DEMO) ADMIN_IDS.add('100000000000000001'); // demo user is admin in demo mode

function requireBotAdmin(req, res, next) {
  if (!req.session.user || !ADMIN_IDS.has(req.session.user.id)) {
    // 404 (not 403) so outsiders can't even confirm the panel exists
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

app.get('/api/admin/overview', requireAuth, requireBotAdmin, (req, res) => {
  try {
    const totals = qAdmin.totals.get();
    let guilds;
    if (DEMO) {
      guilds = [
        { id: '200000000000000001', name: 'Genspark Gaming', icon: null, memberCount: 128 },
        { id: '200000000000000002', name: 'Dev Lounge', icon: null, memberCount: 54 },
      ];
    } else {
      guilds = [...client.guilds.cache.values()].map(g => ({
        id: g.id, name: g.name.slice(0, 100), icon: g.icon, memberCount: g.memberCount,
      }));
    }
    const perGuild = qAdmin.perGuild.all();
    const statMap = new Map(perGuild.map(r => [r.guild_id, r]));
    const guildRows = guilds.map(g => ({
      ...g,
      commandCount: statMap.get(g.id)?.cmds ?? 0,
      totalUses: statMap.get(g.id)?.uses ?? 0,
    }));
    res.json({
      totals: {
        guilds: guilds.length,
        commands: totals.cmds,
        uses: totals.uses,
        messagesCounted: totals.msgs,
        auditEntries: totals.audits,
      },
      guilds: guildRows,
      topCommands: qAdmin.topCommands.all(),
      recentAudit: qAdmin.recentAudit.all(),
    });
  } catch (err) {
    console.error('[web] admin overview:', err.message);
    res.status(500).json({ error: 'Could not load admin data' });
  }
});

app.get('/api/admin/is-admin', requireAuth, (req, res) => {
  res.json({ admin: ADMIN_IDS.has(req.session.user.id) });
});

// ============ Pages ============
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '../../public/index.html'));
});
app.get(['/dashboard', '/dashboard/*splat'], (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
});
app.get('/admin', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  // Same 404-for-outsiders behavior as the API
  if (!ADMIN_IDS.has(req.session.user.id)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '../../public/admin.html'));
});

// 404 + generic error handler [§5]
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error('[web] unhandled:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export function startWeb() {
  // PORT from .env, or SERVER_PORT (set automatically by Pterodactyl-style
  // hosting panels like Orihost), or 3000 as a local fallback
  const port = Number(process.env.PORT) || Number(process.env.SERVER_PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`[web] dashboard on http://0.0.0.0:${port} ${DEMO ? '(DEMO MODE)' : ''}`);
  });
}
