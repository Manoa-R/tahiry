// Serveur Tahiry : API de synchronisation + fichiers statiques de la PWA.
// Aucune dépendance : node:http et node:sqlite uniquement.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkPin } from '../public/js/domain.js';
import { refusal } from './permissions.mjs';

export const COLLECTIONS = new Set(['articles', 'depots', 'partners', 'movements', 'sales', 'purchases', 'users']);
// Un mouvement de stock n'est jamais modifié : on le compense par un autre mouvement.
const IMMUTABLE = new Set(['movements']);
const MAX_BODY = 5 * 1024 * 1024;
const MAX_BATCH = 500;
const PAGE = 500;
const SESSION_DAYS = 90;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 60_000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      c TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, hlc TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, PRIMARY KEY (c, id)
    );
    CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
    -- Jetons d'appareil et de session : seule leur empreinte SHA-256 est conservée.
    CREATE TABLE IF NOT EXISTS credentials (
      hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, created INTEGER NOT NULL, expires INTEGER
    );
  `);
  return db;
}

function validChange(ch) {
  return ch && COLLECTIONS.has(ch.c)
    && typeof ch.id === 'string' && ch.id.length > 0 && ch.id.length <= 128
    && typeof ch.hlc === 'string' && ch.hlc.length <= 128
    && (ch.author === undefined || ch.author === null || (typeof ch.author === 'string' && ch.author.length <= 128))
    && ch.data && typeof ch.data === 'object' && !Array.isArray(ch.data);
}

export function createSyncStore(dbPath) {
  const db = openDb(dbPath);
  const find = db.prepare('SELECT data, hlc, deleted FROM records WHERE c = ? AND id = ?');
  const upsert = db.prepare(`
    INSERT INTO records (c, id, data, hlc, deleted, seq) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (c, id) DO UPDATE SET data = excluded.data, hlc = excluded.hlc,
      deleted = excluded.deleted, seq = excluded.seq`);
  const since = db.prepare('SELECT c, id, data, hlc, deleted, seq FROM records WHERE seq > ? ORDER BY seq LIMIT ?');
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM records');
  const insertCredential = db.prepare('INSERT INTO credentials (hash, kind, user_id, created, expires) VALUES (?, ?, ?, ?, ?)');
  const findCredential = db.prepare('SELECT kind, user_id, expires FROM credentials WHERE hash = ?');

  const lookup = (c, id) => {
    const row = find.get(c, id);
    return row && !row.deleted ? JSON.parse(row.data) : null;
  };
  const activeUser = (id) => {
    const u = lookup('users', id);
    return u && u.active !== false ? u : null;
  };
  const issue = (kind, userId = null, days = null) => {
    const token = newToken();
    insertCredential.run(sha256(token), kind, userId, Date.now(), days ? Date.now() + days * 864e5 : null);
    return token;
  };
  const credential = (token) => {
    if (typeof token !== 'string' || !token) return null;
    const row = findCredential.get(sha256(token));
    return row && (!row.expires || row.expires > Date.now()) ? row : null;
  };

  return {
    close: () => db.close(),
    activeUser,
    issueDevice: () => issue('device'),
    issueSession: (userId) => issue('session', userId, SESSION_DAYS),
    isDevice: (token) => credential(token)?.kind === 'device',

    // Résout les sessions envoyées : { userId: jeton } → Map userId → rôle actuel.
    // Le rôle est relu à chaque synchro : un vendeur rétrogradé ou désactivé perd ses droits.
    resolveAuthors(sessions) {
      const authors = new Map();
      for (const [userId, token] of Object.entries(sessions ?? {})) {
        const cred = credential(token);
        const user = cred?.kind === 'session' && cred.user_id === userId ? activeUser(userId) : null;
        if (user) authors.set(userId, { userId, role: user.role });
      }
      return authors;
    },

    // admin : clé boutique (tous droits). Sinon chaque changement est jugé selon son auteur.
    sync({ cursor = 0, changes = [], admin = false, authors = new Map() }) {
      const rejected = [];
      const deferred = [];
      const batchSales = new Map();
      for (const ch of changes) {
        if (ch.c === 'sales' && !ch.deleted && ch.author && ch.data.userId === ch.author) batchSales.set(ch.id, ch.data);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        let seq = maxSeq.get().s;
        for (const ch of changes) {
          const existing = find.get(ch.c, ch.id);
          // Rejeu ou version plus ancienne : sans effet, donc jamais refusé.
          if (existing && (IMMUTABLE.has(ch.c) || ch.hlc <= existing.hlc)) continue;
          if (!admin) {
            const author = ch.author ? authors.get(ch.author) : null;
            if (ch.author && !author) { deferred.push({ c: ch.c, id: ch.id, author: ch.author }); continue; }
            const reason = author ? refusal(ch, author, lookup, batchSales) : 'Utilisateur non identifié';
            if (reason) {
              rejected.push({
                c: ch.c, id: ch.id, reason,
                current: existing ? { data: JSON.parse(existing.data), hlc: existing.hlc, deleted: !!existing.deleted } : null,
              });
              continue;
            }
          }
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
        rejected,
        deferred,
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
  const loginFailures = new Map();

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

  // Clé boutique = administrateur. Jeton d'appareil = lecture, écriture selon les sessions.
  function authenticate(req) {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return null;
    const given = header.slice(7);
    if (tokenMatches(given, token)) return { admin: true };
    return store.isDevice(given) ? { admin: false } : null;
  }

  async function readJson(req, res) {
    try { return JSON.parse(await readBody(req)) ?? {}; } catch (err) {
      send(res, err.status ?? 400, { error: 'Requête illisible' });
      return null;
    }
  }

  async function handleSync(req, res, auth) {
    const body = await readJson(req, res);
    if (!body) return;
    const { changes = [], cursor = 0, sessions = {} } = body;
    if (!Array.isArray(changes) || changes.length > MAX_BATCH || !changes.every(validChange)
      || !Number.isInteger(cursor) || cursor < 0 || typeof sessions !== 'object' || Array.isArray(sessions)) {
      return send(res, 400, { error: 'Lot de changements invalide' });
    }
    send(res, 200, store.sync({ cursor, changes, admin: auth.admin, authors: store.resolveAuthors(sessions) }));
  }

  // Enregistre un appareil : échange la clé boutique contre un jeton propre à l'appareil.
  function handleDevice(res, auth) {
    if (!auth.admin) return send(res, 403, { error: 'Clé boutique requise' });
    return send(res, 200, { deviceToken: store.issueDevice() });
  }

  async function handleLogin(req, res) {
    const body = await readJson(req, res);
    if (!body) return;
    const { userId, pin } = body;
    if (typeof userId !== 'string' || typeof pin !== 'string') return send(res, 400, { error: 'Identifiants manquants' });
    const state = loginFailures.get(userId) ?? { count: 0, until: 0 };
    if (state.until > Date.now()) return send(res, 429, { error: 'Trop d’essais, réessayez dans une minute' });
    const user = store.activeUser(userId);
    if (!user || !(await checkPin(user, pin))) {
      state.count += 1;
      if (state.count >= LOGIN_MAX_FAILURES) Object.assign(state, { count: 0, until: Date.now() + LOGIN_LOCK_MS });
      loginFailures.set(userId, state);
      return send(res, 401, { error: 'Utilisateur ou code PIN invalide' });
    }
    loginFailures.delete(userId);
    return send(res, 200, { sessionToken: store.issueSession(userId), role: user.role });
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
        if (req.method !== 'POST') return send(res, 404, { error: 'Route inconnue' });
        const auth = authenticate(req);
        if (!auth) return send(res, 401, { error: 'Clé de synchronisation invalide' });
        if (pathname === '/api/sync') return await handleSync(req, res, auth);
        if (pathname === '/api/devices') return handleDevice(res, auth);
        if (pathname === '/api/login') return await handleLogin(req, res);
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
