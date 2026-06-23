import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentVerificationAdapter } from '../runtime-types.ts';
import { getTreeseedAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';

const execFileAsync = promisify(execFile);

export class LocalVerificationAdapter implements AgentVerificationAdapter {
	async runChecks(input: { commands: string[]; cwd?: string }) {
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
					cwd: input.cwd ?? process.cwd(),
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
	const provider = String(
		process.env.TREESEED_AGENT_VERIFICATION_PROVIDER ?? getTreeseedAgentProviderSelections().verification,
	).toLowerCase();
	if (provider !== 'local') {
		throw new Error(`Unsupported agent verification provider "${provider}". Configure TREESEED_AGENT_VERIFICATION_PROVIDER=local.`);
	}
	return new LocalVerificationAdapter();
}
