import { describe, expect, it } from 'vitest';
import {
	AssignmentExecutionProviderSelectionError,
	resolveAssignmentExecutionProvider,
} from '../../../src/provider/execution-provider-selection.ts';

const providers = [
	{ id: 'codex-primary', adapter: 'codex', nativeLimits: { maxConcurrentRunners: 2 } },
	{ id: 'research-workflow', adapter: 'workflow', nativeLimits: { maxConcurrentRunners: 1 } },
];

describe('assignment execution-provider selection', () => {
	it('resolves an arbitrary provider-global id to its manifest adapter', () => {
		expect(resolveAssignmentExecutionProvider({
			assignment: { executionProviderId: 'codex-primary' },
			executionProviders: providers,
		})).toEqual(providers[0]);
	});

	it('uses the sole configured provider only when the assignment is unambiguous', () => {
		expect(resolveAssignmentExecutionProvider({
			assignment: {},
			executionProviders: [providers[1]!],
		})).toEqual(providers[1]);
	});

	it('fails closed for an unknown provider id', () => {
		expect(() => resolveAssignmentExecutionProvider({
			assignment: { executionProviderId: 'codex-missing' },
			executionProviders: providers,
		})).toThrowError(expect.objectContaining<Partial<AssignmentExecutionProviderSelectionError>>({
			code: 'assignment_execution_provider_not_configured',
		}));
	});

	it('fails closed when multiple providers exist without an assignment id', () => {
		expect(() => resolveAssignmentExecutionProvider({
			assignment: {},
			executionProviders: providers,
		})).toThrowError(expect.objectContaining<Partial<AssignmentExecutionProviderSelectionError>>({
			code: 'assignment_execution_provider_id_required',
		}));
	});
});
