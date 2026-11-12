import { BorderedLoader, CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
import { loadConfig, shouldAutoHandoff } from './config.js';
import { generateDocument, saveDocument, wrapHandoffContext } from './handoff.js';

const AUTO_COMMAND = 'yet-another-handoff-auto';
const METRICS = 'pi-yet-another-handoff.metrics';
const KICKOFF = 'Continue the unfinished work from the handoff context now. Follow the recorded constraints and next steps. Do not ask for confirmation of this handoff. If the task is complete or blocked on user input, report that and stop.';

// Injection points are for offline tests; the installed entrypoint uses the real host API.
export function createHandoffExtension({ readConfig = ctx => loadConfig(ctx, CONFIG_DIR_NAME), generate = generateDocument, save = saveDocument } = {}) {
  return function handoffExtension(pi) {
    let config, pending, running = false, disposed = false, autoFailed = false, ongoing = false, controller;
    const terminatingCalls = new Set();
    pi.on('turn_start', () => { terminatingCalls.clear(); });
    pi.on('tool_execution_end', event => {
      // terminate is execution metadata, not persisted in ToolResultMessage.
      if (!event.parentToolCallId && event.result.terminate === true) terminatingCalls.add(event.toolCallId);
    });
    const notify = (ctx, text, level = 'info') => {
      if (disposed) return;
      if (ctx.hasUI) ctx.ui.notify(text, level);
      else if (level === 'error') console.error(text);
    };
    function configure(ctx) {
      try { config = readConfig(ctx); return true; }
      catch (error) { config = undefined; notify(ctx, error.message, 'error'); return false; }
    }
    pi.on('session_start', (_event, ctx) => { configure(ctx); });
    pi.on('session_shutdown', () => {
      disposed = true;
      pending = undefined;
      controller?.abort(new Error('Session closed during handoff'));
    });

    async function handoff(goal, ctx, automatic = false) {
      if (running || disposed) return;
      if (!configure(ctx)) return;
      running = true;
      controller = new AbortController();
      const sessionId = ctx.sessionManager.getSessionId();
      const parentSession = ctx.sessionManager.getSessionFile();
      let timer;
      try {
        await ctx.waitForIdle();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (ctx.hasPendingMessages()) throw new Error('Pending messages exist; handoff deferred to avoid losing them');
        const leafId = ctx.sessionManager.getLeafId();
        const started = performance.now();
        let progress = { phase: 'waiting', chars: 0 };
        const renderProgress = () => {
          if (!disposed && ctx.hasUI) ctx.ui.setStatus('handoff', `Handoff: ${Math.round((performance.now() - started) / 1000)}s, ${progress.phase}, ${progress.chars} chars`);
        };
        renderProgress();
        timer = setInterval(renderProgress, 1000);
        const run = async extraSignal => {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs), ...(extraSignal ? [extraSignal] : [])]);
          signal.throwIfAborted();
          let onAbort;
          const cancelled = new Promise((_resolve, reject) => {
            onAbort = () => reject(signal.reason || new Error('Handoff cancelled'));
            signal.addEventListener('abort', onAbort, { once: true });
          });
          try {
            return await Promise.race([generate(ctx, goal, config, signal, update => { progress = update; }), cancelled]);
          } finally { signal.removeEventListener('abort', onAbort); }
        };
        let result;
        if (ctx.mode === 'tui') {
          // No editor/confirmation. Escape only cancels the operation.
          const outcome = await ctx.ui.custom((tui, theme, _kb, done) => {
            const loader = new BorderedLoader(tui, theme, 'Generating handoff (Escape to cancel)...');
            run(loader.signal).then(value => done({ value }), error => done({ error }));
            return loader;
          });
          if (!outcome) throw new Error('Handoff cancelled');
          if (outcome.error) throw outcome.error;
          result = outcome.value;
        } else {
          result = await run();
        }
        const { document, metrics } = result;
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!document?.trim()) throw new Error('Empty handoff document');
        if (sessionId !== ctx.sessionManager.getSessionId() || leafId !== ctx.sessionManager.getLeafId() || !ctx.isIdle() || ctx.hasPendingMessages()) {
          throw new Error('Session changed during handoff; original session retained');
        }
        const path = save(parentSession, document);
        const record = { ...metrics, automatic, path, parentSession };
        pi.appendEntry(METRICS, record);
        clearInterval(timer);
        if (ctx.hasUI) ctx.ui.setStatus('handoff', undefined);
        const switched = await ctx.newSession({
          parentSession,
          setup: async sm => {
            sm.appendCustomMessageEntry('handoff', wrapHandoffContext(document), true);
            sm.appendCustomEntry(METRICS, record);
            if (metrics.usage) sm.appendUsage('handoff', metrics.provider, metrics.model, metrics.usage, 'Handoff generation from parent session');
          },
          withSession: async replacement => {
            if (replacement.hasUI) replacement.ui.notify(`Handoff ready in ${(metrics.elapsedMs / 1000).toFixed(1)}s${path ? `; saved: ${path}` : ''}. Continuing.`, 'info');
            // Never use captured old pi/ctx after runtime replacement.
            await replacement.sendUserMessage(goal ? `${KICKOFF}\n\nAdditional focus: ${goal}` : KICKOFF);
          },
        });
        if (switched.cancelled) throw new Error(`New session cancelled; handoff retained${path ? ` at ${path}` : ''}`);
      } catch (error) {
        if (automatic) autoFailed = true;
        const message = `Handoff stopped: ${error.message || String(error)}${automatic ? '. Auto handoff paused until /reload or a new session; use /handoff to retry.' : ''}`;
        if (disposed) console.error(message); // Replacement failures cannot use the stale UI context.
        else notify(ctx, message, 'error');
      } finally {
        clearInterval(timer);
        if (!disposed && ctx.hasUI) ctx.ui.setStatus('handoff', undefined);
        running = false;
        controller = undefined;
      }
    }

    pi.registerCommand('handoff', {
      description: 'Generate handoff, open a new session and continue immediately (no confirmation)',
      handler: async (args, ctx) => { pending = undefined; await handoff(args.trim() || undefined, ctx); },
    });
    pi.registerCommand('handoff-status', {
      description: 'Show handoff settings, context usage and latest generation timings/token usage',
      handler: async (_args, ctx) => {
        configure(ctx);
        const latest = ctx.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === METRICS)?.data;
        const text = JSON.stringify({ autoHandoffAt: config?.autoHandoffAt, reasoning: config?.reasoning,
          maxTokens: config?.maxTokens, timeoutMs: config?.timeoutMs, autoPaused: autoFailed,
          context: ctx.getContextUsage(), latest }, null, 2);
        if (ctx.hasUI) ctx.ui.notify(text, 'info');
        else console.log(text);
      },
    });
    pi.registerCommand(AUTO_COMMAND, {
      description: 'Internal automatic handoff continuation',
      handler: async (_args, ctx) => {
        const request = pending;
        pending = undefined;
        if (!request || request.sessionId !== ctx.sessionManager.getSessionId()) return;
        await handoff(undefined, ctx, true);
      },
    });
    pi.on('session_before_compact', (event, ctx) => {
      // Pi's token reserve can compact before our percentage is reached (e.g.
      // at 87% of a 128K window). While tools are making progress, auto handoff
      // replaces threshold compaction, but never manual/overflow recovery.
      if (event.reason === 'threshold' && ongoing && config && config.autoHandoffAt !== false && !autoFailed && Number.isFinite(ctx.getContextUsage()?.percent)) {
        return { cancel: true };
      }
    });
    pi.on('turn_end', (event, ctx) => {
      const boundary = { ...event, toolResults: event.toolResults.map(r => ({ ...r, terminate: terminatingCalls.has(r.toolCallId) })) };
      ongoing = event.outcome === 'completed' && event.message?.content?.some(c => c.type === 'toolCall') &&
        boundary.toolResults.length > 0 && !boundary.toolResults.every(r => r.terminate === true);
      if (!config || running || pending || disposed || autoFailed || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
      if (!shouldAutoHandoff(boundary, ctx.getContextUsage(), config)) return;
      pending = { sessionId: ctx.sessionManager.getSessionId() };
      // Abort only AFTER the complete tool batch is persisted. This prevents the
      // next provider request/threshold compaction. Do not await abort from a hook.
      ctx.abort();
    });
    pi.on('agent_settled', (_event, ctx) => {
      ongoing = false;
      if (!pending || disposed) return;
      if (ctx.hasPendingMessages()) { pending = undefined; return; }
      // Commands have newSession; event contexts intentionally do not. The host
      // defers this dispatch until all settled handlers have finished.
      pi.sendUserMessage(`/${AUTO_COMMAND}`, { expandPromptTemplates: true });
    });
  };
}

export default createHandoffExtension();
