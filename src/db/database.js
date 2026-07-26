// ============================================================
// Database layer — SQLite via better-sqlite3
// All queries use parameterized statements (no string concat)
// to prevent SQL injection.  [Security Pack §6]
// ============================================================
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'bot.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT 'Custom command',
  -- response
  response_type TEXT NOT NULL DEFAULT 'text' CHECK (response_type IN ('text','embed')),
  response_text TEXT NOT NULL DEFAULT '',
  embed_title TEXT DEFAULT '',
  embed_description TEXT DEFAULT '',
  embed_color TEXT DEFAULT '#5865F2',
  embed_image TEXT DEFAULT '',
  embed_footer TEXT DEFAULT '',
  -- delivery: channel = public reply, ephemeral = only invoker sees it, dm = direct message
  delivery TEXT NOT NULL DEFAULT 'channel' CHECK (delivery IN ('channel','ephemeral','dm')),
  -- role restriction (empty = everyone)
  required_role_id TEXT DEFAULT '',
  -- unlock requirements
  req_min_messages INTEGER NOT NULL DEFAULT 0 CHECK (req_min_messages >= 0 AND req_min_messages <= 1000000),
  req_status_text TEXT DEFAULT '',
  -- cooldown in seconds (0 = none)
  cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_seconds >= 0 AND cooldown_seconds <= 86400),
  enabled INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (guild_id, name)
);

