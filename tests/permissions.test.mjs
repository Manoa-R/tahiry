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
  data: { number: id, userId, depotId: 'd', cancelled: false, total: 8000, lines: [{ articleId: 'riz', qty: 2, price: 4000 }], ...extra },
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

test('une session volée ne sert pas depuis un autre appareil', () => shop(async ({ post, device, login }) => {
  const s = (await login('v', '2222')).body.sessionToken;
  const other = (await post('/api/devices', { label: 'Autre' }, ADMIN)).body.deviceToken;
  const r = await post('/api/sync', { sessions: { v: s }, changes: [sale('s1', 'v')] }, other);
  assert.deepEqual(r.body.deferred.map((d) => d.id), ['s1']);
  assert.ok(device);
}));

test('seul le gérant liste et révoque les appareils', () => shop(async ({ post, device, login }) => {
  const sv = (await login('v', '2222')).body.sessionToken;
  const sg = (await login('g', '1111')).body.sessionToken;
  assert.equal((await post('/api/devices/list', { sessions: { v: sv } }, device)).status, 403);
  const list = await post('/api/devices/list', { sessions: { g: sg } }, device);
  assert.equal(list.status, 200);
  assert.equal(list.body.devices.length, 1);
  assert.equal(list.body.current, list.body.devices[0].id);
  assert.equal((await post('/api/devices/revoke', { sessions: { v: sv }, id: list.body.current }, device)).status, 403);
  assert.equal((await post('/api/devices/revoke', { sessions: { g: sg }, id: 'inconnu' }, device)).status, 404);
}));

test('un appareil révoqué perd l’accès et ses sessions, les autres continuent', () => shop(async ({ post, device, login }) => {
  const sv = (await login('v', '2222')).body.sessionToken;
  const phone = await post('/api/devices', { label: 'Téléphone de Soa' }, ADMIN);
  const { devices } = (await post('/api/devices/list', {}, ADMIN)).body;
  assert.equal(devices.find((d) => d.id === phone.body.deviceId).label, 'Téléphone de Soa');
  // Révocation de la caisse principale (jeton « device ») avec la clé boutique.
  const caisse = devices.find((d) => d.id !== phone.body.deviceId).id;
  assert.equal((await post('/api/devices/revoke', { id: caisse }, ADMIN)).status, 200);
  const denied = await post('/api/sync', { sessions: { v: sv }, changes: [sale('s1', 'v')] }, device);
  assert.equal(denied.status, 401);
  assert.equal(denied.body.revoked, true);
  assert.equal((await post('/api/login', { userId: 'v', pin: '2222' }, device)).status, 401);
  assert.equal((await post('/api/sync', {}, phone.body.deviceToken)).status, 200);
  const after = (await post('/api/devices/list', {}, ADMIN)).body.devices;
  assert.equal(after.find((d) => d.id === caisse).revoked, true);
}));

test('le vendeur facture sa vente sans pouvoir en changer les montants', () => shop(async ({ post, device, login }) => {
  const s = (await login('v', '2222')).body.sessionToken;
  const invoice = (saleId, extra = {}) => ({
    c: 'invoices', id: `${saleId}:f`, hlc: '6-0-d', author: 'v',
    data: { number: 'FA26-X-0001', saleId, total: 8000, lines: [{ articleId: 'riz', qty: 2, price: 4000 }], ...extra },
  });
  await post('/api/sync', { sessions: { v: s }, changes: [sale('s1', 'v')] }, device);
  const r = await post('/api/sync', {
    sessions: { v: s },
    changes: [
      invoice('s1', { total: 800 }),
      { ...invoice('s1'), id: 'autre' },
      { c: 'settings', id: 'shop', hlc: '6-0-d', author: 'v', data: { name: 'Pirate' } },
    ],
  }, device);
  assert.deepEqual(r.body.rejected.map((x) => `${x.c}/${x.id}`), ['invoices/s1:f', 'invoices/autre', 'settings/shop']);
  const ok = await post('/api/sync', { sessions: { v: s }, changes: [invoice('s1')] }, device);
  assert.deepEqual(ok.body.rejected, []);
  assert.ok(ok.body.changes.some((c) => c.id === 's1:f' && c.data.total === 8000));
  const again = await post('/api/sync', { sessions: { v: s }, changes: [{ ...invoice('s1'), hlc: '7-0-d' }] }, device);
  assert.deepEqual(again.body.rejected.map((x) => x.id), ['s1:f']);
}));

test('devis : le vendeur gère les siens et ne peut que transformer ceux des autres', () => shop(async ({ post, device, login }) => {
  const sv = (await login('v', '2222')).body.sessionToken;
  const sg = (await login('g', '1111')).body.sessionToken;
  const quote = (id, userId, extra = {}) => ({ c: 'quotes', id, hlc: '6-0-d', author: userId, data: { number: id, userId, total: 8000, lines: [{ articleId: 'riz', qty: 2, price: 4000 }], status: 'ouvert', saleId: null, saleNumber: null, ...extra } });
  await post('/api/sync', { sessions: { g: sg }, changes: [quote('qg', 'g')] }, device);
  const r = await post('/api/sync', {
    sessions: { v: sv },
    changes: [
      quote('qv', 'v'),
      { ...quote('qg', 'g', { total: 1 }), author: 'v', hlc: '7-0-d' },
      { ...quote('qx', 'g'), author: 'v' },
    ],
  }, device);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.rejected.map((x) => x.id), ['qg', 'qx']);
  // Transformation du devis du gérant par une vente de la vendeuse.
  const ok = await post('/api/sync', {
    sessions: { v: sv },
    changes: [sale('s1', 'v'), { ...quote('qg', 'g', { status: 'transformé', saleId: 's1', saleNumber: 's1' }), author: 'v', hlc: '8-0-d' }],
  }, device);
  assert.deepEqual(ok.body.rejected, []);
}));
