import { describe, expect, it, vi } from 'vitest';
import { callContentTool } from '../../../src/agents/tools/content-tool-runtime.ts';

function descriptor() {
	return {
		id: 'treeseed.content.create', handleId: 'handle-a', projectId: 'project-a',
		assignmentId: 'assignment-a', workspaceId: 'workspace-a',
		allowedOperations: ['files:write', 'files:read'], allowedPaths: ['src/content/**'],
		routes: {
			applyWorkspaceChangeset: 'POST /v1/dx/projects/project-a/workspaces/workspace-a/changesets',
			readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path',
		},
		metadata: { contentAction: 'create', contentRoot: 'src/content', baseCommitSha: 'abc123', baseRef: 'refs/heads/main' },
	} as never;
}

function scopedProposalDescriptor() {
	return {
		...descriptor(),
		metadata: { ...descriptor().metadata, allowedProposalTypes: ['implementation'] },
	} as never;
}

function modelScopedDescriptor() {
	return {
		...descriptor(),
		metadata: {
			...descriptor().metadata,
			permissionSummary: {
				readModels: ['objective'], readActions: ['describe', 'query', 'read'], readPaths: ['src/content/objectives/**'],
				writeModels: ['note'], writeActions: ['create', 'update', 'link', 'validate'], writePaths: ['src/content/notes/**'],
				commitAllowed: false,
			},
		},
	} as never;
}

const validProposalFields = {
	description: 'A bounded self-hosting milestone.',
	date: '2026-08-12',
	status: 'planned',
	summary: 'Prove one complete governed loop.',
	proposalType: 'implementation',
	motivation: 'The internal development loop needs live evidence.',
	primaryContributor: 'self-hosting-architect',
};

describe('model-aware content mutation atomicity', () => {
	it('rejects a call-time model outside the immutable per-model permission snapshot', async () => {
		const fetchImpl = vi.fn(async () => { throw new Error('unauthorized model must not reach TreeDX'); });
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: modelScopedDescriptor(), fetchImpl: fetchImpl as typeof fetch,
			input: {
				model: 'decision', slug: 'forbidden-decision', title: 'Forbidden decision',
				fields: {}, body: 'This mutation is outside the profile authority.',
			},
		});
		expect(result).toEqual({
			ok: false,
			code: 'content_model_operation_denied',
			message: 'Content create for decision is outside the immutable assignment permission snapshot.',
			metadata: {
				action: 'create', model: 'decision',
				allowedActions: ['create', 'update', 'link', 'validate'], allowedModels: ['note'],
			},
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('returns field-addressable Zod diagnostics without staging an invalid create', async () => {
		const fetchImpl = vi.fn(async () => { throw new Error('invalid content must not reach TreeDX'); });
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: descriptor(), fetchImpl: fetchImpl as typeof fetch,
			input: {
				model: 'proposal', slug: 'governed-loop', title: 'Governed loop', body: 'Implement and verify the bounded loop.',
				fields: { ...validProposalFields, status: 'draft', proposalType: 'structural', motivation: '' },
			},
		});
		expect(result).toMatchObject({
			ok: false, code: 'content_validation_failed',
			metadata: { diagnostics: expect.arrayContaining([
			expect.objectContaining({ code: 'content_zod_invalid_enum_value', field: 'status' }),
			expect.objectContaining({ field: 'motivation' }),
			]) },
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('does not stage a Zod-valid proposal until its submission plan is complete', async () => {
		const fetchImpl = vi.fn(async () => { throw new Error('incomplete proposal must not reach TreeDX'); });
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: descriptor(), fetchImpl: fetchImpl as typeof fetch,
			input: { model: 'proposal', slug: 'governed-loop', title: 'Governed loop', body: 'Implement the loop.', fields: validProposalFields },
		});
		expect(result).toMatchObject({ ok: false, code: 'proposal_plan_incomplete' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('does not stage a record whose relation target is not the current canonical identity', async () => {
		const calls: string[] = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
			if (String(url).includes('/search')) return Response.json({ ok: true, payload: { results: [] } });
			throw new Error('invalid relation must not reach a TreeDX changeset');
		});
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: {
				...descriptor(), allowedOperations: ['files:write', 'files:read', 'files:search'],
				routes: { ...descriptor().routes, searchWorkspace: 'POST /v1/dx/projects/project-a/workspaces/workspace-a/search' },
			} as never,
			fetchImpl: fetchImpl as typeof fetch,
			input: {
				model: 'note', slug: 'invalid-link', title: 'Invalid link', body: 'Must remain unstaged.',
				relations: [{ field: 'relatedObjectives', targetModel: 'objective', targetSlug: 'objective:missing' }],
			},
		});
		expect(result).toMatchObject({ ok: false, code: 'content_relation_invalid' });
		expect(calls.some((call) => call.includes('/changesets'))).toBe(false);
	});

	it('rejects unfrozen proposal types before staging a TreeDX mutation', async () => {
		const fetchImpl = vi.fn(async () => { throw new Error('semantically unauthorized content must not reach TreeDX'); });
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: scopedProposalDescriptor(), fetchImpl: fetchImpl as typeof fetch,
			input: {
				model: 'proposal', slug: 'governed-loop', title: 'Governed loop', body: 'Implement and verify the bounded loop.',
				fields: {
					...validProposalFields,
					proposalTypes: ['implementation', 'documentation-automation'],
					plan: {
						desiredOutcome: 'One governed loop works end to end.', currentProblem: 'Repository outcomes are not yet proven.',
						proposedApproach: 'Implement and verify one bounded change.', scope: ['one project'], nonGoals: ['hosted release'],
						deliverables: ['validated change'], acceptanceCriteria: ['repository read-back passes'], risks: ['stale authority'],
						dependencies: ['accepted decision'], alternatives: ['remain fail-closed'], verification: ['inspect the exact ref'],
					},
				},
			},
		});
		expect(result).toMatchObject({
			ok: false, code: 'proposal_type_not_allowed',
			metadata: { unsupported: ['documentation-automation'], allowedProposalTypes: ['implementation'] },
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
