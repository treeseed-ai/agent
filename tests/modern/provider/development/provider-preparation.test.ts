import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { developmentRuntimeSchema } from '@treeseed/sdk/development';

const root = resolve('.');
const require = createRequire(import.meta.url);
const script = 'scripts/capacity/providers/build-capacity-provider-container.ts';
const sdkRoot = (() => {
  let path = dirname(require.resolve('@treeseed/sdk/standards'));
  while (!existsSync(join(path, 'package.json'))) path = dirname(path);
  return path;
})();

function fixture(native: boolean) {
  const allocation = mkdtempSync(join(tmpdir(), 'agent-provider-preparation-'));
  const agent = join(allocation, 'agent'), sdk = join(allocation, 'sdk'), modules = join(agent, 'node_modules');
  mkdirSync(join(agent, 'scripts/capacity/providers'), { recursive: true });
  mkdirSync(join(agent, 'scripts/packages'), { recursive: true });
  cpSync(join(root, script), join(agent, script));
  cpSync(join(root, 'scripts/packages/package-tools.ts'), join(agent, 'scripts/packages/package-tools.ts'));
  mkdirSync(join(modules, '@treeseed'), { recursive: true });
  mkdirSync(join(sdk, 'node_modules'), { recursive: true });
  symlinkSync(sdk, join(modules, '@treeseed/sdk'));
  const packageJson = { name: '@treeseed/sdk', version: '1.0.0', dependencies: { 'renamed-runtime-helper': '1.0.0' }, optionalDependencies: { 'absent-platform-helper': '1.0.0' } };
  writeFileSync(join(sdk, 'package.json'), JSON.stringify(packageJson));
  const dependency = join(sdk, 'node_modules/renamed-runtime-helper');
  mkdirSync(dependency);
  writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'renamed-runtime-helper', version: '1.0.0' }));
  writeFileSync(join(dependency, 'input.txt'), 'exact-selected-owner-dependency');
  mkdirSync(join(modules, 'unrelated-dev-tool'));
  writeFileSync(join(modules, 'unrelated-dev-tool/package.json'), JSON.stringify({ name: 'unrelated-dev-tool', version: '1.0.0' }));
  writeFileSync(join(agent, 'package.json'), JSON.stringify({ name: '@treeseed/agent', version: '1.0.0', type: 'module' }));
  writeFileSync(join(agent, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@treeseed/sdk': {}, 'node_modules/unrelated-dev-tool': { dev: true } } }));
  if (native) {
    for (const name of ['src', 'scripts', 'tsconfig.json', 'tsconfig.dist.json', 'package.json', 'package-lock.json']) cpSync(join(root, name), join(agent, name), { recursive: true });
    cpSync(join(sdkRoot, 'package.json'), join(sdk, 'package.json'));
    cpSync(join(sdkRoot, 'dist'), join(sdk, 'dist'), { recursive: true });
    for (const name of readdirSync(join(sdkRoot, 'node_modules'))) {
      symlinkSync(join(sdkRoot, 'node_modules', name), join(sdk, 'node_modules', name));
    }
    for (const name of readdirSync(join(root, 'node_modules'))) {
      if (name === '@treeseed' || name === 'zod-to-json-schema' || name === 'unrelated-dev-tool') continue;
      symlinkSync(join(root, 'node_modules', name), join(modules, name));
    }
    for (const name of readdirSync(join(root, 'node_modules/@treeseed'))) if (name !== 'sdk') symlinkSync(join(root, 'node_modules/@treeseed', name), join(modules, '@treeseed', name));
  }
  return { allocation, agent, sdk, modules, dependency, runtime: join(agent, '.treeseed/docker/runtime/shared'), close: () => rmSync(allocation, { recursive: true, force: true }) };
}

it('copies exact selected SDK production dependencies even when absent from the Agent installed tree without adding unrelated dev packages', async () => {
  const f = fixture(false);
  vi.doMock('../../../../scripts/packages/package-tools.ts', () => ({ packageRoot: f.agent }));
  vi.resetModules();
  try {
    const { runtimePackageNames, copyRuntimePackage } = await import('../../../../scripts/capacity/providers/build-capacity-provider-container.ts');
    const original = readFileSync(join(f.sdk, 'package.json')), bytes = readFileSync(join(f.dependency, 'input.txt'));
    const names = runtimePackageNames(f.modules);
    expect(names).toContain('renamed-runtime-helper'); expect(names).not.toContain('unrelated-dev-tool');
    copyRuntimePackage(f.modules, 'renamed-runtime-helper', f.runtime);
    expect(existsSync(join(f.runtime, 'node_modules/renamed-runtime-helper/input.txt'))).toBe(true);
    expect(readFileSync(join(f.runtime, 'node_modules/renamed-runtime-helper/input.txt'))).toEqual(bytes);
    expect(readFileSync(join(f.sdk, 'package.json'))).toEqual(original);
    expect(readFileSync(join(f.dependency, 'input.txt'))).toEqual(bytes);
  } finally { vi.doUnmock('../../../../scripts/packages/package-tools.ts'); vi.resetModules(); f.close(); }
});

it('fails closed for an absent required selected SDK dependency while permitting an uninstalled optional platform dependency', async () => {
  const f = fixture(false);
  vi.doMock('../../../../scripts/packages/package-tools.ts', () => ({ packageRoot: f.agent }));
  vi.resetModules();
  try {
    const { copyRuntimePackage } = await import('../../../../scripts/capacity/providers/build-capacity-provider-container.ts');
    const original = readFileSync(join(f.sdk, 'package.json'));
    rmSync(f.dependency, { recursive: true });
    expect(() => copyRuntimePackage(f.modules, 'renamed-runtime-helper', f.runtime)).toThrow(/Missing required runtime dependency/u);
    expect(() => copyRuntimePackage(f.modules, 'absent-platform-helper', f.runtime)).not.toThrow();
    expect(existsSync(f.runtime)).toBe(false); expect(readFileSync(join(f.sdk, 'package.json'))).toEqual(original);
  } finally { vi.doUnmock('../../../../scripts/packages/package-tools.ts'); vi.resetModules(); f.close(); }
});

it('original native provider preparation runs its compiled health entrypoint with the selected SDK dependency closure without borrowing parent packages', () => {
  const f = fixture(true);
  const manifest = parse(readFileSync(join(root, 'treeseed.package.yaml'), 'utf8')) as { development: unknown };
  const operation = developmentRuntimeSchema.parse(manifest.development).targets.find(target => target.id === 'provider')!.operations.build!;
  const nativeBound = operation.timeoutSeconds * 1000;
  try {
    const sdkBytes = readFileSync(join(f.sdk, 'package.json')), lockBytes = readFileSync(join(f.agent, 'package-lock.json'));
    const built = spawnSync(operation.command, operation.args, { cwd: f.agent, env: process.env, encoding: 'utf8', timeout: nativeBound, maxBuffer: 16_777_216 });
    expect(built.error).toBeUndefined(); expect(built.signal).toBe(null); expect(built.status, built.stderr).toBe(0);
    cpSync(join(f.agent, 'dist'), join(f.runtime, 'dist'), { recursive: true });
    const dependency = join(f.runtime, 'node_modules/zod-to-json-schema/package.json');
    expect(existsSync(dependency), 'Current SDK required production package omitted').toBe(true);
    expect(readFileSync(dependency)).toEqual(readFileSync(join(f.sdk, 'node_modules/zod-to-json-schema/package.json')));
    const environment: NodeJS.ProcessEnv = { ...process.env, TREESEED_PROVIDER_DATA_DIR: join(f.allocation, 'data') };
    delete environment.TREESEED_CAPACITY_PROVIDER_MANIFEST;
    const health = spawnSync(process.execPath, ['./dist/provider/lifecycle/entrypoint.js', 'healthcheck', '--json'], { cwd: f.runtime, env: environment, encoding: 'utf8', timeout: 10_000 });
    expect(health.error).toBeUndefined(); expect(health.signal).toBe(null);
    expect(health.status, health.stderr).toBe(0);
    expect(JSON.parse(health.stdout)).toMatchObject({ ok: true, role: 'healthcheck', manifestConfigured: false, broker: { required: false, ready: true } });
    expect(readFileSync(join(f.sdk, 'package.json'))).toEqual(sdkBytes); expect(readFileSync(join(f.agent, 'package-lock.json'))).toEqual(lockBytes);
    expect(existsSync(join(f.modules, 'zod-to-json-schema'))).toBe(false);
    expect(existsSync(join(f.runtime, 'node_modules/unrelated-dev-tool'))).toBe(false);
    // Actual original script, strict compiler, native cp and Node SDK/provider
    // imports. No broker/model/registration/usage or managed golden proof.
  } finally { f.close(); }
}, developmentRuntimeSchema.parse((parse(readFileSync(join(root, 'treeseed.package.yaml'), 'utf8')) as { development: unknown }).development).targets.find(target => target.id === 'provider')!.operations.build!.timeoutSeconds * 1000);
