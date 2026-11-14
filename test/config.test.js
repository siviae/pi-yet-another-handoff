import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, validateConfig } from '../src/config.js';
import { renderHandoffPrompt, requestContext, saveDocument } from '../src/handoff.js';
import { SessionManager } from '@earendil-works/pi-coding-agent';

test('config validates template paths and generation bounds', () => {
  for (const templateFile of ['', '  ', false, 123, {}]) assert.throws(() => validateConfig({ templateFile }));
  for (const maxTokens of [0, -1, 1.5, '8192']) assert.throws(() => validateConfig({ maxTokens }));
  assert.throws(() => validateConfig([]));
  assert.throws(() => validateConfig({ reasoning: 'fast' }));
  assert.equal(validateConfig({}).templateFile, null);
  assert.equal(validateConfig({}).timeoutMs, 600000);
  assert.equal(validateConfig({ autoHandoffAt: 90 }).autoHandoffAt, undefined);
});

test('trusted project config overlays global; untrusted config not read; malformed JSON fails visibly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-config-'));
  const old = process.env.PI_HANDOFF_CONFIG;
  process.env.PI_HANDOFF_CONFIG = join(dir, 'global.json');
  t.after(async () => { if (old === undefined) delete process.env.PI_HANDOFF_CONFIG; else process.env.PI_HANDOFF_CONFIG = old; await rm(dir, { recursive: true, force: true }); });
  await writeFile(process.env.PI_HANDOFF_CONFIG, JSON.stringify({ reasoning: 'high', maxTokens: 4096 }));
  await mkdir(join(dir, '.pi'));
  await writeFile(join(dir, '.pi/handoff.json'), JSON.stringify({ reasoning: 'off' }));
  const ctx = trusted => ({ cwd: dir, isProjectTrusted: () => trusted });
  assert.equal(loadConfig(ctx(true)).reasoning, 'off');
  assert.equal(loadConfig(ctx(true)).maxTokens, 4096);
  assert.equal(loadConfig(ctx(false)).reasoning, 'high');
  await writeFile(join(dir, '.pi/handoff.json'), '{');
  assert.throws(() => loadConfig(ctx(true)), /Cannot read handoff config/);
  assert.equal(loadConfig(ctx(false)).reasoning, 'high');
});

test('global config resolves from the Pi agent directory unless explicitly overridden', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-agent-config-'));
  const keys = ['PI_CODING_AGENT_DIR', 'PI_HANDOFF_CONFIG'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(dir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  delete process.env.PI_HANDOFF_CONFIG;
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  await writeFile(join(dir, 'handoff.json'), JSON.stringify({ maxTokens: 40 }));
  await writeFile(join(dir, 'agent/handoff.json'), JSON.stringify({ maxTokens: 90 }));
  const ctx = { cwd: dir, isProjectTrusted: () => false };
  assert.equal(loadConfig(ctx).maxTokens, 90);
  process.env.PI_HANDOFF_CONFIG = join(dir, 'override.json');
  await writeFile(process.env.PI_HANDOFF_CONFIG, JSON.stringify({ maxTokens: 75 }));
  assert.equal(loadConfig(ctx).maxTokens, 75);
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
