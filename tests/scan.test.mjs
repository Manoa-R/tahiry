import test from 'node:test';
import assert from 'node:assert/strict';
import { findByCode, normalizeCode } from '../public/js/domain.js';

const catalog = [
  { id: 'riz', code: '6200000000011' },
  { id: 'cola', code: '0049000028911' },
  { id: 'vrac', code: 'REF-Sucre' },
  { id: 'sans' },
];

test('retrouve un article par son code, quel que soit le format lu', () => {
  assert.equal(findByCode(catalog, '6200000000011').id, 'riz');
  assert.equal(findByCode(catalog, ' 6200000000011 ').id, 'riz');
  assert.equal(findByCode(catalog, '049000028911').id, 'cola'); // UPC-A lu sans le 0 de l'EAN-13
  assert.equal(findByCode(catalog, 'ref-sucre').id, 'vrac');
  assert.equal(findByCode(catalog, '999'), null);
  assert.equal(findByCode(catalog, ''), null);
  assert.equal(normalizeCode('000'), '0');
});
