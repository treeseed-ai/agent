import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../provider-kernel-fixture.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';
import { verifySandboxDirectoryAbsence, verifySandboxHostAbsence } from '../../../acceptance/workday/record-custody.ts';

function supplied() {
	const original = request().assignment.assignmentAttempt;
	if (!original) throw new Error('Original complete attempt required');
	const attempt = assignmentAttemptSchema.parse({ ...original, status: 'failed' });
	const items: Row[] = [{ id: attempt.id, status: 'failed', assignmentAttempt: attempt, failedAt: '2026-09-13T12:00:02.000Z',
		capacityEnvelope: { budget: { time: { executionStartedAt: '2026-09-13T12:00:00.000Z' } } },
		lifecycleOutput: { sandboxId: 'sandbox-owned-attempt-1-abcdef12', teardown: { verified: true, completedAt: '2026-09-13T12:00:01.000Z' } } }];
	return { items, connections: [{ providerId: attempt.provider.providerId, teamId: attempt.teamId }], root: '/var/lib/treeseed/sandboxes',
		tasks: 'unrelated-live-task\n', containers: 'unrelated-live-container\n', mounts: '1 0 0:1 / / rw - rootfs rootfs rw\n' };
}
function paths(f: ReturnType<typeof supplied>) {
	return verifySandboxHostAbsence(f.items, f.connections, f.root, f.tasks, f.containers, f.mounts);
}
describe('exact native sandbox physical absence assertions', () => {
	it('requires independent exact owning host inventories while retaining unrelated live resources and original failed custody', () => {
		const f = supplied(), before = structuredClone(f);
		expect(paths(f)).toEqual(['/var/lib/treeseed/sandboxes/sandbox-owned-attempt-1-abcdef12']); expect(f).toEqual(before);
		f.tasks = ''; f.containers = ''; const empty = structuredClone(f);
		expect(paths(f)).toEqual(['/var/lib/treeseed/sandboxes/sandbox-owned-attempt-1-abcdef12']); expect(f).toEqual(empty);
		// Quiet exit-zero empty inventories are valid supplied observations, not
		// an executed ctr command, native allocation or physical closure receipt.
	});
	it('denies residual malformed foreign traversing and mounted physical scope without repairing native observations or failed history', () => {
		for (const mode of ['task', 'container', 'task-duplicate', 'container-malformed', 'mount', 'child-mount', 'escaped-mount', 'empty-mounts', 'malformed-mounts',
			'foreign-provider', 'foreign-team', 'empty-connections', 'traversal', 'absolute-id', 'empty-id', 'root', 'relative-root', 'unverified']) {
			const f = supplied(), output = row(f.items[0]!.lifecycleOutput), id = String(output.sandboxId), path = `${f.root}/${id}`;
			if (mode === 'task') f.tasks += `${id}\n`; if (mode === 'container') f.containers += `${id}\n`;
			if (mode === 'task-duplicate') f.tasks = 'duplicate\nduplicate\n'; if (mode === 'container-malformed') f.containers = 'error: denied\n';
			if (mode === 'mount' || mode === 'child-mount' || mode === 'escaped-mount') {
				const mounted = mode === 'child-mount' ? `${path}/input` : mode === 'escaped-mount' ? path.replaceAll('/', '\\057') : path;
				f.mounts += `2 1 0:2 / ${mounted} rw - tmpfs tmpfs rw\n`;
			}
			if (mode === 'empty-mounts') f.mounts = ''; if (mode === 'malformed-mounts') f.mounts = 'permission denied';
			if (mode === 'foreign-provider') f.connections[0]!.providerId = 'foreign'; if (mode === 'foreign-team') f.connections[0]!.teamId = 'foreign';
			if (mode === 'empty-connections') f.connections.length = 0; if (mode === 'traversal') output.sandboxId = '../foreign';
			if (mode === 'absolute-id') output.sandboxId = '/foreign'; if (mode === 'empty-id') output.sandboxId = '';
			if (mode === 'root') f.root = '/'; if (mode === 'relative-root') f.root = 'sandboxes'; if (mode === 'unverified') row(output.teardown).verified = false;
			const before = structuredClone(f); expect(() => paths(f)).toThrow(); expect(f).toEqual(before);
		}
	});
	it('native filesystem readback refuses retained files directories dangling links and non-directory ancestors without deleting failed observations', async () => {
		const allocated = await mkdtemp(join(tmpdir(), 'agent-physical-readback-'));
		try {
			const file = join(allocated, 'retained-file'), directory = join(allocated, 'retained-directory'), link = join(allocated, 'retained-link');
			const original = Buffer.from('retained original interrupted output\n');
			await writeFile(file, original); await mkdir(directory); await symlink(join(allocated, 'absent-target'), link);
			for (const target of [file, directory, link, join(file, 'not-a-directory')]) expect(() => verifySandboxDirectoryAbsence([target])).toThrow();
			expect(await readFile(file)).toEqual(original);
			const absent = join(allocated, 'never-allocated'); expect(() => verifySandboxDirectoryAbsence([absent])).not.toThrow();
			expect(() => verifySandboxDirectoryAbsence([])).toThrow(); expect(() => verifySandboxDirectoryAbsence([absent, absent])).toThrow();
			// Real native lstat/file/symlink semantics, not a Kata runtime, ctr or
			// broker allocation. Retained negative bytes remain until owned finally.
		} finally { await rm(allocated, { recursive: true, force: true }); }
		expect(() => verifySandboxDirectoryAbsence([allocated])).not.toThrow();
	});
});
