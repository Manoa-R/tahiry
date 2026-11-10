// Base locale IndexedDB : source de vérité de l'interface, en ligne ou non.
// Chaque écriture met à jour l'enregistrement et la file d'envoi dans une seule transaction.
import { createClock, newId } from './domain.js';

const DB_NAME = 'tahiry';
export const COLLECTIONS = ['articles', 'depots', 'partners', 'movements', 'sales', 'purchases', 'users'];

const done = (tx) => new Promise((ok, fail) => {
  tx.oncomplete = () => ok();
  tx.onerror = () => fail(tx.error);
  tx.onabort = () => fail(tx.error);
});
const result = (req) => new Promise((ok, fail) => {
  req.onsuccess = () => ok(req.result);
  req.onerror = () => fail(req.error);
});

function openDb() {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('records', { keyPath: 'key' });
    req.result.createObjectStore('outbox', { keyPath: 'key' });
    req.result.createObjectStore('meta');
  };
  return result(req);
}

class Store {
  listeners = new Set();
  data = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
  meta = {};
  outboxCount = 0;
  author = null; // fonction fournie par l'interface : () => identifiant de l'utilisateur connecté

  async init() {
    this.db = await openDb();
    const tx = this.db.transaction(['records', 'outbox', 'meta']);
    const [records, count, keys, values] = await Promise.all([
      result(tx.objectStore('records').getAll()),
      result(tx.objectStore('outbox').count()),
      result(tx.objectStore('meta').getAllKeys()),
      result(tx.objectStore('meta').getAll()),
    ]);
    records.forEach((r) => this.#remember(r));
    this.outboxCount = count;
    keys.forEach((k, i) => { this.meta[k] = values[i]; });
    if (!this.meta.deviceId) await this.setMeta({ deviceId: newId().slice(0, 12), cursor: 0 });
    this.clock = createClock(this.meta.deviceId, this.meta.hlc);
    if (!this.list('depots').length) await this.save('depots', 'depot-principal', { name: 'Dépôt principal' });
  }

  // Une collection inconnue (venue d'une version plus récente) est gardée sans planter.
  #remember(r) { (this.data[r.c] ??= new Map()).set(r.id, r); }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(detail) { this.listeners.forEach((fn) => fn(detail)); }

  list(c) {
    const out = [];
    for (const r of this.data[c].values()) if (!r.deleted) out.push({ id: r.id, ...r.data });
    return out;
  }
  get(c, id) {
    const r = this.data[c].get(id);
    return r && !r.deleted ? { id: r.id, ...r.data } : null;
  }

  async setMeta(patch) {
    const tx = this.db.transaction('meta', 'readwrite');
    for (const [k, v] of Object.entries(patch)) tx.objectStore('meta').put(v, k);
    await done(tx);
    Object.assign(this.meta, patch);
  }

  // Écrit plusieurs enregistrements en une transaction (vente + sorties de stock).
  async write(changes) {
    // L'auteur (utilisateur connecté) permet au serveur de vérifier ses droits.
    const author = this.author?.() ?? null;
    const records = changes.map(({ c, id, data, deleted = false }) => ({
      key: `${c}/${id}`, c, id, data, deleted, author, hlc: this.clock.tick(),
    }));
    const tx = this.db.transaction(['records', 'outbox', 'meta'], 'readwrite');
    const outbox = tx.objectStore('outbox');
    for (const r of records) { tx.objectStore('records').put(r); outbox.put(r); }
    tx.objectStore('meta').put(this.clock.current(), 'hlc');
    const counted = outbox.count();
    await done(tx);
    records.forEach((r) => this.#remember(r));
    this.outboxCount = counted.result;
    this.emit({ local: true });
  }

  save(c, id, data) { return this.write([{ c, id, data }]); }
  remove(c, id) {
    const r = this.data[c].get(id);
    return r ? this.write([{ c, id, data: r.data, deleted: true }]) : undefined;
  }

  async pending() {
    return result(this.db.transaction('outbox').objectStore('outbox').getAll());
  }

  // Changements refusés par le serveur : on reprend sa version (ou on efface si
  // l'enregistrement n'existe pas côté serveur) et on retire la file d'envoi.
  async applyRejected(rejected) {
    if (!rejected.length) return;
    const tx = this.db.transaction(['records', 'outbox'], 'readwrite');
    const restored = [];
    for (const r of rejected) {
      const key = `${r.c}/${r.id}`;
      tx.objectStore('outbox').delete(key);
      if (r.current) {
        const rec = { key, c: r.c, id: r.id, ...r.current };
        tx.objectStore('records').put(rec);
        restored.push(rec);
      } else {
        tx.objectStore('records').delete(key);
        restored.push({ key, c: r.c, id: r.id, removed: true });
      }
    }
    await done(tx);
    for (const r of restored) {
      if (r.removed) this.data[r.c]?.delete(r.id); else this.#remember(r);
    }
    this.outboxCount = await result(this.db.transaction('outbox').objectStore('outbox').count());
    this.emit({ remote: true });
  }

  // Retire les éléments envoyés, sauf ceux modifiés entre-temps.
  async acknowledge(sent) {
    const tx = this.db.transaction('outbox', 'readwrite');
    const outbox = tx.objectStore('outbox');
    for (const s of sent) {
      outbox.get(s.key).onsuccess = (e) => {
        if (e.target.result?.hlc === s.hlc) outbox.delete(s.key);
      };
    }
    await done(tx);
    // Compté après coup : les suppressions sont émises depuis les rappels ci-dessus.
    this.outboxCount = await result(this.db.transaction('outbox').objectStore('outbox').count());
  }

  // Applique les changements serveur et avance le curseur dans la même transaction.
  async applyRemote(changes, cursor) {
    const tx = this.db.transaction(['records', 'meta'], 'readwrite');
    const records = tx.objectStore('records');
    const applied = [];
    for (const ch of changes) {
      const key = `${ch.c}/${ch.id}`;
      this.clock.receive(ch.hlc);
      records.get(key).onsuccess = (e) => {
        const local = e.target.result;
        if (local && local.hlc >= ch.hlc) return;
        const r = { key, c: ch.c, id: ch.id, data: ch.data, deleted: ch.deleted, hlc: ch.hlc };
        records.put(r);
        applied.push(r);
      };
    }
    tx.objectStore('meta').put(cursor, 'cursor');
    tx.objectStore('meta').put(this.clock.current(), 'hlc');
    await done(tx);
    this.meta.cursor = cursor;
    applied.forEach((r) => this.#remember(r));
    if (applied.length) this.emit({ remote: true });
    return applied.length;
  }
}

export const store = new Store();
