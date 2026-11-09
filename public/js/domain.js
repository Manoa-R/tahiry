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
export function buildSale({ id, number, lines, discount, payment, depotId, partnerId, by, at }) {
  if (!lines.length) throw new Error('Le panier est vide');
  const totals = saleTotals(lines, discount);
  const sale = { number, lines, payment, depotId, partnerId: partnerId || null, by, at, cancelled: false, ...totals };
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
