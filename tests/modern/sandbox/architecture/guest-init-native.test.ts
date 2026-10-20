import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('native declared guest init reaps failed interrupted and killed subprocess descendants before the original runner settles', async () => {
	const dockerfile = await readFile(new URL('../../../../Dockerfile', import.meta.url), 'utf8');
	const entrypoint = JSON.parse(dockerfile.trim().split('\n').at(-1)!.replace(/^ENTRYPOINT /u, '')) as string[];
	const shell = entrypoint.indexOf('/bin/bash');
	if (shell < 0) throw new Error('Original guest shell entrypoint missing');
	const init = entrypoint.slice(0, shell);
	const root = fileURLToPath(new URL('../../../..', import.meta.url));
	const fixture = '/tmp/repo/tests/modern/sandbox/architecture/guest-init-process.ts';
	for (const mode of ['descendant-failed', 'descendant-hard', 'descendant-closeout']) {
		const { stdout } = await promisify(execFile)('bwrap', [
			'--unshare-user', '--unshare-pid', '--as-pid-1', '--unshare-net', '--die-with-parent', '--new-session',
			'--ro-bind', '/', '/', '--proc', '/proc', '--tmpfs', '/tmp', '--dev', '/dev',
			'--ro-bind', root, '/tmp/repo', '--chdir', '/tmp/repo',
			...(init[0] === '/usr/bin/tini' && process.env.TREESEED_TEST_TINI
				? ['--ro-bind', process.env.TREESEED_TEST_TINI, '/usr/bin/tini'] : []),
			...init, process.execPath, '--import', 'tsx', fixture, mode,
		], { cwd: root, timeout: 12_000,
			env: { PATH: process.env.PATH, HOME: '/tmp' }, maxBuffer: 16_384 });
		const observed = JSON.parse(stdout) as Record<string, unknown>;
		expect(observed).toMatchObject({ mode, parentAbsent: true, descendantAbsent: true, lateOutputAbsent: true, cause: null });
		expect(Number(observed.supervisorPid)).toBeGreaterThan(1);
		if (mode === 'descendant-failed') expect(observed).toMatchObject({ message: expect.stringContaining('exited 23'), exitCode: 23 });
		if (mode === 'descendant-hard') expect(observed).toMatchObject({ message: expect.stringContaining('interactive execution deadline'), exitCode: null });
		if (mode === 'descendant-closeout') expect(observed.message).toBe('codex_closeout_interrupted');
	}
}, 30_000);
