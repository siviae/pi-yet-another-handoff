import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, until } from './helpers.js';

for (const level of ['off', 'low', 'high']) {
  test(`/handoff preserves selected model and thinking=${level} before kickoff`, async t => {
    const h = await harness(t, {
      initial: sm => sm.appendCustomMessageEntry('context', 'Unfinished work', true),
      config: { reasoning: 'minimal' },
    });
    await h.original.setModel({ ...h.original.model, id: 'other', name: 'other' });
    h.original.setThinkingLevel(level);
    await h.original.prompt('/handoff');
    await until(() => h.requests.length === 2 && h.runtime.session.isIdle);
    assert.equal(h.runtime.session.model.id, 'other');
    assert.equal(h.runtime.session.thinkingLevel, level);
    assert.equal(h.requests[0].options.reasoning, 'minimal');
    assert.equal(h.requests[1].model, 'other');
    assert.equal(h.requests[1].options.reasoning, level === 'off' ? undefined : level);
    const branch = h.runtime.session.sessionManager.getBranch();
    assert.equal(branch.findLast(e => e.type === 'model_change').modelId, 'other');
    assert.equal(branch.findLast(e => e.type === 'thinking_level_change').thinkingLevel, level);
    await h.runtime.session.prompt('/handoff');
    await until(() => h.requests.length === 4 && h.runtime.session.isIdle);
    assert.equal(h.requests[3].model, 'other');
    assert.equal(h.requests[3].options.reasoning, level === 'off' ? undefined : level);
    assert.deepEqual(h.errors, []);
  });
}