CREATE TABLE IF NOT EXISTS message_counts (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS cooldowns (
  command_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  last_used INTEGER NOT NULL,
  PRIMARY KEY (command_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_tag TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_guild ON audit_log (guild_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_cmd_guild ON commands (guild_id);
`);

// ---------- validation helpers [Security Pack §1: backend validation] ----------
const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const SNOWFLAKE_RE = /^\d{5,25}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Reserved names that would clash with built-in slash commands
const RESERVED = new Set(['help', 'ping', 'rank', 'commands']);

export function validateCommandInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  const str = (v) => (typeof v === 'string' ? v : '');

  if (!partial || body.name !== undefined) {
    const name = str(body.name).toLowerCase().trim();
    if (!COMMAND_NAME_RE.test(name)) errors.push('Command name must be 1-32 chars: lowercase letters, numbers, - or _');
    else if (RESERVED.has(name)) errors.push(`"${name}" is a reserved command name`);
    else out.name = name;
  }

  const desc = str(body.description).trim().slice(0, 100);
  out.description = desc || 'Custom command';

  const rt = str(body.response_type);
  out.response_type = rt === 'embed' ? 'embed' : 'text';

  out.response_text = str(body.response_text).slice(0, 2000);
  out.embed_title = str(body.embed_title).slice(0, 256);
  out.embed_description = str(body.embed_description).slice(0, 4000);
  out.embed_footer = str(body.embed_footer).slice(0, 2048);

  const color = str(body.embed_color).trim();
  out.embed_color = HEX_COLOR_RE.test(color) ? color : '#5865F2';

  // Only allow http(s) image URLs — prevents javascript: etc. [§6 XSS]
  const img = str(body.embed_image).trim().slice(0, 500);
  if (img && !/^https:\/\/[^\s]+$/i.test(img)) errors.push('Embed image must be an https:// URL');
  else out.embed_image = img;

  const delivery = str(body.delivery);
  out.delivery = ['channel', 'ephemeral', 'dm'].includes(delivery) ? delivery : 'channel';

  const role = str(body.required_role_id).trim();
  if (role && !SNOWFLAKE_RE.test(role)) errors.push('Invalid role ID');
  else out.required_role_id = role;

  const minMsg = Number(body.req_min_messages ?? 0);
  if (!Number.isInteger(minMsg) || minMsg < 0 || minMsg > 1000000) errors.push('Message requirement must be an integer 0-1,000,000');
  else out.req_min_messages = minMsg;

  out.req_status_text = str(body.req_status_text).trim().slice(0, 128);

  const cd = Number(body.cooldown_seconds ?? 0);
  if (!Number.isInteger(cd) || cd < 0 || cd > 86400) errors.push('Cooldown must be an integer 0-86400 seconds');
  else out.cooldown_seconds = cd;

  out.enabled = body.enabled === false || body.enabled === 0 ? 0 : 1;

  if (out.response_type === 'text' && !out.response_text.trim()) {
    errors.push('Response text is required for text commands');
  }
  if (out.response_type === 'embed' && !out.embed_title.trim() && !out.embed_description.trim()) {
    errors.push('Embed needs at least a title or description');
  }

  return { errors, data: out };
}

export function isSnowflake(v) {
  return typeof v === 'string' && SNOWFLAKE_RE.test(v);
}

// ---------- command queries ----------
export const q = {
  listCommands: db.prepare('SELECT * FROM commands WHERE guild_id = ? ORDER BY name'),
  listEnabledCommands: db.prepare('SELECT * FROM commands WHERE guild_id = ? AND enabled = 1'),
  getCommand: db.prepare('SELECT * FROM commands WHERE id = ? AND guild_id = ?'),
  getCommandByName: db.prepare('SELECT * FROM commands WHERE guild_id = ? AND name = ? AND enabled = 1'),
  insertCommand: db.prepare(`
    INSERT INTO commands (guild_id, name, description, response_type, response_text,
      embed_title, embed_description, embed_color, embed_image, embed_footer,
      delivery, required_role_id, req_min_messages, req_status_text, cooldown_seconds, enabled, created_by)
    VALUES (@guild_id, @name, @description, @response_type, @response_text,
      @embed_title, @embed_description, @embed_color, @embed_image, @embed_footer,
      @delivery, @required_role_id, @req_min_messages, @req_status_text, @cooldown_seconds, @enabled, @created_by)
  `),
  updateCommand: db.prepare(`
    UPDATE commands SET name=@name, description=@description, response_type=@response_type,
      response_text=@response_text, embed_title=@embed_title, embed_description=@embed_description,
      embed_color=@embed_color, embed_image=@embed_image, embed_footer=@embed_footer,
      delivery=@delivery, required_role_id=@required_role_id, req_min_messages=@req_min_messages,
      req_status_text=@req_status_text, cooldown_seconds=@cooldown_seconds, enabled=@enabled,
      updated_at=datetime('now')
    WHERE id=@id AND guild_id=@guild_id
  `),
  deleteCommand: db.prepare('DELETE FROM commands WHERE id = ? AND guild_id = ?'),
  countCommands: db.prepare('SELECT COUNT(*) AS n FROM commands WHERE guild_id = ?'),
  incrementUses: db.prepare('UPDATE commands SET uses = uses + 1 WHERE id = ?'),

  getMsgCount: db.prepare('SELECT count FROM message_counts WHERE guild_id = ? AND user_id = ?'),
  bumpMsgCount: db.prepare(`
    INSERT INTO message_counts (guild_id, user_id, count) VALUES (?, ?, 1)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET count = count + 1
  `),
  topMsgCounts: db.prepare('SELECT user_id, count FROM message_counts WHERE guild_id = ? ORDER BY count DESC LIMIT 10'),

  getCooldown: db.prepare('SELECT last_used FROM cooldowns WHERE command_id = ? AND user_id = ?'),
  setCooldown: db.prepare(`
    INSERT INTO cooldowns (command_id, user_id, last_used) VALUES (?, ?, ?)
    ON CONFLICT (command_id, user_id) DO UPDATE SET last_used = excluded.last_used
  `),

  addAudit: db.prepare(`
    INSERT INTO audit_log (guild_id, actor_id, actor_tag, action, detail)
    VALUES (?, ?, ?, ?, ?)
  `),
  listAudit: db.prepare('SELECT * FROM audit_log WHERE guild_id = ? ORDER BY id DESC LIMIT 50'),
};

// Audit trail helper [Security Pack §13: logging & audit trails]
export function audit(guildId, actorId, actorTag, action, detail = '') {
  try {
    q.addAudit.run(String(guildId), String(actorId), String(actorTag).slice(0, 64), action, String(detail).slice(0, 300));
  } catch (e) {
    console.error('[audit] failed:', e.message);
  }
}

export default db;
