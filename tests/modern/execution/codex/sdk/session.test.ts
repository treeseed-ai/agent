import { expect, it } from 'vitest';
import { codexThreadOptions } from '../../../../../src/kernel/handlers/codex-sdk-session.ts';

it('uses typed SDK options with the assigned model and governed guest instruction boundary', () => {
	expect(codexThreadOptions('assigned-model', 'high')).toEqual({ model: 'assigned-model',
		modelReasoningEffort: 'high', workingDirectory: '/workspace/project',
		sandboxMode: 'danger-full-access', approvalPolicy: 'never' });
	expect(codexThreadOptions('assigned-model', undefined).modelReasoningEffort).toBeUndefined();
	expect(() => codexThreadOptions('assigned-model', 'invented')).toThrow('codex_reasoning_effort_invalid');
});
