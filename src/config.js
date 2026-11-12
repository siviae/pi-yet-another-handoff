import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULTS = Object.freeze({
  autoHandoffAt: false,
  reasoning: 'low',
  maxTokens: 8192,
  timeoutMs: 180000,
});

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Handoff config must be an object');
  const c = { ...DEFAULTS, ...value };
  if (c.autoHandoffAt !== false && !(Number.isFinite(c.autoHandoffAt) && c.autoHandoffAt > 0 && c.autoHandoffAt < 100)) {
    throw new Error('autoHandoffAt must be false or a percentage greater than 0 and less than 100');
  }
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(c.reasoning)) throw new Error('Invalid handoff reasoning level');
  for (const key of ['maxTokens', 'timeoutMs']) {
    if (!Number.isSafeInteger(c[key]) || c[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  return c;
}

function readConfig(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read handoff config ${path}: ${error.message}`);
  }
}

export function loadConfig(ctx, projectDirName = '.pi') {
  const global = readConfig(process.env.PI_HANDOFF_CONFIG || join(homedir(), '.pi', 'handoff.json'));
  // Validate each file so a project override cannot hide a broken global config.
  validateConfig(global);
  const local = ctx.isProjectTrusted() ? readConfig(join(ctx.cwd, projectDirName, 'handoff.json')) : {};
  validateConfig(local);
  return validateConfig({ ...global, ...local });
}

export function shouldAutoHandoff(event, usage, config) {
  return config.autoHandoffAt !== false &&
    Number.isFinite(usage?.percent) && usage.percent >= config.autoHandoffAt &&
    event.outcome === 'completed' &&
    event.message?.role === 'assistant' &&
    ['toolUse', 'length'].includes(event.message.stopReason) &&
    event.message.content.some(c => c.type === 'toolCall') &&
    event.toolResults.length > 0 &&
    !event.toolResults.every(r => r.terminate === true);
}
