import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffExtension } from '../src/extension.js';
import { validateConfig } from '../src/config.js';

for (const cancel of [false, true]) test(`TUI progress stays in the generating panel (${cancel ? 'cancel' : 'failure'})`, async () => {
  let command, component, finishUI, generationStarted;
  const started = new Promise(resolve => { generationStarted = resolve; });
  const frames = [], notices = [];
  createHandoffExtension({
    readConfig: () => validateConfig({}),
    generate: async (_ctx, _goal, _config, signal, update) => {
      update({ phase: 'text_delta', chars: 3343 });
      generationStarted();
      if (cancel) await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      else throw new Error('test generation failed');
    },
  })({ on() {}, registerCommand: (_name, options) => { command = options.handler; } });
  const ctx = {
    mode: 'tui', hasUI: true,
    sessionManager: { getSessionId: () => 'session', getSessionFile: () => undefined, getLeafId: () => 'leaf' },
    waitForIdle: async () => {}, hasPendingMessages: () => false,
    ui: {
      setStatus: () => assert.fail('Progress must not use the footer'),
      notify: message => notices.push(message),
      custom: factory => new Promise(resolve => {
        finishUI = result => { component.dispose(); resolve(result); };
        component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, finishUI);
        frames.push(component.render(160).join('\n'));
      }),
    },
  };
  const pending = command('', ctx);
  await started;
  assert.match(frames[0], /Generating handoff: 0s, text_delta, 3343 chars/);
  if (cancel) component.handleInput('\x1b');
  await pending;
  assert.match(notices[0], /Handoff stopped/);
});
