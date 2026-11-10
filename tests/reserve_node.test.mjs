// Unit tests for reserve.js relative start-time parsing. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStart } from '../scripts/node/reserve.js';

const NOW = new Date('2026-11-09T23:58:30.123Z');

test('relative start converts to UTC ISO', () => {
  assert.equal(parseStart('+10m', NOW), '2026-11-10T00:08:30Z');
  assert.equal(parseStart('+2h', NOW), '2026-11-10T01:58:30Z');
  assert.equal(parseStart('+1d', NOW), '2026-11-10T23:58:30Z');
  assert.equal(parseStart(' +5m ', NOW), '2026-11-10T00:03:30Z');
});

test('absolute start passes through', () => {
  assert.equal(parseStart('2026-11-10T15:00:00Z', NOW), '2026-11-10T15:00:00Z');
});

test('bad relative start is rejected', () => {
  for (const bad of ['+10', '+m', '+10s', '+1.5h']) {
    assert.throws(() => parseStart(bad, NOW));
  }
});
