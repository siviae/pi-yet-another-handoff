import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, toolAnswer, DOCUMENT, until } from './helpers.js';

test('threshold compaction cannot consume context before configured handoff percentage', async t => {
  const h = await harness(t, { compaction: { enabled: true, reserveTokens: 20000, keepRecentTokens: 1000 },
    handler: (r, all) => {
      if (r.summary) return { text: DOCUMENT, usage: 500 };
      const n = all.filter(r => !r.summary).length;
      return n <= 2 ? { ...toolAnswer, usage: n === 1 ? 85000 : 92000 } : { text: 'Done', usage: 1000 };
    } });
  await h.original.prompt('Task');
  await until(() => h.runtime.session !== h.original && h.requests.length === 4 && h.runtime.session.isIdle);
  assert.deepEqual(h.requests.map(r => r.summary), [false, false, true, false]);
  assert.equal(h.original.sessionManager.getEntries().filter(e => e.type === 'compaction').length, 0);
  assert.equal(h.events.filter(e => e === 'tool').length, 2);
  assert.deepEqual(h.errors, []);
});

test('repeated automatic handoffs retain previous handoff context across fresh extension runtimes', async t => {
  const h = await harness(t, { handler: (r, all) => {
    if (r.summary) return { text: DOCUMENT + '\nGeneration ' + all.filter(r => r.summary).length, usage: 1000 };
    return all.filter(r => !r.summary).length <= 2 ? toolAnswer : { text: 'Done', usage: 1000 };
  } });
  await h.original.prompt('Task');
  await until(() => h.requests.length === 5 && h.runtime.session.isIdle);
  assert.deepEqual(h.requests.map(r => r.summary), [false, true, false, true, false]);
  assert.match(JSON.stringify(h.requests[3].context), /Generation 1/);
  assert.match(JSON.stringify(h.requests[4].context), /Generation 2/);
  assert.equal(h.events.filter(e => e === 'shutdown:new').length, 2);
  assert.deepEqual(h.errors, []);
});

test('user abort does not launch automatic handoff', async t => {
  const h = await harness(t, { handler: () => toolAnswer,
    extraFactories: [pi => pi.on('tool_call', (_e, ctx) => { ctx.abort(); })] });
  await h.original.prompt('Task');
  assert.equal(h.runtime.session, h.original);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.errors, []);
});

test('queued user steering is consumed instead of discarded on session replacement', async t => {
  let sent = false;
  const h = await harness(t, { handler: (_r, all) => all.length === 1 ? toolAnswer : { text: 'Done', usage: 1000 },
    extraFactories: [pi => pi.on('tool_execution_end', () => {
      if (sent) return;
      sent = true;
      pi.sendUserMessage('STEERING_SENTINEL', { deliverAs: 'steer' });
    })] });
  await h.original.prompt('Task');
  assert.equal(h.runtime.session, h.original);
  assert.equal(h.requests.length, 2);
  assert.match(JSON.stringify(h.requests[1].context), /STEERING_SENTINEL/);
  assert.deepEqual(h.errors, []);
});

test('auto failure pauses further auto attempts in the same runtime', async t => {
  const h = await harness(t, { handler: (r, all) => r.summary ? { stopReason: 'error', errorMessage: 'provider unavailable' } :
    all.filter(r => !r.summary).length <= 2 ? toolAnswer : { text: 'Done' } });
  await h.original.prompt('Task');
  await until(() => h.requests.length === 2 && h.original.isIdle);
  await h.original.prompt('Try another step');
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests.filter(r => r.summary).length, 1);
  assert.equal(h.runtime.session, h.original);
});
