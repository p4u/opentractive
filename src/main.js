// Entry point: load env, fail closed, then the store, the app and the web server.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Store } from './store.js';
import { createApp } from './app.js';
import { startServer } from './server.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

// Fail closed, before anything is created: no web UI without a password, no app without Tractive credentials.
if (!env.APP_PASSWORD) {
  console.error('APP_PASSWORD is required: set it in .env');
  process.exit(1);
}
if (!env.TRACTIVE_EMAIL || !env.TRACTIVE_PASSWORD) {
  console.error('TRACTIVE_EMAIL and TRACTIVE_PASSWORD are required: set them in .env');
  process.exit(1);
}
if (env.APP_PASSWORD.length < 8) log('warning: APP_PASSWORD is shorter than 8 characters');

process.umask(0o077); // the SQLite -wal/-shm files hold locations; nothing we create is world-readable
env.TZ ||= 'UTC';
const { version } = createRequire(import.meta.url)('../package.json');
const dataDir = env.DATA_DIR || 'data';
fs.mkdirSync(dataDir, { recursive: true });
const store = new Store(path.join(dataDir, 'opentractive.db'));
const app = createApp({ env, store, dataDir, log });
const server = startServer({
  store, app, config: { password: env.APP_PASSWORD, trustProxy: env.TRUST_PROXY === '1', version },
  port: Number(env.PORT || 8080), host: env.HOST || '127.0.0.1', log,
});
app.start().catch((e) => log(`startup: ${e.message}`));

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping`);
  try {
    await app.stop();
  } catch (e) {
    log(`stop: ${e.message}`);
  }
  server.closeAllConnections();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
