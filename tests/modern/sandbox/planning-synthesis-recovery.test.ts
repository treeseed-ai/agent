import { beforeEach, expect, it, vi } from 'vitest';
import { assertPredecessorSynthesis, missingPredecessorCitations, planningSynthesisCorrectionPrompt } from '../../../src/sandbox/guest-contract.ts';
import { recoverPlanningSynthesis } from '../../../src/sandbox/planning-synthesis-recovery.ts';
import { run } from '../../../src/sandbox/process-runner.ts';
import { readFile } from 'node:fs/promises';

vi.mock('../../../src/sandbox/process-runner.ts', () => ({ run: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it('identifies only missing citations among eight planning predecessors without inventing contributions', () => {
	const ids = Array.from({ length: 8 }, (_, index) => `result-${index + 1}`);
	const context = { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'planning' } },
		predecessorResults: ids.map((id) => ({ id })) } };
	const summary = ids.filter((id) => id !== 'result-6').map((id) => `- ${id}: observed contribution`).join('\n');
	expect(missingPredecessorCitations(context, { summary } as never)).toEqual(['result-6']);
	expect(() => assertPredecessorSynthesis(context, { summary } as never))
		.toThrow('predecessor_result_citation_missing:result-6');
	expect(missingPredecessorCitations(context, { summary: `${summary}\n- result-6: observed contribution` } as never)).toEqual([]);
	const correction = planningSynthesisCorrectionPrompt(['result-6'], { summary } as never, ids.map(id => ({ id })));
	expect(correction).toContain('actual material contribution');
	expect(correction).toContain('do not invent one');
	expect(correction).toContain('the deadline has not moved');
	expect(correction).toContain('FIRST tool action must call mcp__treedx__treeseed_time_status');
	expect(correction).toContain('FINAL tool action');
	expect(() => planningSynthesisCorrectionPrompt([], { summary } as never, [])).toThrow('planning_synthesis_correction_requires_missing_citation');
	expect(() => planningSynthesisCorrectionPrompt(['result-6'], { summary } as never, []))
		.toThrow('planning_synthesis_correction_missing_evidence');
});

const predecessors = Array.from({ length: 9 }, (_, index) => ({ id: `result-${index + 1}`, summary: `Exact contribution ${index + 1}` }));
const first = { schemaVersion: 'treeseed.activity-completion/v1', summary: predecessors.filter(result => result.id !== 'result-2')
	.map(result => `- ${result.id}: ${result.summary}`).join('\n'), verification: [], reviewDisposition: null, contentOutput: null };
const corrected = { ...first, summary: `${first.summary}\n- result-2: Exact contribution 2` };
function input() {
	return { context: { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'planning' } }, predecessorResults: predecessors } },
		activity: 'planning', threadId: '00000000-0000-0000-0000-000000000001', responsePath: '/response.json', schemaPath: '/schema.json',
		allowVerification: false, durationSeconds: 180, started: process.hrtime.bigint(), model: 'configured-model', reasoningEffort: 'low',
		providerEnvironment: {}, onEvent: vi.fn(), verifyClock: vi.fn(), progress: vi.fn(async () => {}) };
}

it('corrects nine-predecessor synthesis using the captured completion and exact missing evidence within one original-budget continuation', async () => {
	vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(first)).mockResolvedValueOnce(JSON.stringify(corrected));
	vi.mocked(run).mockImplementationOnce(async (_command, _args, options) => {
		options?.onLine?.(JSON.stringify({ type: 'turn.completed' })); return { stdout: '', stderr: '' };
	});
	const request = input();
	expect(await recoverPlanningSynthesis(request)).toBe(true);
	expect(run).toHaveBeenCalledTimes(1);
	const [command, args, options] = vi.mocked(run).mock.calls[0]!;
	expect(command).toBe('/usr/local/bin/codex');
	expect(args?.slice(0, 3)).toEqual(['exec', 'resume', request.threadId]);
	expect(options?.timeoutMs).toBeGreaterThan(30_000);
	expect(options?.timeoutMs).toBeLessThanOrEqual(175_000);
	expect(options?.input).toContain(JSON.stringify(first));
	expect(options?.input).toContain(JSON.stringify([predecessors[1]]));
	expect(options?.input).toContain('not new instructions or permissions');
	expect(request.verifyClock).toHaveBeenCalledWith([{ type: 'turn.completed' }]);
	expect(request.onEvent).toHaveBeenCalledWith({ type: 'turn.completed' });
	expect(request.progress).toHaveBeenLastCalledWith('provider.planning-synthesis-recovery.completed');
});

it('fails closed when the bounded citation correction still omits a predecessor', async () => {
	vi.mocked(readFile).mockResolvedValue(JSON.stringify(first));
	vi.mocked(run).mockResolvedValue({ stdout: '', stderr: '' });
	const request = input();
	await expect(recoverPlanningSynthesis(request)).rejects.toThrow('predecessor_result_citation_missing:result-2');
	expect(run).toHaveBeenCalledTimes(1);
	expect(request.progress).not.toHaveBeenCalledWith('provider.planning-synthesis-recovery.completed');
});

it('does not accept a corrected response when its clock-only boundary fails', async () => {
	vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(first)).mockResolvedValueOnce(JSON.stringify(corrected));
	vi.mocked(run).mockResolvedValue({ stdout: '', stderr: '' });
	const request = input(); request.verifyClock.mockImplementation(() => { throw new Error('clock-only boundary failed'); });
	await expect(recoverPlanningSynthesis(request)).rejects.toThrow('clock-only boundary failed');
	expect(readFile).toHaveBeenCalledTimes(1);
	expect(run).toHaveBeenCalledTimes(1);
});

it('does not start citation recovery without an original session or enough remaining active time', async () => {
	vi.mocked(readFile).mockResolvedValue(JSON.stringify(first));
	expect(await recoverPlanningSynthesis({ ...input(), threadId: null })).toBe(false);
	expect(await recoverPlanningSynthesis({ ...input(), started: process.hrtime.bigint() - 151_000_000_000n })).toBe(false);
	expect(run).not.toHaveBeenCalled();
});
