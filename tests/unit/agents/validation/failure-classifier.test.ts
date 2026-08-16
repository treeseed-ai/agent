import { describe, expect, it } from 'vitest';
import {
	classifyAgentExecutionFailure,
	isRetryableAgentExecutionFailure,
} from '../../../../src/agents/kernel/validation/failure-classifier.ts';

describe('agent execution failure classification', () => {
	it('keeps transient transport failures resumable', () => {
		expect(isRetryableAgentExecutionFailure(new TypeError('fetch failed'))).toBe(true);
		expect(isRetryableAgentExecutionFailure(new Error('socket temporarily unavailable'))).toBe(true);
		expect(classifyAgentExecutionFailure(new TypeError('fetch failed'))).toBe('sdk_error');
	});

	it('does not make semantic or permission failures retryable', () => {
		expect(isRetryableAgentExecutionFailure(new Error('Artifact kind is invalid.'))).toBe(false);
		expect(isRetryableAgentExecutionFailure(new Error('Path is not allowed.'))).toBe(false);
	});
});
