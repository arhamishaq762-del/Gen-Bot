# ⚡ CmdForge — Discord Custom Command Bot + Dashboard

Create custom slash commands like `/ok` for your Discord server from a beautiful web dashboard — no code needed.

## Features

### Custom Commands
- **Any name**: create `/ok`, `/promo`, `/rules` — registered as real Discord slash commands per server
- **Text or Embed responses**: full embed builder (title, description, color, image, footer)
- **Placeholders**: `{user}` (mention), `{username}`, `{server}` in responses
- **Delivery modes**:
  - 📢 In chat — everyone sees the reply
  - 👁️ In chat, hidden — only the invoker sees it (ephemeral)
  - 📬 DM — sent straight to the user's DMs
- **Role restrictions**: pick exactly which role can use each command
- **Unlock requirements**:
  - 🏆 Minimum message count (bot counts messages per server)
  - ✏️ Custom status must contain your text (great for vanity/promo statuses)
- **Cooldowns**: per-user, 0s to 24h per command
- **Enable/disable** commands without deleting them

### Extras (bonus features)
- `/help` — lists all custom commands on the server
- `/rank` — shows a user their message count
- 📋 **Audit log** — every create/edit/delete recorded with who & when
- 🏆 **Message leaderboard** tab in the dashboard
- Usage counters per command

### Dashboard
- Dark, Discord-inspired UI
- **Discord OAuth2 login required** — no anonymous access
- You only see servers where **you** have Administrator / Manage Server **and** can only manage ones the bot is in
- Nobody can see or touch another person's servers — enforced server-side on every request

## Security (per the Security Prompt Pack)

| Area | What's implemented |
|---|---|
| §1 Backend validation | Every field validated server-side (types, lengths, ranges, enums, regex) — frontend validation is UX only |
| §2 Secrets | All secrets in `.env` (gitignored); `.env.example` provided; no keys in frontend code |
| §3 Auth & sessions | OAuth2 with `state` param (CSRF), session regeneration on login (anti-fixation), httpOnly + sameSite + secure cookies, rolling 6h expiry, real server-side logout |
| §4 Permission checks | Per-request server-side admin check on every guild route (anti-IDOR); command ownership verified per guild; Discord tokens never sent to the browser |
| §5 Error handling | Generic errors to clients, details only in server logs |
| §6 Injection | 100% parameterized SQL; frontend renders via `textContent` only (no innerHTML XSS); CSP headers; `javascript:` image URLs rejected; `@everyone`/role pings blocked in command output |
| §8 Rate limiting | Separate limiters for auth (10/min), API reads (120/min), writes (30/min); per-command Discord cooldowns; debounced slash-command sync |
| §9 Transport | helmet HSTS, secure cookies in production, CSP |
| §11 Config | `trust proxy`, `x-powered-by` disabled, small JSON body limit, env validation at boot |
| §13 Audit | Full audit trail of command changes, viewable in dashboard |

## Setup

### 1. Create a Discord application
1. Go to https://discord.com/developers/applications → **New Application**
2. **Bot** tab → copy the **Token** → enable **Server Members Intent**, **Message Content Intent** (for counting), and **Presence Intent** (for status requirements)
3. **OAuth2** tab → copy **Client ID** and **Client Secret**
4. OAuth2 → **Redirects** → add `http://localhost:3000/auth/callback` (and your production URL + `/auth/callback` later)

### 2. Configure
```bash
cp .env.example .env
# fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET
# generate a session secret:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 3. Run
```bash
npm install
npm start
```
Open http://localhost:3000, log in with Discord, invite the bot from the dashboard, and start creating commands.

### Demo mode (no Discord credentials needed)
Set `DEMO_MODE=true` in `.env` to preview the whole dashboard with mock servers/roles — the bot connection is skipped.

## Project structure
```
src/
  index.js          # entry: env loading + boot
  db/database.js    # SQLite schema, parameterized queries, input validation
  bot/bot.js        # Discord client, command engine, requirements, cooldowns
  web/server.js     # Express: OAuth2, sessions, guarded API, security headers
public/
  index.html        # landing page
  dashboard.html    # dashboard SPA
  css/style.css     # dark theme
  js/dashboard.js   # dashboard logic (XSS-safe DOM rendering)
```

## Production notes
- Set `NODE_ENV=production` (enables secure cookies) and serve behind HTTPS
- Set `BASE_URL` to your public URL and add it to Discord OAuth2 redirects
- Rotate any key immediately if it was ever committed or shared
