import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { componentReleaseSchema, deploymentDigest } from '@treeseed/sdk/deployment';

it('publishes a digest of the emitted schema-normalized component runtime', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'treeseed-component-proof-'));
  try {
    mkdirSync(resolve(root, 'deploy'));
    copyFileSync(resolve('deploy/compose.template.yml'), resolve(root, 'deploy/compose.template.yml'));
    const digest = `sha256:${'a'.repeat(64)}`;
    execFileSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'),
      resolve('scripts/release/create-component-release.ts')], {
      cwd: root, stdio: 'pipe',
      env: { PATH: process.env.PATH, TREESEED_RELEASE: '0.13.0-rc.1',
        TREESEED_SOURCE_COMMIT: 'a'.repeat(40), TREESEED_ADMIN_DIGEST: digest,
        TREESEED_MANAGER_DIGEST: digest, TREESEED_RUNNER_DIGEST: digest,
        TREESEED_SANDBOX_BASE_DIGEST: digest, TREESEED_GUEST_DIGEST: digest },
    });
    const raw = JSON.parse(readFileSync(resolve(root, 'release-assets/component-release.json'), 'utf8'));
    const parsed = componentReleaseSchema.parse(raw);
    expect(raw.runtimeDigest).toBe(deploymentDigest(raw.runtime));
    expect(parsed.runtimeDigest).toBe(deploymentDigest(parsed.runtime));
    expect(componentReleaseSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(parsed.runtime.configuration).toBeDefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
