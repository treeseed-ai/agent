import { describe,expect,it } from 'vitest';
import { providerErrorDiagnostic,providerErrorIsRetryable } from '../../../src/provider/reporting/error-diagnostics.ts';

describe('provider error diagnostics', () => {
	it('preserves actionable proposal requirements and treats contract conflicts as terminal', () => {
		const error = Object.assign(new Error('Proposal is incomplete.'), {
			status: 409,
			code: 'assignment_proposal_plan_incomplete',
			details: {
				contentPath: 'src/content/proposals/guide.mdx',
				missingRequirements: ['research evidence'],
			},
		});
		expect(providerErrorDiagnostic(error, 'assignment_processing')).toMatchObject({
			code: 'assignment_proposal_plan_incomplete',
			path: 'src/content/proposals/guide.mdx',
			missingRequirements: ['research evidence'],
		});
		expect(providerErrorIsRetryable(error)).toBe(false);
	});

	it('keeps transport and server failures retryable', () => {
		expect(providerErrorIsRetryable(new Error('Connection reset.'))).toBe(true);
		expect(providerErrorIsRetryable(Object.assign(new Error('Unavailable.'), { status: 503 }))).toBe(true);
	});
});
