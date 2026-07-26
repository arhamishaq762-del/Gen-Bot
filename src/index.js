// Entry point — loads .env, starts bot + dashboard
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Minimal .env loader (no extra dependency)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const DEMO = process.env.DEMO_MODE === 'true';
if (!DEMO) {
  const missing = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET']
    .filter(k => !process.env[k] || process.env[k].startsWith('your-') || process.env[k].startsWith('change-me'));
  if (missing.length) {
    console.error('─'.repeat(60));
    console.error('Missing/placeholder env vars:', missing.join(', '));
    console.error('Copy .env.example to .env and fill in real values,');
    console.error('or set DEMO_MODE=true to preview the dashboard.');
    console.error('─'.repeat(60));
    process.exit(1);
  }
}

const { startBot } = await import('./bot/bot.js');
const { startWeb } = await import('./web/server.js');

startBot();
startWeb();
