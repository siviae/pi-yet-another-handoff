import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness, toolAnswer, DOCUMENT, until } from './helpers.js';

test('automatic threshold: complete tools, summarize once, replace session and continue without user input', async t => {
  const h = await harness(t, { handler: (r, all) => r.summary ? { text: DOCUMENT, usage: 500 } : all.filter(r => !r.summary).length === 1 ? toolAnswer : { text: 'Task complete', usage: 1000 } });
  await h.original.prompt('Finish my task');
  await until(() => h.runtime.session !== h.original && h.requests.length >= 3 && h.runtime.session.isIdle);
  assert.deepEqual(h.requests.map(r => r.summary), [false, true, false]);
  assert.equal(h.events[1], 'tool');
  assert.ok(h.events.includes('shutdown:new'));
  assert.ok(h.events.includes('start:new'));
  const next = h.runtime.session;
  assert.equal(next.sessionManager.getHeader().parentSession, h.original.sessionManager.getSessionFile());
  assert.match(JSON.stringify(h.requests.at(-1).context), /SECRET_STATE/);
  assert.match(JSON.stringify(h.requests.at(-1).context), /Continue the unfinished work/);
  const summary = h.requests[1];
  assert.equal(summary.options.sessionId, h.original.sessionId);
  assert.equal(summary.options.cacheRetention, 'short');
  assert.equal(summary.options.reasoning, 'low');
  assert.equal(summary.context.messages.filter(m => m.role === 'system').length, 1, 'system prompt is not duplicated');
  const metrics = next.sessionManager.getEntries().find(e => e.customType === 'pi-yet-another-handoff.metrics').data;
  assert.equal(metrics.automatic, true);
  assert.ok(metrics.firstTextMs >= 0);
  assert.equal((await readFile(metrics.path, 'utf8')).trim(), DOCUMENT.trim());
  assert.ok(next.sessionManager.getEntries().some(e => e.type === 'usage' && e.kind === 'handoff'));
  assert.deepEqual(h.errors, []);
});

test('manual handoff continues immediately and includes previous custom handoff context', async t => {
  const h = await harness(t, { initial: sm => sm.appendCustomMessageEntry('handoff', 'PREVIOUS_HANDOFF_SENTINEL', true) });
  await h.original.prompt('/handoff focus on tests');
  await until(() => h.runtime.session !== h.original && h.runtime.session.isIdle);
  assert.equal(h.requests.length, 2);
  assert.match(JSON.stringify(h.requests[0].context), /PREVIOUS_HANDOFF_SENTINEL/);
  assert.match(JSON.stringify(h.requests[0].context), /Additional focus: focus on tests/);
  assert.match(JSON.stringify(h.requests[1].context), /Additional focus: focus on tests/);
  assert.deepEqual(h.errors, []);
});

test('final answer at 90% does not restart a completed task', async t => {
  const h = await harness(t, { handler: () => ({ text: 'Done' }) });
  await h.original.prompt('Task');
  assert.equal(h.requests.length, 1);
  assert.equal(h.runtime.session, h.original);
});

test('auto handoff is disabled by default', async t => {
  const h = await harness(t, { config: {}, handler: (_r, all) => all.length === 1 ? toolAnswer : { text: 'Done' } });
  await h.original.prompt('Task');
  assert.equal(h.requests.length, 2);
  assert.equal(h.runtime.session, h.original);
});

for (const stopReason of ['error', 'aborted', 'length']) test(`generation ${stopReason} retains original session and never continues`, async t => {
  const h = await harness(t, { handler: r => r.summary ? { text: 'partial', stopReason, errorMessage: 'test failure' } : toolAnswer });
  await h.original.prompt('Task');
  await until(() => h.requests.length === 2 && h.original.isIdle);
  assert.equal(h.runtime.session, h.original);
  assert.equal(h.requests.filter(r => r.summary).length, 1);
});

test('session switch veto retains original with saved handoff', async t => {
  const h = await harness(t, { initial: sm => sm.appendCustomMessageEntry('handoff', 'Context', true),
    extraFactories: [pi => pi.on('session_before_switch', () => ({ cancel: true }))] });
  await h.original.prompt('/handoff');
  assert.equal(h.runtime.session, h.original);
  assert.equal(h.requests.length, 1);
  const record = h.original.sessionManager.getEntries().find(e => e.customType === 'pi-yet-another-handoff.metrics').data;
  assert.match(await readFile(record.path, 'utf8'), /SECRET_STATE/);
});

test('bounded timeout even if generator ignores abort', async t => {
  const h = await harness(t, { config: { timeoutMs: 20 }, initial: sm => sm.appendCustomMessageEntry('handoff', 'Context', true),
    generate: () => new Promise(() => {}) });
  await h.original.prompt('/handoff');
  assert.equal(h.runtime.session, h.original);
  assert.equal(h.requests.length, 0);
});

test('artifact write failure prevents session switch', async t => {
  const h = await harness(t, { initial: sm => sm.appendCustomMessageEntry('handoff', 'Context', true),
    save: () => { throw new Error('disk full'); } });
  await h.original.prompt('/handoff');
  assert.equal(h.runtime.session, h.original);
  assert.equal(h.requests.length, 1);
});
