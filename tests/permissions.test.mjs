import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server/app.mjs';
import { makeCredentials } from '../public/js/domain.js';

const ADMIN = 'cle-boutique';

async function shop(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tahiry-perm-'));
  writeFileSync(join(dir, 'index.html'), '');
  const server = createServer({ dbPath: join(dir, 't.db'), token: ADMIN, publicDir: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, bearer) => {
    const res = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  // Boutique type : un gérant et une vendeuse créés avec la clé boutique.
  const users = {
    g: { name: 'Rova', role: 'gerant', active: true, ...(await makeCredentials('1111')) },
    v: { name: 'Soa', role: 'vendeur', active: true, ...(await makeCredentials('2222')) },
  };
  await post('/api/sync', {
    changes: [
      ...Object.entries(users).map(([id, data]) => ({ c: 'users', id, hlc: '1-0-x', data })),
      { c: 'articles', id: 'riz', hlc: '1-0-x', data: { name: 'Riz', price: 4000 } },
    ],
  }, ADMIN);
  const device = (await post('/api/devices', {}, ADMIN)).body.deviceToken;
  const login = async (userId, pin) => (await post('/api/login', { userId, pin }, device));
  try { await fn({ post, device, login }); } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    rmSync(dir, { recursive: true, force: true });
  }
}

const sale = (id, userId, extra = {}) => ({
  c: 'sales', id, hlc: '5-0-d', author: userId,
  data: { number: id, userId, depotId: 'd', cancelled: false, lines: [{ articleId: 'riz', qty: 2, price: 4000 }], ...extra },
});
const exit = (saleId, userId, qty = -2, i = 0) => ({
  c: 'movements', id: `${saleId}:v:${i}`, hlc: '5-0-d', author: userId,
  data: { articleId: 'riz', depotId: 'd', qty, type: 'vente' },
});

test('un appareil ne s’enregistre qu’avec la clé boutique', () => shop(async ({ post, device }) => {
  assert.equal((await post('/api/devices', {}, device)).status, 403);
  assert.equal((await post('/api/devices', {}, 'faux')).status, 401);
}));

test('la connexion vérifie le PIN et se bloque après 5 erreurs', () => shop(async ({ login }) => {
  assert.equal((await login('v', '2222')).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await login('v', '0000')).status, 401);
  assert.equal((await login('v', '2222')).status, 429);
}));

test('le vendeur peut créer sa vente et ses sorties de stock', () => shop(async ({ post, device, login }) => {
  const s = (await login('v', '2222')).body.sessionToken;
  const r = await post('/api/sync', { sessions: { v: s }, changes: [exit('s1', 'v'), sale('s1', 'v')] }, device);
  assert.deepEqual([r.body.rejected, r.body.deferred], [[], []]);
  assert.equal(r.body.changes.filter((c) => c.id.startsWith('s1')).length, 2);
}));

test('le vendeur ne peut ni modifier le catalogue, ni annuler, ni gonfler une sortie', () => shop(async ({ post, device, login }) => {
  const s = (await login('v', '2222')).body.sessionToken;
  await post('/api/sync', { sessions: { v: s }, changes: [sale('s1', 'v')] }, device);
  const r = await post('/api/sync', {
    sessions: { v: s },
    changes: [
      { c: 'articles', id: 'riz', hlc: '9-0-d', author: 'v', data: { name: 'Riz', price: 1 } },
      { ...sale('s1', 'v', { cancelled: true }), hlc: '9-0-d' },
      exit('s1', 'v', -50),
      { c: 'users', id: 'v', hlc: '9-0-d', author: 'v', data: { name: 'Soa', role: 'gerant' } },
      { ...sale('s2', 'g'), author: 'v' }, // vente attribuée au gérant par la vendeuse
      sale('s3', 'g'), // signée au nom du gérant sans sa session : jamais appliquée
    ],
  }, device);
  assert.deepEqual(r.body.rejected.map((x) => x.id), ['riz', 's1', 's1:v:0', 'v', 's2']);
  assert.deepEqual(r.body.deferred.map((x) => x.id), ['s3']);
  // Le serveur renvoie sa version pour que l'appareil annule la modification refusée.
  assert.equal(r.body.rejected[0].current.data.price, 4000);
  assert.equal(r.body.rejected[2].current, null);
}));

test('le gérant connecté peut tout faire', () => shop(async ({ post, device, login }) => {
  const s = (await login('g', '1111')).body.sessionToken;
  const r = await post('/api/sync', { sessions: { g: s }, changes: [{ c: 'articles', id: 'riz', hlc: '9-0-d', author: 'g', data: { name: 'Riz', price: 4500 } }] }, device);
  assert.deepEqual(r.body.rejected, []);
}));

test('sans session valide, le changement attend au lieu d’être perdu', () => shop(async ({ post, device }) => {
  const r = await post('/api/sync', { sessions: { v: 'expire' }, changes: [sale('s1', 'v')] }, device);
  assert.deepEqual(r.body.deferred.map((d) => d.id), ['s1']);
  assert.deepEqual(r.body.rejected, []);
}));

test('un vendeur désactivé perd ses droits immédiatement', () => shop(async ({ post, device, login }) => {
  const s = (await login('v', '2222')).body.sessionToken;
  await post('/api/sync', { changes: [{ c: 'users', id: 'v', hlc: '8-0-x', data: { name: 'Soa', role: 'vendeur', active: false } }] }, ADMIN);
  const r = await post('/api/sync', { sessions: { v: s }, changes: [sale('s9', 'v')] }, device);
  assert.deepEqual(r.body.deferred.map((d) => d.id), ['s9']);
}));

test('un changement sans auteur venant d’un appareil est refusé, un rejeu est ignoré', () => shop(async ({ post, device }) => {
  const r = await post('/api/sync', { changes: [{ c: 'depots', id: 'x', hlc: '2-0-d', data: { name: 'X' } }, { c: 'articles', id: 'riz', hlc: '1-0-x', data: {} }] }, device);
  assert.deepEqual(r.body.rejected.map((x) => x.id), ['x']);
}));
