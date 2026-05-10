import { normalizeAgentCliOptions } from '../cli-tools.ts';
import type { AgentExecutionAdapter } from '../runtime-types.ts';
import { getTreeseedAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';
import { runTreeseedCopilotTask } from '@treeseed/sdk/copilot';

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
		const result = await runTreeseedCopilotTask({
			prompt: input.prompt,
			cwd: process.cwd(),
			model: cli.model,
			allowTools: cli.allowTools,
			env: process.env,
		});
		const ignoredArgs = cli.additionalArgs?.length
			? `Ignored Copilot CLI-only arguments because Treeseed uses @github/copilot-sdk internally: ${cli.additionalArgs.join(' ')}`
			: '';
		return {
			...result,
			stderr: [result.stderr, ignoredArgs].filter(Boolean).join('\n'),
		};
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
