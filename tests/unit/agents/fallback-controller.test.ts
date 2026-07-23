import { describe, expect, it } from 'vitest';
import { AgentKernelFallbackController } from '../../../src/agents/kernel/fallback-controller.ts';

describe('AgentKernelFallbackController', () => {
	it('derives a replay-stable fallback evidence id from assignment attempt identity', () => {
		const controller = new AgentKernelFallbackController();
		const input = {
			assignmentId: 'Assignment A',
			projectId: 'project-a',
			mode: 'planning',
			fallback: { code: 'input_missing', reason: 'Input is missing.', retryable: true },
			metadata: { attemptCount: 2 },
		};
		const first = controller.buildOutput(input);
		const replay = controller.buildOutput(input);
		expect(first.id).toBe('fallback:assignment-a:planning:input_missing:attempt-2');
		expect(replay).toEqual(first);
	});
});
