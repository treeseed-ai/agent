import { describe, expect, it, vi } from 'vitest';
import { SdkOperationsAdapter } from '../../src/agents/adapters/operations.ts';
import type {
	AgentOperationGrant,
	AgentOperationRequest,
} from '@treeseed/sdk/operations/agent-tools';

const request: AgentOperationRequest = {
	operation: 'dev',
	mode: 'plan',
	taskId: 'task-1',
	taskKind: 'implementation',
	agentSlug: 'engineer-agent',
	agentRole: 'engineer',
	projectId: 'market',
	environment: 'local',
	repoRoot: '/repo',
	permissionGrantId: 'grant-1',
	input: {},
};

const grant: AgentOperationGrant = {
	id: 'grant-1',
	operations: ['dev', 'verify'],
	modes: ['plan', 'read_only', 'mutating'],
	agentRoles: ['engineer'],
	taskKinds: ['implementation'],
	projectIds: ['market'],
	environments: ['local'],
	allowedPaths: ['src/content/knowledge/**'],
};

describe('agent operations adapter', () => {
	it('returns waiting for unauthorized requests and does not execute workflow operations', async () => {
		const execute = vi.fn();
		const createMessage = vi.fn(async () => ({ payload: {} }));
		const adapter = new SdkOperationsAdapter({ execute });

		const result = await adapter.runOperation({
			request: { ...request, permissionGrantId: undefined },
			grants: [],
			sdk: { createMessage } as never,
		});

		expect(result).toMatchObject({
			operation: 'dev',
			status: 'waiting',
			error: { code: 'operation_permission_required' },
		});
		expect(execute).not.toHaveBeenCalled();
		expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'agent.operation_event',
			payload: expect.objectContaining({ operation: 'dev' }),
		}));
	});

	it('executes authorized safe operations through workflow dispatch', async () => {
		const execute = vi.fn(async () => ({
			operation: 'local.dev',
			ok: true,
			payload: { planned: true },
			stdout: ['planned dev'],
			stderr: [],
		}));
		const createMessage = vi.fn(async () => ({ payload: {} }));
		const adapter = new SdkOperationsAdapter({ execute });

		const result = await adapter.runOperation({
			request,
			grants: [grant],
			sdk: { createMessage } as never,
		});

		expect(execute).toHaveBeenCalledWith({
			operationName: 'dev',
			input: {
				plan: true,
				planOnly: true,
			},
		}, expect.objectContaining({
			cwd: '/repo',
			transport: 'sdk',
		}));
		expect(result).toMatchObject({
			operation: 'dev',
			status: 'completed',
			commandsRun: ['dev'],
			metadata: {
				workflowResult: {
					operation: 'local.dev',
					ok: true,
				},
			},
		});
		expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'agent.operation_event',
			payload: expect.objectContaining({
				operation: 'dev',
				result: expect.objectContaining({ status: 'completed' }),
			}),
		}));
	});

	it('maps verify to test unless explicit lifecycle code later replaces it', async () => {
		const execute = vi.fn(async () => ({
			operation: 'local.test',
			ok: true,
			payload: null,
			stdout: [],
			stderr: [],
		}));
		const adapter = new SdkOperationsAdapter({ execute });

		await adapter.runOperation({
			request: {
				...request,
				operation: 'verify',
				input: {
					commands: ['npm test'],
				},
			},
			grants: [{
				...grant,
				operations: ['verify'],
			}],
		});

		expect(execute).toHaveBeenCalledWith(expect.objectContaining({
			operationName: 'test',
			input: {
				plan: true,
				planOnly: true,
				commands: ['npm test'],
			},
		}), expect.any(Object));
	});
});
