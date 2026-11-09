// Moteur de synchronisation : envoie la file locale, récupère les nouveautés.
import { store } from './store.js';

const BATCH = 200;
const INTERVAL = 30_000;
const TIMEOUT = 20_000;

export const syncState = { status: 'idle', message: '', lastSync: null };

let running = null;
let debounce = null;
const listeners = new Set();
export const onSyncState = (fn) => listeners.add(fn);

function setState(status, message = '') {
  Object.assign(syncState, { status, message });
  listeners.forEach((fn) => fn());
}

const serverUrl = () => (store.meta.serverUrl || location.origin).replace(/\/$/, '');

async function exchange(changes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${serverUrl()}/api/sync`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${store.meta.token}` },
      body: JSON.stringify({
        deviceId: store.meta.deviceId,
        cursor: store.meta.cursor ?? 0,
        changes: changes.map(({ c, id, data, hlc, deleted }) => ({ c, id, data, hlc, deleted })),
      }),
    });
    if (res.status === 401) throw Object.assign(new Error('Clé de synchronisation refusée'), { auth: true });
    if (!res.ok) throw new Error(`Erreur serveur (${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  if (!store.meta.token) return setState('unconfigured');
  if (!navigator.onLine) return setState('offline');
  setState('syncing');
  try {
    let more = true;
    while (more) {
      const batch = await store.pendingBatch(BATCH);
      const reply = await exchange(batch);
      await store.acknowledge(batch);
      await store.applyRemote(reply.changes, reply.cursor);
      more = reply.hasMore || batch.length === BATCH;
    }
    syncState.lastSync = new Date();
    setState('ok');
  } catch (err) {
    if (err.auth) setState('error', err.message);
    else setState('offline', 'Serveur injoignable');
  }
}

export function syncNow() {
  running ??= run().finally(() => { running = null; });
  return running;
}

export function startSync() {
  store.subscribe(({ local }) => {
    if (!local) return;
    clearTimeout(debounce);
    debounce = setTimeout(syncNow, 800);
    listeners.forEach((fn) => fn());
  });
  addEventListener('online', syncNow);
  addEventListener('offline', () => setState('offline'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
  setInterval(syncNow, INTERVAL);
  syncNow();
}
