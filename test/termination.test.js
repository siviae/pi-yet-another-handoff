import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, toolAnswer } from './helpers.js';

test('a terminating tool batch is a finished run, not work to restart', async t => {
  const h = await harness(t, { terminate: true, handler: () => toolAnswer });
  await h.original.prompt('Task');
  assert.equal(h.runtime.session, h.original);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.errors, []);
});
