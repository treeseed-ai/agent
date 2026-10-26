import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';

async function groupMembers(group: number) {
	const members: Array<{ pid: number; name: string; state: string; operations: string[] }> = [];
	for (const entry of await readdir('/proc')) {
		if (!/^\d+$/u.test(entry)) continue;
		try {
			const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
			const end = stat.lastIndexOf(')'), fields = stat.slice(end + 2).split(' ');
			if (Number(fields[2]) === group) members.push({ pid: Number(entry), name: stat.slice(stat.indexOf('(') + 1, end), state: fields[0]!,
				operations: (await readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0').filter(arg => /^(fetch|clone|ls-remote|checkout|--[a-z-]+|origin|HEAD)$/u.test(arg)) });
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
	}
	return members;
}

it.each(['transports the required proposal model for a renamed group subscriber estimate through the pinned CLI',
	'rejects EN-shaped invalid output even when the real CLI exits zero after strict schema submission'])(
	'closes the real SDK verifier process group: %s', async name => {
	const root = await mkdtemp(join(tmpdir(), 'sdk-verifier-custody-'));
	const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts',
		'tests/modern/sandbox/codex-schema-transport.test.ts', '-t', `^.*${name}$`, '--reporter=json', `--outputFile=${join(root, 'report.json')}`],
	{ detached: true, stdio: 'pipe', timeout: 20_000 });
	let output = '';
	child.stdout.on('data', chunk => { output += String(chunk); });
	child.stderr.on('data', chunk => { output += String(chunk); });
	try {
		const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
		});
		expect(result, output).toEqual({ code: 0, signal: null });
		expect(JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))).toMatchObject({ success: true, numPassedTests: 1 });
		const deadline = performance.now() + 100;
		let members = await groupMembers(child.pid!);
		while (members.length && performance.now() < deadline) { await delay(10); members = await groupMembers(child.pid!); }
		expect(members, 'The selected SDK verifier must leave no owned subprocesses.').toEqual([]);
	} finally {
		try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); }
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
