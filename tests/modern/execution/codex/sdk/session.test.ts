import { expect, it } from 'vitest';
import { codexThreadOptions, codexUsageEvidence } from '../../../../../src/kernel/handlers/codex-sdk-session.ts';

it('uses typed SDK options with the assigned model and governed guest instruction boundary', () => {
	expect(codexThreadOptions('assigned-model', 'high')).toEqual({ model: 'assigned-model',
		modelReasoningEffort: 'high', workingDirectory: '/workspace/project', skipGitRepoCheck: true,
		sandboxMode: 'danger-full-access', approvalPolicy: 'never' });
	expect(codexThreadOptions('assigned-model', undefined).modelReasoningEffort).toBeUndefined();
	expect(() => codexThreadOptions('assigned-model', 'invented')).toThrow('codex_reasoning_effort_invalid');
});

it('retains summed observed SDK usage while keeping interrupted or absent totals unknown', () => {
	const first = { type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } };
	const second = { ...first, providerInvocation: 1, usage: { input_tokens: 11, output_tokens: 5 } };
	expect(codexUsageEvidence([first, second])).toEqual({ complete: true, observed: { input_tokens: 18, output_tokens: 8 } });
	expect(codexUsageEvidence([{ type: 'thread.started' }, second])).toEqual({ complete: false, observed: { input_tokens: 11, output_tokens: 5 } });
	expect(codexUsageEvidence([{ type: 'turn.failed' }])).toBeNull();
	expect(() => codexUsageEvidence([first, first])).toThrow('codex_sdk_duplicate_turn_usage');
	expect(() => codexUsageEvidence([{ ...first, usage: { input_tokens: -1 } }])).toThrow('codex_sdk_usage_invalid');
});
