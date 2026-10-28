import assert from 'node:assert/strict';
import { PackageArchiveInspector, type PackageArchiveFile } from '@treeseed-cordis/deployment';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';

class AgentToolchainAcceptance {
  compiled(): void {
    expect(existsSync('dist/tests/support/toolchain-program.js')).toBe(true);
    expect(existsSync('dist/tests/support/toolchain-program.d.ts')).toBe(true);
    const result = spawnSync('node', ['dist/tests/support/toolchain-program.js'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('agent-toolchain-ok\n');
  }

  wired(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(metadata.scripts.check).toContain('bun scripts/tooling.ts check');
    expect(metadata.scripts.build).toBe(
      'bun scripts/tooling.ts build && bun scripts/guest-build.ts',
    );
  }
}
const suite = new AgentToolchainAcceptance();
test(
  'acceptance: independent Agent build emits a genuine public Node and declaration consumer',
  suite.compiled.bind(suite),
);
test(
  'acceptance: normal Agent owner checks wire semantic class and source-boundary enforcement',
  suite.wired.bind(suite),
);

class StandaloneGuestAcceptance {
  async archive(): Promise<void> {
    this.selection();
    const directory = mkdtempSync(join(tmpdir(), 'guest-owner-archive-'));
    const result = spawnSync(process.execPath, ['pm', 'pack', '--destination', directory], {
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const file = join(directory, 'treeseed-cordis-agent-' + metadata.version + '.tgz');
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    const index = await PackageArchiveInspector.inspect(file, digest);
    assert.equal(index.metadata.name, metadata.name);
    assert.equal(index.metadata.version, metadata.version);
    assert(index.files.filter(StandaloneGuestAcceptance.chunk).length > 1);
    this.coverage(index.files);
  }
  private coverage(files: readonly PackageArchiveFile[]): void {
    const manifest = JSON.parse(readFileSync('dist/bin/guest-runtime.json', 'utf8'));
    const actual = [];
    for (const file of files)
      if (StandaloneGuestAcceptance.chunk(file)) actual.push(file.path.slice('dist/bin/'.length));
    const expected = [];
    for (const part of manifest.compressed.parts) expected.push(part.file);
    assert.deepEqual(actual.sort(), expected.sort());
  }
  private static chunk(file: { path: string }): boolean {
    return file.path.endsWith('.gzpart');
  }
  private selection(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const installed = JSON.parse(
      readFileSync('node_modules/@treeseed-cordis/deployment/package.json', 'utf8'),
    );
    const hash = createHash('sha256').update(readFileSync('vendor/deployment.tgz')).digest('hex');
    assert.equal(hash, '03956a2484bd14194c9bcac58178f8efcd77eb54760ef480204c441f048badfa');
    assert.equal(metadata.cordisCandidate.deployment.sha256, hash);
    assert.equal(
      metadata.cordisCandidate.deployment.commit,
      '386a09c909d200176e7c0d324ca915a5503e6740',
    );
    assert.equal(installed.version, '0.0.0-cordis.83');
  }
  programs(): void {
    for (const mode of [
      '--normal',
      '--deny',
      '--foreign',
      '--ungranted',
      '--malformed',
      '--cancel',
    ]) {
      const result = spawnSync(
        'node',
        ['dist/tests/support/guest-program.js', mode, '--standalone'],
        { encoding: 'utf8', timeout: 12000 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'guest-program-ok\n');
    }
  }
}
const standalone = new StandaloneGuestAcceptance();
test(
  'acceptance: source-free standalone guest passes the full program contract with no developer tools or ambient preload',
  standalone.programs.bind(standalone),
  80000,
);

test(
  'acceptance: genuine standalone owner archive passes accepted Deployment custody without changing shared bounds',
  standalone.archive.bind(standalone),
  80000,
);
