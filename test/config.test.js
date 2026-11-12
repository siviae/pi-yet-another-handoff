import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, validateConfig, shouldAutoHandoff } from '../src/config.js';
import { renderHandoffPrompt, requestContext, saveDocument } from '../src/handoff.js';
import { SessionManager } from '@earendil-works/pi-coding-agent';

test('config rejects invalid thresholds and bounds', () => {
  for (const autoHandoffAt of [0, 100, -1, '90', true, null, NaN, Infinity]) assert.throws(() => validateConfig({ autoHandoffAt }));
  for (const maxTokens of [0, -1, 1.5, '8192']) assert.throws(() => validateConfig({ maxTokens }));
  assert.throws(() => validateConfig([]));
  assert.throws(() => validateConfig({ reasoning: 'fast' }));
  assert.equal(validateConfig({ autoHandoffAt: 90 }).autoHandoffAt, 90);
  assert.equal(validateConfig({}).autoHandoffAt, false);
});

test('trusted project config overlays global; untrusted config not read; malformed JSON fails visibly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-config-'));
  const old = process.env.PI_HANDOFF_CONFIG;
  process.env.PI_HANDOFF_CONFIG = join(dir, 'global.json');
  t.after(async () => { if (old === undefined) delete process.env.PI_HANDOFF_CONFIG; else process.env.PI_HANDOFF_CONFIG = old; await rm(dir, { recursive: true, force: true }); });
  await writeFile(process.env.PI_HANDOFF_CONFIG, JSON.stringify({ autoHandoffAt: 90, maxTokens: 4096 }));
  await mkdir(join(dir, '.pi'));
  await writeFile(join(dir, '.pi/handoff.json'), JSON.stringify({ autoHandoffAt: false }));
  const ctx = trusted => ({ cwd: dir, isProjectTrusted: () => trusted });
  assert.equal(loadConfig(ctx(true)).autoHandoffAt, false);
  assert.equal(loadConfig(ctx(true)).maxTokens, 4096);
  assert.equal(loadConfig(ctx(false)).autoHandoffAt, 90);
  await writeFile(join(dir, '.pi/handoff.json'), '{');
  assert.throws(() => loadConfig(ctx(true)), /Cannot read handoff config/);
  assert.equal(loadConfig(ctx(false)).autoHandoffAt, 90);
});

test('decision requires completed non-terminating tool turn with known usage', () => {
  const event = { outcome: 'completed', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall' }] }, toolResults: [{}] };
  const config = validateConfig({ autoHandoffAt: 90 });
  assert.equal(shouldAutoHandoff(event, { percent: 90 }, config), true);
  for (const percent of [null, undefined, 89.99, NaN]) assert.equal(shouldAutoHandoff(event, { percent }, config), false);
  assert.equal(shouldAutoHandoff({ ...event, outcome: 'aborted' }, { percent: 95 }, config), false);
  assert.equal(shouldAutoHandoff({ ...event, toolResults: [{ terminate: true }] }, { percent: 95 }, config), false);
});

test('template preserves original schema and literal focus strings', () => {
  assert.doesNotMatch(renderHandoffPrompt(), /{{|Additional focus/);
  assert.match(renderHandoffPrompt('$&'), /Additional focus: \$&/);
  for (const heading of ['## Goal', '## Constraints & Preferences', '### Done', '### In Progress', '### Pending', '## Key Decisions', '## Critical Context', '## Next Steps']) assert.ok(renderHandoffPrompt().includes(heading));
  assert.equal(saveDocument(undefined, 'text'), undefined);
});

test('projection respects context edits, latest compaction, previous handoff and tree summaries', () => {
  const sm = SessionManager.inMemory('/tmp');
  const dropped = sm.appendMessage({ role: 'user', content: 'OLD_OMITTED', timestamp: Date.now() });
  const kept = sm.appendCustomMessageEntry('handoff', 'PREVIOUS_HANDOFF', true);
  sm.appendCompaction('COMPACTION_SUMMARY', kept, 10000);
  sm.appendMessage({ role: 'user', content: 'AFTER_COMPACTION', timestamp: Date.now() });
  const edited = sm.appendMessage({ role: 'user', content: 'UNEDITED_SENTINEL', timestamp: Date.now() });
  sm.appendContextEdit(edited, { role: 'user', content: 'EDITED_SENTINEL', timestamp: Date.now() });
  const text = JSON.stringify(requestContext({ sessionManager: sm, getSystemPrompt: () => 'SYSTEM' }));
  assert.doesNotMatch(text, /OLD_OMITTED|UNEDITED_SENTINEL/);
  for (const marker of ['COMPACTION_SUMMARY', 'PREVIOUS_HANDOFF', 'AFTER_COMPACTION', 'EDITED_SENTINEL']) assert.match(text, new RegExp(marker));
});
