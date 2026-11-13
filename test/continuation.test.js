import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, toolAnswer, DOCUMENT, until } from './helpers.js';
import { createHandoffExtension } from '../src/extension.js';

test('extension registers no automatic command or tool/compaction lifecycle hooks', () => {
  const events = [], commands = [];
  createHandoffExtension()({
    on: name => events.push(name),
    registerCommand: name => commands.push(name),
  });
  assert.deepEqual(commands, ['handoff']);
  assert.deepEqual(events.sort(), ['session_shutdown', 'session_start']);
});

test('repeated manual handoffs retain context across fresh extension runtimes', async t => {
  const h = await harness(t, {
    initial: sm => sm.appendCustomMessageEntry('handoff', 'Initial context', true),
    handler: (r, all) => r.summary
      ? { text: DOCUMENT + '\nGeneration ' + all.filter(r => r.summary).length, usage: 1000 }
      : { text: 'Done', usage: 1000 },
  });
  await h.original.prompt('/handoff');
  await until(() => h.requests.length === 2 && h.runtime.session.isIdle);
  await h.runtime.session.prompt('/handoff');
  await until(() => h.requests.length === 4 && h.runtime.session.isIdle);
  assert.deepEqual(h.requests.map(r => r.summary), [true, false, true, false]);
  assert.match(JSON.stringify(h.requests[2].context), /Generation 1/);
  assert.match(JSON.stringify(h.requests[3].context), /Generation 2/);
  assert.equal(h.events.filter(e => e === 'shutdown:new').length, 2);
  assert.deepEqual(h.errors, []);
});

test('queued user steering is consumed in the current session', async t => {
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
