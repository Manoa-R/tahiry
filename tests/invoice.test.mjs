import test from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, buildInvoice, nextInvoiceNumber, buildSale, buildCreditNote, buildQuote, quoteStatus, nextDocNumber } from '../public/js/domain.js';

test('montants en toutes lettres', () => {
  const cases = {
    0: 'zéro', 1: 'un', 17: 'dix-sept', 21: 'vingt et un', 71: 'soixante et onze', 80: 'quatre-vingts',
    81: 'quatre-vingt-un', 91: 'quatre-vingt-onze', 99: 'quatre-vingt-dix-neuf', 100: 'cent', 200: 'deux cents',
    201: 'deux cent un', 1000: 'mille', 1001: 'mille un', 2000: 'deux mille', 80000: 'quatre-vingt mille',
    200000: 'deux cent mille', 1000000: 'un million', 2500000: 'deux millions cinq cent mille',
    12345: 'douze mille trois cent quarante-cinq', 1000000000: 'un milliard',
  };
  for (const [n, words] of Object.entries(cases)) assert.equal(amountInWords(Number(n)), words, n);
});

const { sale } = buildSale({
  id: 's1', number: 'V1', payment: 'MVola', depotId: 'd', by: 'Soa', at: 1, discount: 1000,
  lines: [{ articleId: 'riz', name: 'Riz', qty: 3, price: 4000 }, { articleId: 'eau', name: 'Eau', qty: 1, price: 1000 }],
});

test('la facture fige la vente, le client et la boutique, avec la TVA incluse', () => {
  const inv = buildInvoice({ number: 'FA26-X-0001', saleId: 's1', sale, client: { name: 'Hôtel Soa', nif: '123' }, shop: { name: 'Épicerie', vat: true }, by: 'Rova', at: 2 });
  assert.equal(inv.total, 12000);
  assert.deepEqual(inv.vat, { rate: 0.2, amount: 2000, base: 10000 });
  assert.equal(inv.client.nif, '123');
  assert.equal(inv.words, 'douze mille ariary');
  assert.equal(buildInvoice({ number: 'n', saleId: 's1', sale, client: null, shop: {}, by: '', at: 0 }).vat, null);
  assert.throws(() => buildInvoice({ number: 'n', saleId: 's1', sale: { ...sale, cancelled: true }, shop: {} }));
});

test('numérotation continue par appareil et par année', () => {
  assert.equal(nextInvoiceNumber([], 'AB12', 2026), 'FA26-AB12-0001');
  assert.equal(nextInvoiceNumber(['FA26-AB12-0001', 'FA26-AB12-0007', 'FA26-ZZ99-0010', 'FA25-AB12-0050'], 'AB12', 2026), 'FA26-AB12-0008');
});

test('l’avoir reprend la facture qu’il annule', () => {
  const inv = buildInvoice({ number: 'FA26-X-0001', saleId: 's1', sale, client: { name: 'Hôtel Soa' }, shop: { name: 'Épicerie', vat: true }, by: 'Rova', at: 2 });
  const av = buildCreditNote({ number: 'AV26-X-0001', invoice: inv, reason: 'Vente annulée', by: 'Rova', at: 3 });
  assert.equal(av.kind, 'avoir');
  assert.equal(av.invoiceNumber, 'FA26-X-0001');
  assert.deepEqual([av.total, av.vat, av.client.name], [12000, inv.vat, 'Hôtel Soa']);
});

test('le devis fige les prix, expire et se transforme', () => {
  const q = buildQuote({ number: 'DV26-X-0001', lines: sale.lines, discount: 1000, client: null, shop: {}, by: 'Soa', userId: 'v', at: 0, days: 30 });
  assert.deepEqual([q.total, q.status, q.client.name, q.vat], [12000, 'ouvert', 'Client de passage', null]);
  assert.equal(quoteStatus(q, 29 * 86_400_000), 'en cours');
  assert.equal(quoteStatus(q, 31 * 86_400_000), 'expiré');
  assert.equal(quoteStatus({ ...q, saleId: 's9' }, 31 * 86_400_000), 'transformé');
  assert.throws(() => buildQuote({ number: 'n', lines: [], shop: {} }));
});

test('chaque type de document a sa propre série', () => {
  const existing = ['FA26-AB12-0004', 'AV26-AB12-0001'];
  assert.equal(nextDocNumber(existing, 'AV', 'AB12', 2026), 'AV26-AB12-0002');
  assert.equal(nextDocNumber(existing, 'DV', 'AB12', 2026), 'DV26-AB12-0001');
});
