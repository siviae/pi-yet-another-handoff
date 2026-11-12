import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createHandoffExtension } from '../src/extension.js';
import { validateConfig } from '../src/config.js';

export const DOCUMENT = '## Goal\nFinish the task\n## Constraints & Preferences\nNone\n## Progress\n### Done\n- [x] Tool completed\n### In Progress\n- [ ] Finish\n### Pending\nNone\n## Key Decisions\nNone\n## Critical Context\nSECRET_STATE\n## Next Steps\n1. Finish\n';

export async function harness(t, { handler, config = { autoHandoffAt: 90 }, generate, save, initial, extraFactories = [], compaction = { enabled: false }, terminate = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'handoff-test-'));
  await mkdir(join(root, 'agent'));
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const requests = [], errors = [], notices = [], events = [];
  modelRuntime.registerProvider('fake', {
    api: 'openai-completions', baseUrl: 'https://invalid.example', apiKey: 'offline-test',
    models: [{ id: 'test', name: 'test', reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
      const request = { context: structuredClone(context), options, summary: JSON.stringify(context.messages.at(-1)).includes('Write a handoff document') };
      requests.push(request);
      void (async () => {
        const message = { role: 'assistant', api: model.api, provider: 'fake', model: 'test', timestamp: Date.now(), content: [], stopReason: 'pending',
          usage: { input: 90000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 90100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        try {
          const answer = await handler?.(request, requests) ?? (request.summary ? { text: DOCUMENT } : { text: 'Task complete', usage: 1000 });
          if (options?.signal?.aborted) throw new Error('aborted');
          stream.push({ type: 'start', partial: message });
          message.content = answer.content ?? [{ type: 'text', text: answer.text ?? '' }];
          if (answer.usage !== undefined) {
            message.usage.input = answer.usage;
            message.usage.totalTokens = answer.usage + message.usage.output;
          }
          message.stopReason = answer.stopReason ?? 'stop';
          if (answer.errorMessage) message.errorMessage = answer.errorMessage;
          for (const c of message.content) if (c.type === 'text') stream.push({ type: 'text_delta', contentIndex: 0, delta: c.text, partial: message });
          if (['error', 'aborted'].includes(message.stopReason)) stream.push({ type: 'error', reason: message.stopReason, error: message });
          else stream.push({ type: 'done', reason: message.stopReason, message });
        } catch (e) {
          message.stopReason = options?.signal?.aborted ? 'aborted' : 'error'; message.errorMessage = e.message;
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        }
        stream.end();
      })();
      return stream;
    },
  });
  const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const settings = SettingsManager.inMemory({ compaction, retry: { enabled: false }, cacheWarming: 'off' });
    settings.setProjectTrusted(true);
    const services = await createAgentSessionServices({ cwd, agentDir: join(root, 'agent'), modelRuntime, settingsManager: settings,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'TEST_SYSTEM', appendSystemPrompt: [],
        extensionFactories: [createHandoffExtension({ readConfig: () => validateConfig(config), ...(generate ? { generate } : {}), ...(save ? { save } : {}) }),
          pi => {
            pi.registerTool({ name: 'work', label: 'work', description: 'Work', parameters: { type: 'object', properties: {} },
              async execute() { events.push('tool'); return { content: [{ type: 'text', text: 'tool completed' }], details: {}, terminate }; } });
            pi.on('session_start', e => events.push('start:' + e.reason));
            pi.on('session_shutdown', e => events.push('shutdown:' + e.reason));
          }, ...extraFactories] } });
    if (services.resourceLoader.getExtensions().errors.length) throw new Error(JSON.stringify(services.resourceLoader.getExtensions().errors));
    return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: modelRuntime.getModel('fake', 'test'), thinkingLevel: 'medium', tools: ['work'] }), services, diagnostics: services.diagnostics };
  };
  const sm = SessionManager.create(root, join(root, 'sessions'));
  initial?.(sm);
  const runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir: join(root, 'agent'), sessionManager: sm });
  const bind = async session => session.bindExtensions({ mode: 'json', onError: e => errors.push(e), uiContext: { notify: (...args) => notices.push(args), setStatus() {} },
    commandContextActions: { waitForIdle: () => session.waitForIdle(), reload: () => session.reload(), newSession: o => runtime.newSession(o),
      switchSession: (p, o) => runtime.switchSession(p, o), fork: (id, o) => runtime.fork(id, o), navigateTree: (id, o) => session.navigateTree(id, o) } });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  t.after(async () => { await runtime.dispose(); modelRuntime.dispose?.(); await rm(root, { recursive: true, force: true }); });
  return { runtime, requests, errors, notices, events, root, original: runtime.session };
}
export const toolAnswer = { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'work-1', name: 'work', arguments: {} }] };

export async function until(predicate) {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for handoff');
    await new Promise(r => setTimeout(r, 5));
  }
}
