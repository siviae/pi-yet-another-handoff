import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertToLlm } from '@earendil-works/pi-coding-agent';

const template = readFileSync(new URL('../handoff-document.md', import.meta.url), 'utf8');

export function renderHandoffPrompt(goal, templateFile = null) {
  let source = template;
  if (templateFile !== null) {
    try { source = readFileSync(templateFile, 'utf8'); }
    catch (error) { throw new Error(`Cannot read handoff template ${templateFile}: ${error.message}`); }
    if (!source.trim()) throw new Error(`Handoff template is empty: ${templateFile}`);
  }
  return source
    .replace(/{{#if additionalFocus}}([\s\S]*?){{\/if}}/g, (_, block) => goal ? block : '')
    .replace(/{{additionalFocus}}/g, () => goal || '');
}

export function wrapHandoffContext(document) {
  return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

export function saveDocument(sessionFile, document) {
  if (!sessionFile?.endsWith('.jsonl')) return undefined;
  const dir = sessionFile.slice(0, -6);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `handoff-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(path, document + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return path;
}

export function requestContext(ctx, goal, templateFile = null) {
  // Unlike the upstream branch walker, projection includes custom handoff messages,
  // tree summaries and context edits, and applies the latest compaction.
  const messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
  if (!messages.some(m => m.role !== 'system')) throw new Error('No conversation to hand off');
  return {
    // Modern Pi stores system messages in the transcript. Prepending the replayed
    // prompt again would duplicate it and invalidate the shared cached prefix.
    systemPrompt: messages[0]?.role === 'system' ? undefined : (ctx.getSystemPrompt() || undefined),
    messages: [...messages, { role: 'user', content: [{ type: 'text', text: renderHandoffPrompt(goal, templateFile) }], timestamp: Date.now() }],
  };
}

export async function generateDocument(ctx, goal, config, signal, progress = () => {}) {
  if (!ctx.model) throw new Error('No model selected');
  const context = requestContext(ctx, goal, config.templateFile);
  const usage = ctx.getContextUsage();
  // Leave room for the added template and provider framing on small windows.
  const overhead = Math.ceil(JSON.stringify(context.messages.at(-1)).length / 3) + 512;
  const available = usage?.tokens != null ? usage.contextWindow - usage.tokens - overhead : ctx.model.maxTokens;
  const maxTokens = Math.floor(Math.min(config.maxTokens, ctx.model.maxTokens, available));
  if (maxTokens <= 0) throw new Error('Not enough context headroom to generate a handoff; compact or run /handoff earlier');
  const started = performance.now();
  let firstEventMs, firstTextMs, chars = 0;
  const stream = ctx.modelRegistry.streamSimple(ctx.model, context, {
    signal,
    reasoning: config.reasoning,
    maxTokens,
    cacheRetention: 'short',
    sessionId: ctx.sessionManager.getSessionId(),
  });
  for await (const event of stream) {
    firstEventMs ??= Math.round(performance.now() - started);
    if (event.type === 'text_delta') {
      firstTextMs ??= Math.round(performance.now() - started);
      chars += event.delta.length;
    }
    progress({ elapsedMs: Math.round(performance.now() - started), firstEventMs, firstTextMs, chars, phase: event.type });
  }
  const response = await stream.result();
  signal?.throwIfAborted();
  if (response.stopReason !== 'stop') {
    throw new Error(response.errorMessage || `Handoff generation stopped: ${response.stopReason}. Original session retained; increase maxTokens if truncated.`);
  }
  const document = response.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  if (!document) throw new Error('Model returned an empty handoff');
  return {
    document,
    metrics: { elapsedMs: Math.round(performance.now() - started), firstEventMs, firstTextMs, chars,
      provider: response.provider, model: response.model, usage: response.usage },
  };
}
