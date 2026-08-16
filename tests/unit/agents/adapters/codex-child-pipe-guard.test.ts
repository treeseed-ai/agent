import { describe, expect, it, vi } from 'vitest';
import { withCodexChildPipeGuard } from '../../../../src/agents/adapters/codex/codex-child-pipe-guard.ts';

describe('Codex child pipe guard', () => {
	it('contains an SDK child-stdin EPIPE while the turn is active', async () => {
		const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
		const warning = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		await expect(withCodexChildPipeGuard(async () => {
			process.emit('uncaughtException', error, 'uncaughtException');
			return 'continued';
		})).resolves.toBe('continued');
		expect(warning).toHaveBeenCalledWith(expect.stringContaining('codex.child_pipe_closed'));
		warning.mockRestore();
	});
});
