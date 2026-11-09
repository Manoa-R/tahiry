import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './app.mjs';

const base = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.TAHIRY_DATA ?? join(base, 'data');
mkdirSync(dataDir, { recursive: true });

function loadToken() {
  if (process.env.TAHIRY_TOKEN) return process.env.TAHIRY_TOKEN;
  const file = join(dataDir, 'token.txt');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

const token = loadToken();
const port = Number(process.env.PORT ?? 8787);
// Local par défaut ; HOST=0.0.0.0 pour exposer le serveur (derrière HTTPS).
const host = process.env.HOST ?? '127.0.0.1';

createServer({ dbPath: join(dataDir, 'tahiry.db'), token, publicDir: join(base, 'public') })
  .listen(port, host, () => {
    console.log(`Tahiry : http://${host}:${port}`);
    console.log(`Clé de synchronisation dans : ${process.env.TAHIRY_TOKEN ? 'TAHIRY_TOKEN' : join(dataDir, 'token.txt')}`);
  });
