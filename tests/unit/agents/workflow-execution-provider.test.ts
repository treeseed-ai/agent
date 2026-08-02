import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionProviderAdapter } from '../../../src/agents/adapters/operations/execution-workflow.ts';

function invocation() {
	return {
		assignment: { id: 'assignment-a', capabilityHandles: { workflowOperations: [{
			id: 'handle-a', kind: 'workflow_operation', operationId: 'verify-project', status: 'active',
			assignmentId: 'assignment-a', operations: ['dispatch_workflow'], repository: 'example/repo',
			workflowFile: '.github/workflows/verify.yml', ref: 'refs/heads/main',
		}] } },
		leaseToken: 'lease-a', workPackage: { kind: 'verify-project', title: 'Verify', summary: 'Verify.',
			instructions: 'Run verification.', context: {}, expectedOutputs: [], metadata: {} },
		decisionInput: { input: {} }, metadata: {},
	} as any;
}

describe('assignment workflow execution provider', () => {
	it('preserves the TreeSeed run id and polls through the assignment-scoped API', async () => {
		const getWorkflowOperationRun = vi.fn().mockResolvedValue({ ok: true, payload: {
			id: 'run-a', status: 'completed', providerRunId: '881', providerRunUrl: 'https://github.test/runs/881',
		} });
		const adapter = new WorkflowExecutionProviderAdapter({
			dispatchWorkflowOperation: vi.fn().mockResolvedValue({ ok: true, payload: {
				run: { id: 'run-a', status: 'authorizing' }, operation: { id: 'platform-operation-a' },
			} }), getWorkflowOperationRun,
		});
		const started = await adapter.start(invocation());
		expect(started).toMatchObject({ runId: 'run-a', status: 'waiting' });
		const observed = await adapter.poll({ assignmentId: 'assignment-a', runId: started.runId,
			metadata: started.metadata, externalRef: started.externalRef, externalUrl: started.externalUrl });
		expect(getWorkflowOperationRun).toHaveBeenCalledWith('assignment-a', 'run-a');
		expect(observed).toMatchObject({ runId: 'run-a', status: 'completed', externalUrl: 'https://github.test/runs/881' });
	});
});
