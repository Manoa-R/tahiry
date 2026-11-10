// Serveur Tahiry : API de synchronisation + fichiers statiques de la PWA.
// Aucune dépendance : node:http et node:sqlite uniquement.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const COLLECTIONS = new Set(['articles', 'depots', 'partners', 'movements', 'sales', 'purchases', 'users']);
// Un mouvement de stock n'est jamais modifié : on le compense par un autre mouvement.
const IMMUTABLE = new Set(['movements']);
const MAX_BODY = 5 * 1024 * 1024;
const MAX_BATCH = 500;
const PAGE = 500;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      c TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, hlc TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, PRIMARY KEY (c, id)
    );
    CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
  `);
  return db;
}

function validChange(ch) {
  return ch && COLLECTIONS.has(ch.c)
    && typeof ch.id === 'string' && ch.id.length > 0 && ch.id.length <= 128
    && typeof ch.hlc === 'string' && ch.hlc.length <= 128
    && ch.data && typeof ch.data === 'object' && !Array.isArray(ch.data);
}

export function createSyncStore(dbPath) {
  const db = openDb(dbPath);
  const find = db.prepare('SELECT hlc FROM records WHERE c = ? AND id = ?');
  const upsert = db.prepare(`
    INSERT INTO records (c, id, data, hlc, deleted, seq) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (c, id) DO UPDATE SET data = excluded.data, hlc = excluded.hlc,
      deleted = excluded.deleted, seq = excluded.seq`);
  const since = db.prepare('SELECT c, id, data, hlc, deleted, seq FROM records WHERE seq > ? ORDER BY seq LIMIT ?');
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM records');

  return {
    close: () => db.close(),
    // Applique un lot (dernier écrivain gagnant, sauf collections immuables)
    // puis renvoie une page de changements postérieurs au curseur du client.
    sync({ cursor = 0, changes = [] }) {
      db.exec('BEGIN IMMEDIATE');
      try {
        let seq = maxSeq.get().s;
        for (const ch of changes) {
          const existing = find.get(ch.c, ch.id);
          if (existing && (IMMUTABLE.has(ch.c) || ch.hlc <= existing.hlc)) continue;
          upsert.run(ch.c, ch.id, JSON.stringify(ch.data), ch.hlc, ch.deleted ? 1 : 0, ++seq);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      const rows = since.all(cursor, PAGE + 1);
      const hasMore = rows.length > PAGE;
      const page = rows.slice(0, PAGE);
      return {
        cursor: page.length ? page[page.length - 1].seq : cursor,
        hasMore,
        changes: page.map((r) => ({ c: r.c, id: r.id, data: JSON.parse(r.data), hlc: r.hlc, deleted: !!r.deleted })),
      };
    },
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

const digest = (s) => createHash('sha256').update(s).digest();
const tokenMatches = (given, expected) => timingSafeEqual(digest(given), digest(expected));

export function createServer({ dbPath, token, publicDir }) {
  const store = createSyncStore(dbPath);
  const root = resolve(publicDir);

  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400).end(); return; }
    const file = resolve(root, '.' + (rel === '/' ? '/index.html' : rel));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Introuvable');
    }
  }

  async function handleSync(req, res) {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || !tokenMatches(header.slice(7), token)) {
      return send(res, 401, { error: 'Clé de synchronisation invalide' });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      return send(res, err.status ?? 400, { error: 'Requête illisible' });
    }
    const { changes = [], cursor = 0 } = body ?? {};
    if (!Array.isArray(changes) || changes.length > MAX_BATCH || !changes.every(validChange)
      || !Number.isInteger(cursor) || cursor < 0) {
      return send(res, 400, { error: 'Lot de changements invalide' });
    }
    send(res, 200, store.sync({ cursor, changes }));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/')) {
        // Authentification par jeton (pas de cookie) : le CORS ouvert permet
        // à une app mobile empaquetée de joindre le serveur sans risque CSRF.
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-headers', 'authorization, content-type');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (pathname === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true });
        if (pathname === '/api/sync' && req.method === 'POST') return await handleSync(req, res);
        return send(res, 404, { error: 'Route inconnue' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      await serveStatic(req, res, pathname);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Erreur serveur' });
      else res.end();
    }
  });
  server.on('close', () => store.close());
  return server;
}
