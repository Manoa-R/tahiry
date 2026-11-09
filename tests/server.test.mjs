import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server/app.mjs';

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tahiry-'));
  writeFileSync(join(dir, 'index.html'), '<h1>ok</h1>');
  const server = createServer({ dbPath: join(dir, 't.db'), token: 'secret', publicDir: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sync = async (body, token = 'secret') => {
    const res = await fetch(`${base}/api/sync`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try { await fn({ sync, base }); } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    rmSync(dir, { recursive: true, force: true });
  }
}

const art = (id, hlc, name) => ({ c: 'articles', id, hlc, data: { name } });

test('refuse une clé invalide', () => withServer(async ({ sync }) => {
  assert.equal((await sync({ changes: [] }, 'mauvaise')).status, 401);
}));

test('refuse un lot invalide', () => withServer(async ({ sync }) => {
  assert.equal((await sync({ changes: [{ c: 'inconnu', id: 'x', hlc: '1', data: {} }] })).status, 400);
  assert.equal((await sync({ cursor: -1 })).status, 400);
}));

test('deux appareils convergent : le dernier écrivain gagne, quel que soit l’ordre', () => withServer(async ({ sync }) => {
  await sync({ changes: [art('a', '0000000000002-000000-b', 'récent')] });
  await sync({ changes: [art('a', '0000000000001-000000-a', 'ancien')] });
  const { body } = await sync({ cursor: 0 });
  assert.equal(body.changes.length, 1);
  assert.equal(body.changes[0].data.name, 'récent');
}));

test('les mouvements hors ligne de deux appareils s’additionnent et sont immuables', () => withServer(async ({ sync }) => {
  const mv = (id, qty, hlc) => ({ c: 'movements', id, hlc, data: { qty } });
  await sync({ changes: [mv('m1', -2, '1-0-a')] });
  await sync({ changes: [mv('m2', -3, '1-0-b')] });
  await sync({ changes: [mv('m1', -99, '9-0-a')] }); // ni rejeu ni réécriture
  const { body } = await sync({ cursor: 0 });
  assert.equal(body.changes.reduce((s, c) => s + c.data.qty, 0), -5);
}));

test('le curseur ne renvoie que les nouveautés, et une modification réapparaît', () => withServer(async ({ sync }) => {
  const first = await sync({ changes: [art('a', '1-0-a', 'v1'), art('b', '1-0-a', 'b')] });
  assert.equal(first.body.changes.length, 2);
  const none = await sync({ cursor: first.body.cursor });
  assert.equal(none.body.changes.length, 0);
  const next = await sync({ cursor: first.body.cursor, changes: [art('a', '2-0-b', 'v2')] });
  assert.deepEqual(next.body.changes.map((c) => c.data.name), ['v2']);
}));

test('la pagination rend tout sans perte', () => withServer(async ({ sync }) => {
  for (let batch = 0; batch < 3; batch++) {
    const changes = Array.from({ length: 400 }, (_, i) => art(`${batch}-${i}`, '1-0-a', 'x'));
    await sync({ changes });
  }
  const seen = new Set();
  let cursor = 0, more = true, pages = 0;
  while (more) {
    const { body } = await sync({ cursor });
    body.changes.forEach((c) => seen.add(c.id));
    cursor = body.cursor; more = body.hasMore; pages++;
  }
  assert.equal(seen.size, 1200);
  assert.equal(pages, 3);
}));

test('sert les fichiers mais bloque la traversée de répertoire', () => withServer(async ({ base }) => {
  assert.equal((await fetch(base + '/')).status, 200);
  const res = await fetch(base + '/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
  assert.ok([403, 404].includes(res.status));
}));
