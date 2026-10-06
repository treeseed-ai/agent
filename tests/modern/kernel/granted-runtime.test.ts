import { describe, expect, it, vi } from 'vitest';
import { enforceAssignmentGrant } from '../../../src/kernel/granted-runtime.ts';
import type { AgentRuntime } from '../../../src/kernel/contracts.ts';

function fixture(paths = ['src']) {
	const commitSource = vi.fn<AgentRuntime['commitSource']>();
	const runtime: AgentRuntime = {
		now: () => '2026-09-26T08:00:00.000Z', readContext: vi.fn(), invokeModel: vi.fn(),
		runVerification: vi.fn(), commitTreeDx: vi.fn(), commitSource,
	};
	const workspace = { mode: 'git', repository: 'treeseed-ai/sdk', writablePaths: paths };
	const scoped = enforceAssignmentGrant(runtime, { contentRead: [], contentWrite: [], sourceRead: [],
		sourceWrite: ['treeseed-ai/sdk'], tools: ['source.write'] }, workspace, () => undefined);
	return { scoped, commitSource };
}
describe('canonical workspace path enforcement', () => {
	it('uses the SDK recursive workspace grant before source publication', async () => {
		const { scoped, commitSource } = fixture(['src/**']);
		await scoped.commitSource({ message: 'Work', paths: ['src/kernel/handler.ts'] });
		expect(() => scoped.commitSource({ message: 'Work', paths: ['src-other/handler.ts'] })).toThrow('assignment_grant_denied:source.path');
		expect(commitSource).toHaveBeenCalledOnce();
	});
	it('denies traversal and sibling-prefix escapes before publication', () => {
		for (const path of ['src/../../outside', 'src/../secret', '/etc/passwd', '../src/file.ts', 'src/./file.ts',
			'src//file.ts', 'src\\..\\secret', 'src/file\0.ts', '', 'src-other/file.ts', 'tests/protected.test.ts']) {
			const { scoped, commitSource } = fixture();
			for (const paths of [[path], ['src/authorized.ts', path], [path, 'src/authorized.ts']]) {
				const input = { message: 'Work', paths }, before = structuredClone(input);
				expect(() => scoped.commitSource(input)).toThrow('assignment_grant_denied:source.path');
				expect(input).toEqual(before);
			}
			expect(commitSource).not.toHaveBeenCalled();
		}
	});
	it('allows normal nested paths without broadening a scoped prefix', async () => {
		const { scoped, commitSource } = fixture();
		await scoped.commitSource({ message: 'Work', paths: ['src/index.ts', 'src/kernel/handler.ts'] });
		expect(commitSource).toHaveBeenCalledOnce();
	});
	it('supports an explicitly granted repository root but still rejects traversal', async () => {
		const { scoped, commitSource } = fixture(['.']);
		await scoped.commitSource({ message: 'Work', paths: ['README.md', 'tests/check.test.ts'] });
		expect(() => scoped.commitSource({ message: 'Work', paths: ['../outside'] })).toThrow('assignment_grant_denied:source.path');
		expect(commitSource).toHaveBeenCalledOnce();
	});
});
