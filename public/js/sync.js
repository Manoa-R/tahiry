// Moteur de synchronisation : envoie la file locale, récupère les nouveautés.
//
// Identifiants :
// - clé boutique (meta.token) : tous droits ; gardée seulement tant qu'aucun utilisateur n'existe ;
// - jeton d'appareil (meta.deviceToken) : remplace la clé dès qu'il y a des utilisateurs ;
// - sessions (meta.sessions) : une par utilisateur, obtenue en saisissant son PIN en ligne.
import { store } from './store.js';
import { hashPin, newId } from './domain.js';

const BATCH = 200;
const INTERVAL = 30_000;
const TIMEOUT = 20_000;

export const syncState = { status: 'idle', message: '', lastSync: null, held: 0, rejected: [] };

let running = null;
let debounce = null;
let adminKey = null; // clé boutique saisie pour une récupération : en mémoire seulement
const listeners = new Set();
export const onSyncState = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn());

function setState(status, message = '') {
  Object.assign(syncState, { status, message });
  notify();
}

// Dans l'app Android (Capacitor), la page est embarquée : l'adresse du serveur doit être saisie.
export const isNative = Boolean(globalThis.Capacitor?.isNativePlatform?.());
const serverUrl = () => (store.meta.serverUrl || (isNative ? '' : location.origin)).replace(/\/$/, '');

// « 192.168.1.10:8787 » devient « http://192.168.1.10:8787 ».
export function normalizeServerUrl(value) {
  const v = value.trim().replace(/\/+$/, '');
  return !v || /^https?:\/\//i.test(v) ? v : `http://${v}`;
}
const credential = () => adminKey || store.meta.deviceToken || store.meta.token;
const isAdmin = () => Boolean(adminKey || (!store.meta.deviceToken && store.meta.token));
const hasUsers = () => store.list('users').some((u) => u.active !== false);

async function post(path, body, bearer = credential()) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${serverUrl()}${path}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `Erreur serveur (${res.status})`), { status: res.status, revoked: json.revoked === true });
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// Empreinte locale de la clé : permet la récupération « PIN oublié » sans garder la clé.
async function rememberKeyHash(key) {
  const keySalt = newId();
  return { keySalt, keyHash: await hashPin(key, keySalt) };
}

export async function verifyShopKey(key) {
  if (store.meta.keyHash) return (await hashPin(key, store.meta.keySalt)) === store.meta.keyHash;
  return Boolean(store.meta.token) && key === store.meta.token;
}

// Échange la clé boutique contre un jeton d'appareil, puis oublie la clé.
export function defaultDeviceLabel() {
  const ua = navigator.userAgent;
  const kind = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'PC Windows' : /Mac/.test(ua) ? 'Mac' : 'Appareil';
  return store.meta.seller ? `${kind} — ${store.meta.seller}` : kind;
}

export async function registerDevice(key) {
  const label = store.meta.deviceLabel || defaultDeviceLabel();
  const { deviceToken, deviceId } = await post('/api/devices', { label }, key);
  await store.setMeta({ deviceToken, serverDeviceId: deviceId, token: null, sessions: {}, revokedAt: null, ...(await rememberKeyHash(key)) });
}

// Gestion des appareils (gérant) : la session du gérant connecté prouve son rôle.
export async function listDevices() {
  return post('/api/devices/list', { sessions: store.meta.sessions ?? {} });
}

export async function revokeDevice(id) {
  return post('/api/devices/revoke', { id, sessions: store.meta.sessions ?? {} });
}

export function useAdminKey(key) { adminKey = key; }

// Ouvre une session serveur pour l'utilisateur ; sans réseau, on réessaiera au prochain PIN.
export async function loginOnline(userId, pin) {
  if (!credential() || !navigator.onLine) return false;
  try {
    const { sessionToken } = await post('/api/login', { userId, pin });
    await store.setMeta({ sessions: { ...(store.meta.sessions ?? {}), [userId]: sessionToken } });
    notify();
    syncNow();
    return true;
  } catch {
    return false;
  }
}

export const hasSession = (userId) => Boolean(store.meta.sessions?.[userId]);

async function exchange(changes) {
  return post('/api/sync', {
    deviceId: store.meta.deviceId,
    cursor: store.meta.cursor ?? 0,
    sessions: store.meta.sessions ?? {},
    changes: changes.map(({ c, id, data, hlc, deleted, author }) => ({ c, id, data, hlc, deleted, author })),
  });
}

async function dropSessions(authors) {
  if (!authors.size) return;
  const sessions = { ...(store.meta.sessions ?? {}) };
  authors.forEach((a) => delete sessions[a]);
  await store.setMeta({ sessions });
}

async function run() {
  if (!serverUrl()) return setState('unconfigured', 'Adresse du serveur à saisir');
  if (!credential()) return setState(store.meta.revokedAt ? 'error' : 'unconfigured', 'Appareil révoqué');
  if (!navigator.onLine) return setState('offline');
  setState('syncing');
  try {
    const all = await store.pending();
    const admin = isAdmin();
    const sessions = store.meta.sessions ?? {};
    // Un changement signé par un utilisateur sans session attend sa prochaine connexion.
    const sendable = admin ? all : all.filter((r) => !r.author || sessions[r.author]);
    syncState.held = all.length - sendable.length;
    const rejected = [];
    let more = true;
    for (let i = 0; i < sendable.length || more; i += BATCH) {
      const batch = sendable.slice(i, i + BATCH);
      const reply = await exchange(batch);
      const deferred = new Set((reply.deferred ?? []).map((d) => `${d.c}/${d.id}`));
      await store.acknowledge(batch.filter((r) => !deferred.has(r.key)));
      await store.applyRejected(reply.rejected ?? []);
      // Session refusée : on l'oublie pour redemander le PIN (pas pour un changement que le serveur ne connaît pas encore).
      await dropSessions(new Set((reply.deferred ?? []).map((d) => d.author).filter(Boolean)));
      syncState.held += deferred.size;
      rejected.push(...(reply.rejected ?? []));
      await store.applyRemote(reply.changes, reply.cursor);
      more = reply.hasMore;
    }
    if (rejected.length) syncState.rejected = rejected;
    // Dès qu'il existe des utilisateurs, cet appareil remplace la clé boutique par son propre jeton.
    if (hasUsers() && store.meta.token && !store.meta.deviceToken && !adminKey) await registerDevice(store.meta.token);
    syncState.lastSync = new Date();
    setState('ok');
  } catch (err) {
    if (err.revoked && !adminKey) {
      // Appareil révoqué : on oublie ses identifiants ; les données locales et la file restent.
      await store.setMeta({ deviceToken: null, sessions: {}, revokedAt: Date.now() });
      setState('error', 'Appareil révoqué');
    } else if (err.status === 401 || err.status === 403) setState('error', err.message);
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
    notify();
  });
  addEventListener('online', syncNow);
  addEventListener('offline', () => setState('offline'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
  setInterval(syncNow, INTERVAL);
  syncNow();
}
