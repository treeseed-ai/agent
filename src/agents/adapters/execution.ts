import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeAgentCliOptions, buildCopilotAllowToolArgs } from '../cli-tools.ts';
import type { AgentExecutionAdapter } from '../runtime-types.ts';
import { getTreeseedAgentProviderSelections } from '@treeseed/core/deploy/runtime';

const execFileAsync = promisify(execFile);

export class StubExecutionAdapter implements AgentExecutionAdapter {
	async runTask(input: { prompt: string; runId: string }) {
		return {
			status: 'completed' as const,
			summary: `Stubbed Copilot execution for ${input.runId}.`,
			stdout: [
				'# Planned Task',
				'',
				'1. Inspect the requested architecture context.',
				'2. Produce a safe local change artifact.',
				'3. Summarize the implementation intent.',
				'',
				`Prompt digest: ${input.prompt.slice(0, 240)}`,
			].join('\n'),
			stderr: '',
		};
	}
}

export class CopilotExecutionAdapter implements AgentExecutionAdapter {
	async runTask(input: { agent: { cli?: { model?: string; allowTools?: string[]; additionalArgs?: string[] } }; prompt: string }) {
		const cli = normalizeAgentCliOptions(input.agent.cli);
		const args = ['copilot', '-p', input.prompt];
		if (cli.model) {
			args.push('--model', cli.model);
		}
		args.push(...buildCopilotAllowToolArgs(cli.allowTools));
		args.push(...(cli.additionalArgs ?? []));

		try {
			const { stdout, stderr } = await execFileAsync('gh', args, {
				cwd: process.cwd(),
				env: process.env,
				maxBuffer: 10 * 1024 * 1024,
			});
			return {
				status: 'completed' as const,
				summary: 'Copilot task completed.',
				stdout,
				stderr,
			};
		} catch (error) {
			const stderr =
				error && typeof error === 'object' && 'stderr' in error
					? String((error as { stderr?: string }).stderr ?? '')
					: error instanceof Error
						? error.message
						: String(error);
			return {
				status: 'failed' as const,
				summary: 'Copilot task failed.',
				stdout: '',
				stderr,
			};
		}
	}
}

export class ManualExecutionAdapter implements AgentExecutionAdapter {
	async runTask(input: { prompt: string; runId: string }) {
		return {
			status: 'completed' as const,
			summary: `Manual execution mode is enabled for ${input.runId}.`,
			stdout: [
				'# Manual Execution Required',
				'',
				'This agent run is configured for manual execution.',
				'Review the prompt below and complete the work outside the automated adapter.',
				'',
				input.prompt,
			].join('\n'),
			stderr: '',
		};
	}
}

export function createExecutionAdapter() {
	const configuredMode = String(
		process.env.TREESEED_AGENT_EXECUTION_PROVIDER ?? getTreeseedAgentProviderSelections().execution,
	).toLowerCase();
	if (configuredMode === 'manual') {
		return new ManualExecutionAdapter();
	}
	if (configuredMode !== 'copilot') {
		return new StubExecutionAdapter();
	}
	return new CopilotExecutionAdapter();
}
