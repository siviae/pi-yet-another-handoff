import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, DOCUMENT, until } from './helpers.js';

test('a changed branch during generation never switches using a stale summary', async t => {
  let finish, started = false;
  const h = await harness(t, { initial: sm => sm.appendCustomMessageEntry('handoff', 'Context', true),
    generate: () => { started = true; return new Promise(resolve => { finish = resolve; }); } });
  const pending = h.original.prompt('/handoff');
  await until(() => started);
  h.original.sessionManager.appendMessage({ role: 'user', content: 'NEW_INPUT', timestamp: Date.now() });
  finish({ document: DOCUMENT, metrics: { elapsedMs: 1 } });
  await pending;
  assert.equal(h.runtime.session, h.original);
  assert.equal(h.requests.length, 0);
  assert.match(h.notices.at(-1)[0], /Session changed during handoff/);
  assert.deepEqual(h.errors, []);
});
