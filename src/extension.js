import { CONFIG_DIR_NAME, DynamicBorder } from '@earendil-works/pi-coding-agent';
import { CancellableLoader, Container } from '@earendil-works/pi-tui';
import { loadConfig } from './config.js';
import { generateDocument, saveDocument, wrapHandoffContext } from './handoff.js';

const METRICS = 'pi-yet-another-handoff.metrics';
const KICKOFF = 'Continue the unfinished work from the handoff context now. Follow the recorded constraints and next steps. Do not ask for confirmation of this handoff. If the task is complete or blocked on user input, report that and stop.';

// Injection points are for offline tests; the installed entrypoint uses the real host API.
export function createHandoffExtension({ readConfig = ctx => loadConfig(ctx, CONFIG_DIR_NAME), generate = generateDocument, save = saveDocument } = {}) {
  return function handoffExtension(pi) {
    let config, running = false, disposed = false, controller;
    const notify = (ctx, text, level = 'info') => {
      if (disposed) return;
      if (ctx.hasUI) ctx.ui.notify(text, level);
      else if (level === 'error') console.error(text);
    };
    function configure(ctx) {
      try { config = readConfig(ctx); return true; }
      catch (error) { config = undefined; notify(ctx, error.message, 'error'); return false; }
    }
    pi.on('session_start', async (event, ctx) => {
      configure(ctx);
      if (event.reason !== 'new') return;
      const branch = ctx.sessionManager.getBranch();
      if (!branch.some(entry => entry.type === 'custom_message' && entry.customType === 'handoff')) return;
      // setup runs after runtime creation: history alone does not update the
      // live agent. Restore through the fresh extension API before kickoff.
      const selection = branch.findLast(entry => entry.type === 'model_change');
      const thinking = branch.findLast(entry => entry.type === 'thinking_level_change');
      if (selection) {
        const model = ctx.modelRegistry.find(selection.provider, selection.modelId);
        if (!model || !await pi.setModel(model)) throw new Error('Cannot restore handoff model');
      }
      if (thinking) pi.setThinkingLevel(thinking.thinkingLevel);
    });
    pi.on('session_shutdown', () => {
      disposed = true;
      controller?.abort(new Error('Session closed during handoff'));
    });

    async function handoff(goal, ctx) {
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
        let renderProgress = () => {};
        const progressMessage = () => `Generating handoff: ${Math.round((performance.now() - started) / 1000)}s, ${progress.phase}, ${progress.chars} chars (Escape to cancel)`;
        const run = async extraSignal => {
          const timeout = new AbortController();
          const signal = AbortSignal.any([controller.signal, timeout.signal, ...(extraSignal ? [extraSignal] : [])]);
          signal.throwIfAborted();
          const deadline = setTimeout(() => timeout.abort(new Error('Handoff generation timed out')), config.timeoutMs);
          let onAbort;
          const cancelled = new Promise((_resolve, reject) => {
            onAbort = () => reject(signal.reason || new Error('Handoff cancelled'));
            signal.addEventListener('abort', onAbort, { once: true });
          });
          try {
            return await Promise.race([generate(ctx, goal, config, signal, update => { progress = update; renderProgress(); }), cancelled]);
          } finally {
            clearTimeout(deadline);
            signal.removeEventListener('abort', onAbort);
          }
        };
        let result;
        if (ctx.mode === 'tui') {
          // No editor/confirmation. Escape only cancels the operation.
          const outcome = await ctx.ui.custom((tui, theme, _kb, done) => {
            const loader = new CancellableLoader(tui, s => theme.fg('accent', s), s => theme.fg('muted', s), progressMessage());
            const panel = new Container();
            panel.addChild(new DynamicBorder(s => theme.fg('border', s)));
            panel.addChild(loader);
            panel.addChild(new DynamicBorder(s => theme.fg('border', s)));
            renderProgress = () => { if (!disposed) loader.setMessage(progressMessage()); };
            timer = setInterval(renderProgress, 1000);
            run(loader.signal).then(value => done({ value }), error => done({ error }));
            return {
              render: width => panel.render(width),
              invalidate: () => panel.invalidate(),
              handleInput: data => loader.handleInput(data),
              dispose: () => {
                clearInterval(timer);
                renderProgress = () => {};
                loader.dispose();
              },
            };
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
        // Capture live session settings, not the defaults or summary-generation
        // reasoning. Only plain data may cross runtime replacement.
        const modelSelection = ctx.model && { provider: ctx.model.provider, id: ctx.model.id };
        const thinkingLevel = ctx.thinkingLevel;
        const path = save(parentSession, document);
        const record = { ...metrics, path, parentSession };
        pi.appendEntry(METRICS, record);
        clearInterval(timer);
        const switched = await ctx.newSession({
          parentSession,
          setup: async sm => {
            if (modelSelection) sm.appendModelChange(modelSelection.provider, modelSelection.id);
            sm.appendThinkingLevelChange(thinkingLevel);
            sm.appendCustomMessageEntry('handoff', wrapHandoffContext(document), true);
            sm.appendCustomEntry(METRICS, record);
            if (metrics.usage) sm.appendUsage('handoff', metrics.provider, metrics.model, metrics.usage, 'Handoff generation from parent session');
          },
          withSession: async replacement => {
            // Event-handler errors are reported by Pi rather than propagated.
            // Never start work with defaults if restoration failed.
            if ((modelSelection && (replacement.model?.provider !== modelSelection.provider || replacement.model?.id !== modelSelection.id)) || replacement.thinkingLevel !== thinkingLevel) {
              throw new Error('Handoff model settings were not restored; continuation stopped');
            }
            if (replacement.hasUI) replacement.ui.notify(`Handoff ready in ${(metrics.elapsedMs / 1000).toFixed(1)}s${path ? `; saved: ${path}` : ''}. Continuing.`, 'info');
            // Never use captured old pi/ctx after runtime replacement.
            await replacement.sendUserMessage(goal ? `${KICKOFF}\n\nAdditional focus: ${goal}` : KICKOFF);
          },
        });
        if (switched.cancelled) throw new Error(`New session cancelled; handoff retained${path ? ` at ${path}` : ''}`);
      } catch (error) {
        const message = `Handoff stopped: ${error.message || String(error)}`;
        if (disposed) console.error(message); // Replacement failures cannot use the stale UI context.
        else notify(ctx, message, 'error');
      } finally {
        clearInterval(timer);
        running = false;
        controller = undefined;
      }
    }

    pi.registerCommand('handoff', {
      description: 'Generate handoff, open a new session and continue immediately (no confirmation)',
      handler: async (args, ctx) => { await handoff(args.trim() || undefined, ctx); },
    });
  };
}

export default createHandoffExtension();
