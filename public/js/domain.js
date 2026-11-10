// Règles métier pures (sans DOM ni IndexedDB), testées sous Node.

export const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

export function newId() {
  // getRandomValues reste disponible hors HTTPS, contrairement à randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Horloge logique hybride : chaîne triable "ms-compteur-appareil".
export function createClock(deviceId, last = '') {
  let [ms, counter] = last ? last.split('-').map(Number) : [0, 0];
  const format = () => `${String(ms).padStart(13, '0')}-${String(counter).padStart(6, '0')}-${deviceId}`;
  return {
    tick(now = Date.now()) {
      if (now > ms) { ms = now; counter = 0; } else { counter += 1; }
      return format();
    },
    receive(hlc) {
      const [remoteMs, remoteCounter] = hlc.split('-').map(Number);
      if (remoteMs > ms || (remoteMs === ms && remoteCounter > counter)) {
        ms = remoteMs; counter = remoteCounter;
      }
    },
    current: format,
  };
}

const key = (articleId, depotId) => `${articleId}|${depotId}`;

export function computeStock(movements) {
  const map = new Map();
  for (const m of movements) {
    const k = key(m.articleId, m.depotId);
    map.set(k, round3((map.get(k) ?? 0) + m.qty));
  }
  return map;
}

export function stockAt(stock, articleId, depotId) {
  return stock.get(key(articleId, depotId)) ?? 0;
}

export function stockTotal(stock, articleId) {
  let total = 0;
  for (const [k, qty] of stock) if (k.startsWith(articleId + '|')) total += qty;
  return round3(total);
}

export function saleTotals(lines, discount = 0) {
  const subtotal = Math.round(lines.reduce((s, l) => s + l.price * l.qty, 0));
  const applied = Math.min(Math.max(0, Math.round(discount) || 0), subtotal);
  return { subtotal, discount: applied, total: subtotal - applied };
}

// Une vente crée atomiquement le document de vente et ses sorties de stock.
export function buildSale({ id, number, lines, discount, payment, depotId, partnerId, by, at, userId = null }) {
  if (!lines.length) throw new Error('Le panier est vide');
  const totals = saleTotals(lines, discount);
  const sale = { number, lines, payment, depotId, partnerId: partnerId || null, by, userId, at, cancelled: false, ...totals };
  const movements = lines.map((l, i) => ({
    id: `${id}:v:${i}`,
    data: { articleId: l.articleId, depotId, qty: -l.qty, type: 'vente', ref: number, by, at },
  }));
  return { sale, movements };
}

// Identifiants déterministes : deux appareils qui annulent la même vente hors
// ligne produisent les mêmes mouvements, le stock n'est recrédité qu'une fois.
export function buildCancellation(saleId, sale, by, at) {
  return sale.lines.map((l, i) => ({
    id: `${saleId}:a:${i}`,
    data: { articleId: l.articleId, depotId: sale.depotId, qty: l.qty, type: 'annulation', ref: sale.number, by, at },
  }));
}

export function buildTransfer({ id, articleId, fromDepot, toDepot, qty, by, at, note = '' }) {
  if (fromDepot === toDepot) throw new Error('Choisissez deux dépôts différents');
  const base = { articleId, type: 'transfert', ref: '', note, by, at };
  return [
    { id: `${id}:out`, data: { ...base, depotId: fromDepot, qty: -qty } },
    { id: `${id}:in`, data: { ...base, depotId: toDepot, qty } },
  ];
}

// Coût moyen pondéré (CUMP) calculé depuis les entrées valorisées : il se déduit des
// mouvements, donc deux appareils qui réceptionnent hors ligne obtiennent le même résultat.
export function averageCosts(movements) {
  const acc = new Map();
  for (const m of movements) {
    if (m.qty <= 0 || typeof m.cost !== 'number' || m.cost < 0) continue;
    const a = acc.get(m.articleId) ?? { qty: 0, value: 0 };
    a.qty += m.qty;
    a.value += m.qty * m.cost;
    acc.set(m.articleId, a);
  }
  const out = new Map();
  for (const [id, a] of acc) if (a.qty > 0) out.set(id, Math.round(a.value / a.qty));
  return out;
}

export const costOf = (costs, article) => costs.get(article.id) ?? (article.cost || 0);

export function buildPurchase({ id, number, partnerId, depotId, lines, note = '', by, at }) {
  const valid = lines.filter((l) => l.articleId && l.qty > 0);
  if (!valid.length) throw new Error('Ajoutez au moins une ligne avec une quantité');
  if (valid.some((l) => !(l.cost >= 0))) throw new Error('Le coût unitaire doit être positif ou nul');
  const total = Math.round(valid.reduce((s, l) => s + l.qty * l.cost, 0));
  const purchase = { number, partnerId: partnerId || null, depotId, lines: valid, total, note, by, at };
  const movements = valid.map((l, i) => ({
    id: `${id}:r:${i}`,
    data: { articleId: l.articleId, depotId, qty: l.qty, cost: l.cost, type: 'achat', ref: number, partnerId: partnerId || null, by, at },
  }));
  return { purchase, movements };
}

// Rapport de ventes sur une période [from, to[ : marge calculée avec le coût figé à la vente.
export function salesReport(sales, { from = -Infinity, to = Infinity } = {}) {
  const kept = sales.filter((s) => !s.cancelled && s.at >= from && s.at < to);
  const byPayment = new Map();
  const bySeller = new Map();
  const byArticle = new Map();
  let revenue = 0, cost = 0, discount = 0, uncosted = 0;
  for (const s of kept) {
    revenue += s.total;
    discount += s.discount || 0;
    byPayment.set(s.payment, (byPayment.get(s.payment) ?? 0) + s.total);
    bySeller.set(s.by, (bySeller.get(s.by) ?? 0) + s.total);
    // La remise est répartie au prorata pour que la somme par article égale le CA.
    const ratio = s.subtotal ? s.total / s.subtotal : 0;
    for (const l of s.lines) {
      if (typeof l.cost !== 'number') uncosted += 1;
      const lineCost = (l.cost || 0) * l.qty;
      cost += lineCost;
      const a = byArticle.get(l.articleId) ?? { articleId: l.articleId, name: l.name, qty: 0, revenue: 0, margin: 0 };
      const lineRevenue = l.price * l.qty * ratio;
      a.qty = round3(a.qty + l.qty);
      a.revenue += lineRevenue;
      a.margin += lineRevenue - lineCost;
      byArticle.set(l.articleId, a);
    }
  }
  const sortDesc = (m) => [...m].sort((a, b) => b[1] - a[1]);
  return {
    count: kept.length,
    uncosted,
    revenue,
    discount,
    cost: Math.round(cost),
    margin: Math.round(revenue - cost),
    average: kept.length ? Math.round(revenue / kept.length) : 0,
    byPayment: sortDesc(byPayment),
    bySeller: sortDesc(bySeller),
    articles: [...byArticle.values()].map((a) => ({ ...a, revenue: Math.round(a.revenue), margin: Math.round(a.margin) }))
      .sort((a, b) => b.revenue - a.revenue),
  };
}

// Inventaire : enregistre seulement l'écart entre compté et théorique.
export function buildInventory({ id, depotId, counts, stock, by, at }) {
  const movements = [];
  for (const [articleId, counted] of Object.entries(counts)) {
    const delta = round3(counted - stockAt(stock, articleId, depotId));
    if (delta !== 0) {
      movements.push({
        id: `${id}:${articleId}`,
        data: { articleId, depotId, qty: delta, type: 'inventaire', ref: `Compté : ${counted}`, by, at },
      });
    }
  }
  return movements;
}

// --- Utilisateurs et rôles
export const ROLES = { gerant: 'Gérant', vendeur: 'Vendeur' };
// Écrans et actions réservés au gérant ; le vendeur garde caisse, ventes, articles en lecture.
export const SELLER_ROUTES = new Set(['dashboard', 'pos', 'sales', 'articles']);

export function validatePin(pin) {
  if (!/^\d{4,8}$/.test(pin)) throw new Error('Le code PIN doit contenir 4 à 8 chiffres');
}

const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

// PBKDF2 ralentit l'essai de codes, sans rendre un PIN de 4 chiffres inviolable :
// c'est un contrôle d'accès entre collègues, pas une protection des données de l'appareil.
export async function hashPin(pin, salt) {
  if (!globalThis.crypto?.subtle) throw new Error('Codes PIN indisponibles : ouvrez l’application en HTTPS ou sur localhost');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 120_000 }, key, 256);
  return toHex(bits);
}

export async function makeCredentials(pin) {
  validatePin(pin);
  const salt = newId();
  return { salt, pinHash: await hashPin(pin, salt) };
}

export async function checkPin(user, pin) {
  if (!user?.pinHash) return false;
  const hash = await hashPin(pin, user.salt);
  let diff = hash.length ^ user.pinHash.length;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ user.pinHash.charCodeAt(i);
  return diff === 0;
}

// Empêche de retirer le dernier gérant actif (sinon plus personne ne peut administrer).
export function assertKeepsManager(users, changedId, next) {
  const managers = users.filter((u) => u.active !== false && u.role === 'gerant');
  const stillManager = next.active !== false && next.role === 'gerant';
  if (!stillManager && managers.length === 1 && managers[0].id === changedId) {
    throw new Error('Il doit rester au moins un gérant actif');
  }
}
