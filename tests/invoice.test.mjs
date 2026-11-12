import test from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, buildInvoice, nextInvoiceNumber, buildSale } from '../public/js/domain.js';

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
