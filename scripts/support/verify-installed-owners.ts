import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { parse } from 'yaml';

// Artifact inspection through the existing Reviewer command; no scene or campaign.
type Input = { owner: string; commit: string; sha256: string | null; buildSdk?: { commit: string; sha256: string } };
const inputs = JSON.parse(process.env.TREESEED_INSTALLED_OWNER_INPUTS ?? 'null') as Input[];
assert.equal(process.version, 'v24.12.0');
assert.ok(Array.isArray(inputs) && inputs.length === 6);
assert.equal(new Set(inputs.map(input => input.owner)).size, 6);
for (const input of inputs) {
 assert.match(input.owner, /^[a-z][a-z-]*$/u); assert.match(input.commit, /^[a-f0-9]{40}$/u);
 assert.ok(input.sha256 === null || /^[a-f0-9]{64}$/u.test(input.sha256));
 assert.equal(input.sha256 === null, input.owner === 'agent');
 if (input.owner === 'agent') assert.equal(input.commit, process.env.GITHUB_SHA);
 if (Object.hasOwn(input, 'buildSdk')) {
  assert.ok(input.buildSdk && !Array.isArray(input.buildSdk));
  assert.match(input.buildSdk.commit, /^[a-f0-9]{40}$/u); assert.match(input.buildSdk.sha256, /^[a-f0-9]{64}$/u);
 }
}
const output = resolve('artifacts/installed-owner-custody'), temporary = mkdtempSync(resolve(tmpdir(), 'installed-owner-custody-'));
const workspace = resolve(temporary, 'workspace'), prefix = resolve(temporary, 'installed'), installed = resolve(prefix, 'node_modules');
mkdirSync(output, { recursive: true }); mkdirSync(workspace); mkdirSync(prefix);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const observations: Array<{ owner: string; commit: string; tree: string; archiveSha256: string; filename: string }> = [];
function run(name: string, command: string[], cwd = temporary, expected = 0, timeout?: number, env = process.env): string {
 writeFileSync(resolve(output, `${name}-command.json`), JSON.stringify(command) + '\n');
 const result = spawnSync(command[0]!, command.slice(1), { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout });
 writeFileSync(resolve(output, `${name}.stdout`), result.stdout ?? ''); writeFileSync(resolve(output, `${name}.stderr`), result.stderr ?? '');
 assert.equal(result.error, undefined, name); assert.equal(result.signal, null, name); assert.equal(result.status, expected, name);
 return result.stdout;
}
try {
 for (const input of inputs) {
  const source = resolve(workspace, 'packages', input.owner); mkdirSync(source, { recursive: true });
  run(`${input.owner}-init`, ['git', 'init', '--quiet'], source);
  run(`${input.owner}-fetch`, ['git', 'fetch', '--depth=1', `https://github.com/treeseed-ai/${input.owner}.git`, input.commit], source);
  run(`${input.owner}-checkout`, ['git', 'checkout', '--detach', 'FETCH_HEAD'], source);
  assert.equal(run(`${input.owner}-head`, ['git', 'rev-parse', 'HEAD'], source).trim(), input.commit);
  const directory = resolve('.treeseed/installed-owner-inputs', input.owner);
  const archives = readdirSync(directory).filter(path => path.endsWith('.tgz')); assert.equal(archives.length, 1);
  const archive = resolve(directory, archives[0]!); assert.equal(lstatSync(archive).isSymbolicLink(), false);
  const bytes = readFileSync(archive), sha256 = digest(bytes); if (input.sha256 !== null) assert.equal(sha256, input.sha256);
  const records = JSON.parse(run(`${input.owner}-archive`, ['npm', 'pack', '--dry-run', '--ignore-scripts', '--json', archive], source));
  assert.equal(records.length, 1); const record = records[0]; assert.equal(record.name, `@treeseed/${input.owner}`);
  assert.equal(basename(record.filename), record.filename); assert.match(record.filename, /^[a-zA-Z0-9_.-]+\.tgz$/u);
  assert.equal(record.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  copyFileSync(archive, resolve(prefix, record.filename)); copyFileSync(archive, resolve(output, record.filename));
  const tree = run(`${input.owner}-tree`, ['git', 'rev-parse', 'HEAD^{tree}'], source).trim();
  observations.push({ owner: input.owner, commit: input.commit, tree, archiveSha256: sha256, filename: record.filename });
 }
 const sdk = observations.find(input => input.owner === 'sdk'); assert.ok(sdk);
 for (const input of observations) {
  const source = resolve(workspace, 'packages', input.owner);
  run(`${input.owner}-dependencies`, ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], source);
  const original = inputs.find(value => value.owner === input.owner)!.buildSdk;
  if (original) {
   const workflow = parse(readFileSync(resolve(source, '.github/workflows/verify.yml'), 'utf8'));
   assert.ok(workflow.jobs.verify.steps.some((step: { uses?: string; env?: Record<string, string> }) =>
    step.uses === `treeseed-ai/sdk/.github/actions/install-exact-sdk@${original.commit}` && step.env?.NODE_ENV === 'production'));
   const directory = resolve('.treeseed/installed-owner-inputs', `build-sdk-${original.commit}`);
   const archives = readdirSync(directory).filter(path => path.endsWith('.tgz')); assert.equal(archives.length, 1);
   const archive = resolve(directory, archives[0]!); assert.equal(lstatSync(archive).isSymbolicLink(), false);
   assert.equal(digest(readFileSync(archive)), original.sha256);
   const metadata = JSON.parse(run(`${input.owner}-build-sdk-archive`, ['npm', 'pack', '--dry-run', '--ignore-scripts', '--json', archive], source));
   assert.equal(metadata.length, 1); assert.equal(metadata[0].name, '@treeseed/sdk');
   const retained = resolve(output, 'dependency-inputs', original.commit); mkdirSync(retained, { recursive: true });
   copyFileSync(archive, resolve(retained, basename(archive)));
   writeFileSync(resolve(output, `${input.owner}-build-sdk.json`), JSON.stringify(original) + '\n');
   const target = resolve(source, 'node_modules/@treeseed/sdk');
   assert.ok(target.startsWith(temporary + '/')); rmSync(target, { recursive: true, force: true }); mkdirSync(target);
   run(`${input.owner}-build-sdk-extract`, ['tar', '-xzf', archive, '--strip-components=1', '-C', target], source);
   run(`${input.owner}-exact-sdk`, ['npm', 'install', '--prefix', target, '--ignore-scripts', '--no-save', '--package-lock=false',
    '--no-audit', '--no-fund'], source, 0, undefined, { ...process.env, NODE_ENV: 'production' });
  } else if (input.owner !== 'sdk') run(`${input.owner}-exact-sdk`, ['npm', 'install', '--no-save', '--package-lock=false',
    '--ignore-scripts', '--no-audit', '--no-fund', resolve(prefix, sdk.filename)], source);
  run(`${input.owner}-build`, ['npm', 'run', 'build'], source);
  assert.equal(run(`${input.owner}-clean`, ['git', 'status', '--porcelain'], source), '');
  const snapshots = resolve(output, 'native-source', input.owner); mkdirSync(snapshots, { recursive: true });
  const packed = JSON.parse(run(`${input.owner}-native-source-pack`, ['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', snapshots], source));
  assert.equal(packed.length, 1); assert.equal(packed[0].name, `@treeseed/${input.owner}`);
  assert.equal(packed[0].filename, input.filename);
  const snapshot = readFileSync(resolve(snapshots, input.filename));
  assert.equal(packed[0].integrity, `sha512-${createHash('sha512').update(snapshot).digest('base64')}`);
 }
 const dependencies = Object.fromEntries(observations.map(input => [`@treeseed/${input.owner}`, `file:${resolve(prefix, input.filename)}`]));
 writeFileSync(resolve(prefix, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies,
  overrides: Object.fromEntries(Object.keys(dependencies).map(name => [name, `$${name}`])) }));
 run('production-install', ['npm', 'install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--package-lock=false', '--no-save',
  '--no-audit', '--no-fund', '--install-strategy=nested', ...observations.map(input => resolve(prefix, input.filename))], prefix);
 run('production-dependencies', ['npm', 'ls', '--all', '--omit=dev', '--json'], prefix);
 const binary = resolve(installed, '.bin/treeseed-reviewer-guarantees');
 const selection = ['--workspace', workspace, '--ids', 'guarantee.agent.golden.sdk-complete', '--plan', '--installed-packages', installed];
 const plan = JSON.parse(run('installed-custody-plan', [process.execPath, binary, ...selection], prefix));
 assert.equal(plan.ok, true); assert.deepEqual(plan.diagnostics, []); assert.equal(plan.acceptanceSelection, undefined);
 assert.equal(plan.entries.length, 1); const refs = plan.entries[0].sceneVerifierRefs as string[];
 assert.equal(refs.length, 22); assert.equal(new Set(refs).size, 22);
 const runner = resolve(installed, '@treeseed/reviewer/dist/verifiers/guarantees/node-case.js'), unmatched = `installed-collection-${randomUUID()}`;
 for (const [index, ref] of refs.entries()) {
  const binding = plan.verifiers[ref]; assert.equal(binding.definition.kind, 'nodeTestCase');
  assert.notEqual(binding.definition.testName, unmatched);
  const name = JSON.parse(readFileSync(resolve(binding.root, 'package.json'), 'utf8')).name;
  const owner = resolve(installed, name), file = resolve(owner, binding.definition.testFile); assert.equal(realpathSync(file), file);
  const report = JSON.parse(run(`installed-import-${index}`, [process.execPath, runner, file, unmatched, installed], owner, 1, 5_000));
  assert.equal(report.success, false); assert.equal(report.numPassedTests, 0); assert.equal(report.numFailedTests, 0);
  assert.deepEqual(report.testResults, [{ assertionResults: [] }]);
 }
 for (const input of observations) assert.equal(digest(readFileSync(resolve(prefix, input.filename))), input.archiveSha256);
 writeFileSync(resolve(output, 'custody.json'), JSON.stringify({ owners: observations, selectedAssetLoads: refs.length,
  sourceArchiveInstalledCustody: true, managedAssertions: 0, managedPass: false, specificationPass: false }, null, 2) + '\n');
 console.log('Six native source candidates and production archives passed installed custody; all22selected assets load. No managed acceptance.');
} catch (error) {
 writeFileSync(resolve(output, 'failed-observation.txt'), String(error instanceof Error ? error.stack : error)); throw error;
} finally {
 rmSync(temporary, { recursive: true, force: true }); assert.equal(existsSync(temporary), false);
 writeFileSync(resolve(output, 'cleanup.json'), JSON.stringify({ temporaryWorkspaceRemoved: true, existingServicesUnchanged: true }) + '\n');
}
