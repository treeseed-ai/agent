import { describe,expect,it,vi } from 'vitest';
import { runCodexTask,type CodexExecutionRequest } from '../../../../../src/agents/adapters/codex/execution-codex.ts';

const request: CodexExecutionRequest = {
	taskId: 'assignment-timeout',
	agentSlug: 'planner',
	repoRoot: '/repo',
	prompt: 'Plan until cancelled.',
	allowedPaths: [],
	forbiddenPaths: [],
	sandboxMode: 'read_only',
	approvalPolicy: 'never',
	timeoutMs: 5,
};

describe('Codex provider timeout cancellation', () => {
	it('aborts and joins the active turn before reporting the timeout', async () => {
		const observed: string[] = [];
		const runStreamed = vi.fn(async (_prompt: string, options?: { signal?: AbortSignal }) => ({
			events: (async function* () {
				await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => {
					observed.push('aborted');
					resolve();
				}, { once: true }));
				throw Object.assign(new Error('turn aborted'), { name: 'AbortError' });
			})(),
		}));
		const result = await runCodexTask(request, {
			client: Promise.resolve({
				startThread: () => ({ id: 'thread-timeout', run: vi.fn(), runStreamed }),
				resumeThread: vi.fn(),
			}),
			onEvent: vi.fn(),
		});
		expect(result).toMatchObject({ threadId: 'thread-timeout', status: 'failed', error: { code: 'codex_execution_timeout' } });
		expect(observed).toEqual(['aborted']);
		expect(runStreamed.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});

	it('retains the thread id announced by the stream when the SDK populates it after start', async () => {
		const runStreamed = vi.fn(async (_prompt: string, options?: { signal?: AbortSignal }) => ({
			events: (async function* () {
				yield { type: 'thread.started', thread_id: 'thread-streamed-timeout' };
				await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', resolve, { once: true }));
				throw Object.assign(new Error('turn aborted'), { name: 'AbortError' });
			})(),
		}));
		const result = await runCodexTask(request, {
			client: Promise.resolve({
				startThread: () => ({ id: null, run: vi.fn(), runStreamed }),
				resumeThread: vi.fn(),
			}),
		});
		expect(result).toMatchObject({
			threadId: 'thread-streamed-timeout',
			status: 'failed',
			error: { code: 'codex_execution_timeout' },
		});
	});

	it('aborts the active turn when assignment authority is revoked', async () => {
		const authority = new AbortController();
		const runStreamed = vi.fn(async (_prompt: string, options?: { signal?: AbortSignal }) => ({
			events: (async function* () {
				await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', resolve, { once: true }));
				throw Object.assign(new Error('turn aborted'), { name: 'AbortError' });
			})(),
		}));
		const pending = runCodexTask({ ...request, timeoutMs: 5_000 }, {
			signal: authority.signal,
			client: Promise.resolve({
				startThread: () => ({ id: 'thread-revoked', run: vi.fn(), runStreamed }),
				resumeThread: vi.fn(),
			}),
			onEvent: vi.fn(),
		});
		await vi.waitFor(() => expect(runStreamed).toHaveBeenCalledOnce());
		authority.abort(new Error('Assignment reached terminal state.'));
		await expect(pending).resolves.toMatchObject({
			status: 'failed',
			error: { code: 'codex_execution_authority_revoked', message: 'Assignment reached terminal state.', retryable: false },
		});
	});
});
