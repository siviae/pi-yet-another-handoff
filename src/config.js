import { readFileSync } from 'node:fs';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { dirname, join, resolve } from 'node:path';

export const DEFAULTS = Object.freeze({
  templateFile: null,
  reasoning: 'low',
  maxTokens: 8192,
  timeoutMs: 600000,
});

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Handoff config must be an object');
  const c = { ...DEFAULTS, ...value };
  if (c.templateFile !== null && (typeof c.templateFile !== 'string' || !c.templateFile.trim())) {
    throw new Error('templateFile must be null or a non-empty file path');
  }
  // Ignore the removed setting in existing configuration files.
  delete c.autoHandoffAt;
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(c.reasoning)) throw new Error('Invalid handoff reasoning level');
  for (const key of ['maxTokens', 'timeoutMs']) {
    if (!Number.isSafeInteger(c[key]) || c[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  return c;
}

function readConfig(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    validateConfig(value);
    if (typeof value.templateFile === 'string') value.templateFile = resolve(dirname(path), value.templateFile);
    return value;
  }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read handoff config ${path}: ${error.message}`);
  }
}

export function loadConfig(ctx, projectDirName = '.pi') {
  const global = readConfig(process.env.PI_HANDOFF_CONFIG || join(getAgentDir(), 'handoff.json'));
  // Validate each file so a project override cannot hide a broken global config.
  validateConfig(global);
  const local = ctx.isProjectTrusted() ? readConfig(join(ctx.cwd, projectDirName, 'handoff.json')) : {};
  validateConfig(local);
  return validateConfig({ ...global, ...local });
}
