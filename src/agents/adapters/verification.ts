import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentVerificationAdapter } from '../runtime-types.ts';
import { getTreeseedAgentProviderSelections } from '@treeseed/core/deploy/runtime';

const execFileAsync = promisify(execFile);

export class StubVerificationAdapter implements AgentVerificationAdapter {
	async runChecks(input: { commands: string[]; runId: string }) {
		return {
			status: 'completed' as const,
			summary: input.commands.length
				? `Stub verification completed for ${input.runId}.`
				: 'No verification commands configured.',
			stdout: input.commands.join('\n'),
			stderr: '',
		};
	}
}

export class LocalVerificationAdapter implements AgentVerificationAdapter {
	async runChecks(input: { commands: string[] }) {
		if (!input.commands.length) {
			return {
				status: 'waiting' as const,
				summary: 'No verification commands configured.',
				stdout: '',
				stderr: '',
			};
		}

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		for (const command of input.commands) {
			try {
				const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', command], {
					env: process.env,
					maxBuffer: 10 * 1024 * 1024,
				});
				stdoutChunks.push(stdout);
				stderrChunks.push(stderr);
			} catch (error) {
				return {
					status: 'failed' as const,
					summary: `Verification command failed: ${command}`,
					stdout: stdoutChunks.join('\n'),
					stderr:
						error && typeof error === 'object' && 'stderr' in error
							? String((error as { stderr?: string }).stderr ?? '')
							: String(error),
					errorCategory: 'execution_error' as const,
				};
			}
		}
		return {
			status: 'completed' as const,
			summary: `Verification completed for ${input.commands.length} command(s).`,
			stdout: stdoutChunks.join('\n'),
			stderr: stderrChunks.join('\n'),
		};
	}
}

export function createVerificationAdapter() {
	return String(
		process.env.TREESEED_AGENT_VERIFICATION_PROVIDER ?? getTreeseedAgentProviderSelections().verification,
	).toLowerCase() !== 'local'
		? new StubVerificationAdapter()
		: new LocalVerificationAdapter();
}
