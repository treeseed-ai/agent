import { describe, expect, it } from 'vitest';
import type { AssignmentContext, AssignmentReference } from '@treeseed/sdk/agent-capacity';
import { AgentKernel } from '../../../src/kernel/agent-kernel.ts';
import type { AgentRuntime } from '../../../src/kernel/contracts.ts';
import { HandlerRegistry } from '../../../src/kernel/handler-registry.ts';
import { ReporterHandler } from '../../../src/kernel/handlers/reporter.ts';

const commit = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const runtimeBuild = `sha256:${'c'.repeat(64)}`;
const reportTarget = { store: 'treedx' as const, model: 'note', id: 'workday-report', revision: 1, digest };

function assignmentContext(): AssignmentContext {
	return {
		assignment: {
			schemaVersion: 'treeseed.assignment-attempt/v1', id: 'assignment-1', idempotencyKey: 'assignment-1-attempt-1',
			teamId: 'team-1', projectId: 'project-1', workdayId: 'workday-1', nodeId: 'node-1', workItemId: 'report-workday', nodeRevision: 1, graphRevision: 1,
			sourceRef: { store: 'treedx', model: 'proposal', id: 'proposal-1', revision: 1, digest }, authorityRefs: [{ store: 'treedx', model: 'decision', id: 'decision-1', revision: 1, digest }],
			effectiveProfile: {
				profileRef: { store: 'treedx', model: 'agent', id: 'reporter-1', revision: 1, digest }, activity: 'reporting', handler: 'reporter',
				handlerOrigin: 'agent-package', prompt: { system: 'Record an exact deterministic report for the closing workday.' },
				permissionCeiling: { content: { read: ['note'], write: ['note'] }, tools: [] },
			},
			requiredCapabilities: [], grant: { contentRead: [], contentWrite: [reportTarget], sourceRead: [], sourceWrite: [], tools: [] },
			provider: { providerId: 'provider-1', offerId: 'offer-1', offerRevision: 1, runtimeBuild }, contextRefs: [], predecessorResultIds: [],
			acceptanceCriteria: ['Commit one exact report.'],
			workspace: { mode: 'treedx', workspaceId: 'workspace-1', repository: 'treeseed-ai/team-library', baseCommit: commit, writablePaths: ['notes'] },
			estimate: { minimumSeconds: 1, expectedSeconds: 10, maximumSeconds: 30 }, limits: { maximumSeconds: 30, maximumContextBytes: 1024, maximumContextItems: 10 },
			deadline: '2099-09-13T12:00:00.000Z', leaseId: 'lease-1', reservationId: 'reservation-1', attempt: 1, status: 'running', createdAt: '2026-09-13T12:00:00.000Z',
		},
		context: [], predecessorResults: [],
	};
}

function runtime(commits: unknown[]): AgentRuntime {
	return {
		now: () => '2026-09-13T12:00:01.000Z',
		readContext: async () => null,
		invokeModel: async () => { throw new Error('reporter_must_not_invoke_model'); },
		runVerification: async () => { throw new Error('unexpected_verification'); },
		commitSource: async () => { throw new Error('unexpected_source_commit'); },
		commitTreeDx: async (request): Promise<AssignmentReference> => {
			commits.push(request.value);
			return { kind: 'treedx', projectId: 'project-1', repository: 'treeseed-ai/team-library', commit, path: 'notes/workday-report.yml', workspaceId: 'workspace-1' };
		},
	};
}

describe('AgentKernel', () => {
	it('runs Reporter deterministically through the one assignment entry point', async () => {
		const kernel = new AgentKernel(new HandlerRegistry([new ReporterHandler()]));
		const firstCommits: unknown[] = [];
		const secondCommits: unknown[] = [];
		const first = await kernel.runAssignment({ context: assignmentContext(), runtimeBuild, runtime: runtime(firstCommits) });
		const second = await kernel.runAssignment({ context: assignmentContext(), runtimeBuild, runtime: runtime(secondCommits) });
		expect(first).toEqual(second);
		expect(firstCommits).toEqual(secondCommits);
		expect(first.references[0]).toMatchObject({ kind: 'treedx', path: 'notes/workday-report.yml' });
	});

	it('fails closed on unknown handlers and wrong runtime builds', async () => {
		const kernel = new AgentKernel(new HandlerRegistry([new ReporterHandler()]));
		const unknown = assignmentContext();
		unknown.assignment.effectiveProfile.handler = 'missing';
		await expect(kernel.runAssignment({ context: unknown, runtimeBuild, runtime: runtime([]) })).rejects.toThrow('unknown_handler:missing');
		await expect(kernel.runAssignment({ context: assignmentContext(), runtimeBuild: digest, runtime: runtime([]) })).rejects.toThrow('runtime_build_mismatch');
	});

	it('enforces the exact TreeDX write grant at the runtime boundary', async () => {
		const kernel = new AgentKernel(new HandlerRegistry([new ReporterHandler()]));
		const denied = assignmentContext();
		denied.assignment.grant.contentWrite = [];
		await expect(kernel.runAssignment({ context: denied, runtimeBuild, runtime: runtime([]) })).rejects.toThrow('reporter_note_grant_required');
	});
});
