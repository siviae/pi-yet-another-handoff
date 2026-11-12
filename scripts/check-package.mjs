import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// All CLI invocations use isolated settings/auth locations; no model requests.
const root = await mkdtemp(join(tmpdir(), 'handoff-package-'));
const run = (cmd, args, cwd, extra = {}) => execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120000,
  env: { ...process.env, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_HANDOFF_CONFIG: join(root, 'handoff.json'), PI_OFFLINE: '1', ...extra } });
try {
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', root], resolve('.')));
  assert.deepEqual(pack.files.map(f => f.path).sort(), ['LICENSE', 'README.md', 'handoff-document.md', 'package.json', 'src/config.js', 'src/extension.js', 'src/handoff.js'].sort());
  const tar = join(root, pack.filename);
  console.log(JSON.stringify({ artifact: pack.filename, sha256: createHash('sha256').update(await readFile(tar)).digest('hex') }));
  run('tar', ['-xzf', tar, '-C', root], root);
  const pkg = join(root, 'package'), project = join(root, 'project');
  for (const f of pack.files) assert.doesNotMatch(await readFile(join(pkg, f.path), 'utf8'), /\p{Script=Han}/u, `${f.path}: Chinese characters`);
  await mkdir(project); await mkdir(join(root, 'agent'));
  await writeFile(join(root, 'agent/settings.json'), JSON.stringify({ cacheWarming: 'off', enableInstallTelemetry: false, enableAnalytics: false }));
  await writeFile(join(root, 'handoff.json'), JSON.stringify({ autoHandoffAt: 90 }));
  run('npm', ['install', '--omit=dev', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], pkg);
  await assert.rejects(lstat(join(pkg, 'node_modules/@earendil-works/pi-coding-agent')), { code: 'ENOENT' });
  const probe = join(root, 'probe.js');
  await writeFile(probe, `import assert from 'node:assert/strict'; import { writeFileSync } from 'node:fs';
export default pi => { pi.registerCommand('package-check', {description:'Offline package probe', handler: async () => {
const names=pi.getCommands().map(c=>c.name).filter(n=>n==='handoff'||n==='handoff-status'||n==='yet-another-handoff-auto').sort();
assert.deepEqual(names,process.env.EXPECT_DISABLED?[]:['handoff','handoff-status','yet-another-handoff-auto']);
writeFileSync(process.env.PROBE_MARKER, JSON.stringify(names));
}}); };`);
  console.log(run('pi', ['install', '--local', '--approve', pkg], project));
  const invoke = async extra => {
    const marker = join(root, 'result.json');
    await rm(marker, { force: true });
    const output = run('pi', ['--offline', '--approve', '--no-mcp', '--no-skills', '--no-context-files', '-e', probe,
      '--model', 'openai/gpt-5.4-mini', '--no-session', '--print', '/package-check'], project, { ...extra, PROBE_MARKER: marker });
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).length, extra.EXPECT_DISABLED ? 0 : 3);
    assert.doesNotMatch(output, /Failed to load|duplicate command/i);
  };
  await invoke({});
  const settingsPath = join(project, '.pi/settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.packages.length, 1);
  settings.packages = [{ source: pkg, extensions: [] }];
  await writeFile(settingsPath, JSON.stringify(settings));
  await invoke({ EXPECT_DISABLED: '1' });
  console.log(run('pi', ['remove', '--local', '--approve', pkg], project));
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).packages.length, 0);
  console.log('Clean unpacked package: load, commands, disable, remove and no Chinese characters PASS (no LLM).');
} finally { await rm(root, { recursive: true, force: true }); }
