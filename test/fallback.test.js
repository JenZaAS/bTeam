import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeInstance, FILES } from './helpers.js';

test('decisions box falls back to a heading section when no records exist', async () => {
  const files = Object.fromEntries(Object.entries(FILES).filter(([p]) => !p.startsWith('decisions/')));
  const I = await makeInstance({ files });
  const d = await I.core.get_box(I.owner, 'decisions');
  assert.deepEqual(d.entries, []);
  assert.equal(d.fallback.file, 'PLAN.md');
  assert.deepEqual(d.fallback.sections.map((s) => s.heading), ['Later']);
});
