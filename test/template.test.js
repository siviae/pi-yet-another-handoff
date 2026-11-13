import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { renderHandoffPrompt } from '../src/handoff.js';
import { harness, until } from './helpers.js';

test('template paths resolve relative to their own config; project overrides require trust', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-template-'));
  const previous = process.env.PI_HANDOFF_CONFIG;
  process.env.PI_HANDOFF_CONFIG = join(dir, 'global/handoff.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_HANDOFF_CONFIG;
    else process.env.PI_HANDOFF_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, 'global'));
  await mkdir(join(dir, '.pi'));
  await writeFile(process.env.PI_HANDOFF_CONFIG, JSON.stringify({ templateFile: 'global.md' }));
  await writeFile(join(dir, '.pi/handoff.json'), JSON.stringify({ templateFile: 'project.md' }));
  const ctx = trusted => ({ cwd: dir, isProjectTrusted: () => trusted });
  assert.equal(loadConfig(ctx(false)).templateFile, join(dir, 'global/global.md'));
  assert.equal(loadConfig(ctx(true)).templateFile, join(dir, '.pi/project.md'));
  await writeFile(join(dir, '.pi/handoff.json'), '{}');
  assert.equal(loadConfig(ctx(true)).templateFile, join(dir, 'global/global.md'));
  await writeFile(join(dir, '.pi/handoff.json'), '{"templateFile":null}');
  assert.equal(loadConfig(ctx(true)).templateFile, null);
});

test('custom template is reread and renders optional and repeated literal focus', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-render-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'custom.md');
  await writeFile(path, 'CUSTOM {{#if additionalFocus}}Focus: {{additionalFocus}}{{/if}} {{additionalFocus}}');
  assert.equal(renderHandoffPrompt(undefined, path), 'CUSTOM  ');
  assert.equal(renderHandoffPrompt('$&', path), 'CUSTOM Focus: $& $&');
  await writeFile(path, 'UPDATED');
  assert.equal(renderHandoffPrompt(undefined, path), 'UPDATED');
  await writeFile(path, '  ');
  assert.throws(() => renderHandoffPrompt(undefined, path), /template is empty/);
  assert.throws(() => renderHandoffPrompt(undefined, join(dir, 'missing')), /Cannot read handoff template/);
});

test('configured template reaches the generation request', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-provider-template-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'custom.md');
  await writeFile(path, 'Write a handoff document CUSTOM_TEMPLATE {{additionalFocus}}');
  const custom = await harness(t, {
    config: { templateFile: path },
    initial: sm => sm.appendCustomMessageEntry('handoff', 'Context', true),
  });
  await custom.original.prompt('/handoff tests');
  await until(() => custom.requests.length === 2 && custom.runtime.session.isIdle);
  assert.match(JSON.stringify(custom.requests[0].context), /CUSTOM_TEMPLATE tests/);
  assert.deepEqual(custom.errors, []);
});

test('unreadable custom template retains the session without a provider request', async t => {
  const h = await harness(t, {
    config: { templateFile: '/nonexistent/handoff-template.md' },
    initial: sm => sm.appendCustomMessageEntry('handoff', 'Context', true),
  });
  await h.original.prompt('/handoff');
  assert.equal(h.runtime.session, h.original);
  assert.equal(h.requests.length, 0);
  assert.match(h.notices.at(-1)[0], /Cannot read handoff template/);
});
