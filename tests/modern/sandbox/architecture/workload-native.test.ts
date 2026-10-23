import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { executeWorkload, parseWorkload } from '../../../../src/sandbox/workload.ts';

const program = { executable: process.execPath, arguments: ['--version'], workingDirectory: tmpdir() };
describe('opaque workload process boundary', () => {
	it('executes an ordinary program without any agent identity profile or model context', async () => {
		const before = structuredClone(program), observed = await executeWorkload(program, { timeoutMs: 1000, outputBytes: 4096 });
		expect(observed.stdout.trim()).toBe(process.version);
		expect(observed.stderr).toBe('');
		expect(program).toEqual(before);
	});
	it('retains actual process failure and enforces the original execution limit', async () => {
		await expect(executeWorkload({ executable: '/bin/sh', arguments: ['-c', 'exit 23'], workingDirectory: tmpdir() },
			{ timeoutMs: 1000, outputBytes: 4096 })).rejects.toMatchObject({ exitCode: 23 });
		await expect(executeWorkload({ executable: '/bin/sleep', arguments: ['2'], workingDirectory: tmpdir() },
			{ timeoutMs: 25, outputBytes: 4096 })).rejects.toMatchObject({ exitCode: null });
	});
	it('passes environment data without interpreting workload output', async () => {
		const observed = await executeWorkload({ executable: '/bin/sh', arguments: ['-c', 'printf "%s" "$WORKLOAD_VALUE"'],
			workingDirectory: tmpdir(), environment: { WORKLOAD_VALUE: 'opaque process output' } }, { timeoutMs: 1000, outputBytes: 4096 });
		expect(observed.stdout).toBe('opaque process output');
	});
	it('rejects malformed manifests and task-policy fields before starting a process', () => {
		for (const input of [null, [], {}, { ...program, executable: 'node' }, { ...program, arguments: [null] },
			{ ...program, workingDirectory: 'relative' }, { ...program, agentClass: 'engineer' },
			{ ...program, activity: 'reviewing' }, { ...program, acceptanceCriteria: ['release'] }]) {
			expect(() => parseWorkload(input)).toThrow('workload_manifest_invalid');
		}
		for (const environment of [null, [], { 'bad-key': 'value' }, { KEY: 1 }, { KEY: '\0' }]) {
			expect(() => parseWorkload({ ...program, environment })).toThrow('workload_environment_invalid');
		}
	});
});
