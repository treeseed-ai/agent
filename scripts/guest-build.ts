import { GuestRuntimeBinding, type GuestRuntimeManifest } from '@treeseed-cordis/sdk';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
/** Explicit development build only; never invoked by plugin acquisition or guest startup. */
class GuestBinaryBuild {
  private static readonly output = 'dist/bin/trsd-agent-guest';
  private static readonly target = 'bun-linux-x64-baseline';
  private static readonly libraries = [
    'ld-linux-x86-64.so.2',
    'libc.so.6',
    'libdl.so.2',
    'libm.so.6',
    'libpthread.so.0',
  ];
  static run(): void {
    if (process.versions.bun !== '1.4.4') throw new Error('GUEST_COMPILER_VERSION_MISMATCH');
    mkdirSync('dist/bin', { recursive: true });
    this.compile();
    const binary = readFileSync(this.output);
    this.verify(binary);
    this.package(binary);
  }
  private static compile(): void {
    const result = spawnSync(
      process.execPath,
      [
        'build',
        '--compile',
        '--target=' + this.target,
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        '--no-compile-autoload-tsconfig',
        '--no-compile-autoload-package-json',
        'src/guest-main.ts',
        '--outfile',
        this.output,
      ],
      { stdio: 'inherit', timeout: 120000 },
    );
    if (result.status !== 0) throw new Error('GUEST_COMPILATION_FAILED');
    chmodSync(this.output, 0o755);
  }
  private static headers(flag: string): string {
    const result = spawnSync('readelf', [flag, this.output], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error('GUEST_ELF_INSPECTION_FAILED');
    return result.stdout;
  }
  private static verify(bytes: Buffer): void {
    if (
      bytes.length < 64 ||
      bytes.length > 128 * 1024 * 1024 ||
      !bytes.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) ||
      bytes.readUInt16LE(18) !== 62
    )
      throw new Error('GUEST_ELF_INVALID');
    const libraries = [];
    for (const match of this.headers('-d').matchAll(/Shared library: \[([^\]]+)\]/g))
      libraries.push(match[1]!);
    if (JSON.stringify(libraries.sort()) !== JSON.stringify(this.libraries))
      throw new Error('GUEST_OS_LIBRARIES_CHANGED');
    if (
      !this.headers('-l').includes('[Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]')
    )
      throw new Error('GUEST_ELF_INTERPRETER_CHANGED');
  }
  private static identity(bytes: Buffer): { size: number; sha256: string } {
    return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  private static clearParts(): void {
    for (const file of readdirSync('dist/bin'))
      if (/^trsd-agent-guest\.[0-9]{3}\.gzpart$/.test(file)) unlinkSync('dist/bin/' + file);
  }
  private static parts(bytes: Buffer): { file: string; size: number; sha256: string }[] {
    this.clearParts();
    const parts: { file: string; size: number; sha256: string }[] = [];
    const limit = 7 * 1024 * 1024;
    for (let offset = 0; offset < bytes.length; offset += limit) {
      const file = 'trsd-agent-guest.' + String(parts.length).padStart(3, '0') + '.gzpart';
      const part = bytes.subarray(offset, offset + limit);
      writeFileSync('dist/bin/' + file, part, { mode: 0o644 });
      parts.push({ file, ...this.identity(part) });
    }
    return parts;
  }
  private static manifest(binary: Buffer, compressed: Buffer): GuestRuntimeManifest {
    const parts = this.parts(compressed);
    return GuestRuntimeBinding.assert({
      schemaVersion: 'treeseed.guest-runtime/v1',
      compiler: 'bun@1.4.4',
      target: this.target,
      os: 'linux',
      architecture: 'amd64',
      interpreter: '/lib64/ld-linux-x86-64.so.2',
      requiredLibraries: this.libraries,
      compressed: { parts, format: 'gzip', ...this.identity(compressed) },
      executable: { mode: 0o755, ...this.identity(binary) },
    });
  }
  private static package(binary: Buffer): void {
    const compressed = gzipSync(binary, { level: 9 });
    if (compressed.length > 64 * 1024 * 1024)
      throw new Error('GUEST_COMPRESSED_ARTIFACT_TOO_LARGE');
    const manifest = this.manifest(binary, compressed);
    writeFileSync('dist/bin/guest-runtime.json', JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o644,
    });
  }
}
if (import.meta.main) GuestBinaryBuild.run();
