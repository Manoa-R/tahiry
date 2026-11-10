import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClock, computeStock, stockAt, stockTotal, saleTotals, buildSale,
  buildCancellation, buildTransfer, buildInventory,
} from '../public/js/domain.js';

test('l’horloge reste croissante même si l’heure système recule', () => {
  const clock = createClock('a');
  const first = clock.tick(1000);
  const second = clock.tick(500);
  assert.ok(second > first);
});

test('l’horloge dépasse une date distante reçue', () => {
  const clock = createClock('a');
  clock.tick(1000);
  clock.receive('0000000005000-000003-b');
  assert.ok(clock.tick(2000) > '0000000005000-000003-b');
});

test('l’horloge reprend depuis sa dernière valeur persistée', () => {
  const before = createClock('a');
  const saved = before.tick(1000);
  assert.ok(createClock('a', saved).tick(1000) > saved);
});

test('le stock est la somme des mouvements par article et dépôt', () => {
  const stock = computeStock([
    { articleId: 'x', depotId: 'd1', qty: 10 },
    { articleId: 'x', depotId: 'd1', qty: -0.1 },
    { articleId: 'x', depotId: 'd2', qty: 5 },
  ]);
  assert.equal(stockAt(stock, 'x', 'd1'), 9.9);
  assert.equal(stockTotal(stock, 'x'), 14.9);
});

test('la remise ne dépasse jamais le sous-total', () => {
  assert.deepEqual(saleTotals([{ price: 1000, qty: 2 }], 5000), { subtotal: 2000, discount: 2000, total: 0 });
  assert.deepEqual(saleTotals([{ price: 1000, qty: 2 }], -5).discount, 0);
});

const lines = [{ articleId: 'x', name: 'X', price: 500, qty: 3 }];
const params = { id: 's1', number: 'V1', lines, discount: 100, payment: 'MVola', depotId: 'd', by: 'p', at: 1 };

test('une vente génère ses sorties, et refuse un panier vide', () => {
  const { sale, movements } = buildSale(params);
  assert.equal(sale.total, 1400);
  assert.equal(movements[0].data.qty, -3);
  assert.throws(() => buildSale({ ...params, lines: [] }));
});

test('deux annulations concurrentes recréditent une seule fois', () => {
  const { sale } = buildSale(params);
  const a = buildCancellation('s1', sale, 'a', 2);
  const b = buildCancellation('s1', sale, 'b', 3);
  assert.deepEqual(a.map((m) => m.id), b.map((m) => m.id));
});

test('un transfert conserve le stock total et refuse le même dépôt', () => {
  const moves = buildTransfer({ id: 't', articleId: 'x', fromDepot: 'a', toDepot: 'b', qty: 4 });
  assert.equal(moves[0].data.qty + moves[1].data.qty, 0);
  assert.throws(() => buildTransfer({ id: 't', articleId: 'x', fromDepot: 'a', toDepot: 'a', qty: 4 }));
});

test('l’inventaire ne crée un mouvement que pour les écarts', () => {
  const stock = computeStock([{ articleId: 'x', depotId: 'd', qty: 10 }, { articleId: 'y', depotId: 'd', qty: 3 }]);
  const moves = buildInventory({ id: 'i', depotId: 'd', counts: { x: 8, y: 3 }, stock });
  assert.equal(moves.length, 1);
  assert.equal(moves[0].data.qty, -2);
});

import { averageCosts, costOf, buildPurchase, salesReport } from '../public/js/domain.js';

test('le coût moyen pondéré ignore sorties et entrées non valorisées', () => {
  const costs = averageCosts([
    { articleId: 'x', qty: 10, cost: 1000 },
    { articleId: 'x', qty: 30, cost: 2000 },
    { articleId: 'x', qty: -5 },
    { articleId: 'x', qty: 7 },
  ]);
  assert.equal(costs.get('x'), 1750);
  assert.equal(costOf(costs, { id: 'y', cost: 300 }), 300);
});

test('une réception crée des entrées valorisées et rejette les lignes vides', () => {
  const { purchase, movements } = buildPurchase({
    id: 'p', number: 'A1', depotId: 'd', partnerId: 'f',
    lines: [{ articleId: 'x', qty: 4, cost: 250 }, { articleId: '', qty: 2, cost: 1 }, { articleId: 'y', qty: 0, cost: 9 }],
  });
  assert.equal(purchase.total, 1000);
  assert.equal(movements.length, 1);
  assert.deepEqual([movements[0].data.qty, movements[0].data.cost, movements[0].data.type], [4, 250, 'achat']);
  assert.throws(() => buildPurchase({ id: 'p', lines: [] }));
  assert.throws(() => buildPurchase({ id: 'p', lines: [{ articleId: 'x', qty: 1, cost: -1 }] }));
});

test('le rapport exclut les ventes annulées et répartit la remise', () => {
  const sale = (at, cancelled = false) => ({
    at, cancelled, payment: 'MVola', by: 'Soa', subtotal: 1000, discount: 100, total: 900,
    lines: [{ articleId: 'x', name: 'X', price: 500, qty: 2, cost: 300 }],
  });
  const r = salesReport([sale(10), sale(20, true), sale(99)], { from: 0, to: 50 });
  assert.equal(r.count, 1);
  assert.equal(r.revenue, 900);
  assert.equal(r.margin, 300);
  assert.equal(r.articles[0].revenue, 900);
  assert.deepEqual(r.byPayment, [['MVola', 900]]);
});
