import { describe, expect, it, vi } from 'vitest';
import { renderContentRecord } from '@treeseed/sdk/content-operations';
import { contentModelSupportsArtifactKind, executionAgentForAccess } from '../../../src/agents/handlers/execution-content.ts';
import { executionContentRoot, resolveExecutionTreeDxContext } from '../../../src/agents/handlers/execution-content-context.ts';
import { buildExecutionContentInstructions } from '../../../src/agents/handlers/execution-content-prompt.ts';
import { callContentTool } from '../../../src/agents/tools/content-tool-runtime.ts';
import { collectExecutionContentArtifactReceipts } from '../../../src/agents/handlers/execution-content-artifacts.ts';
import { writerHandler } from '../../../src/agents/handlers/writer.ts';
describe('execution content artifact contract', () => {
	it('does not treat a blocking question as the required planning note', () => {
		expect(contentModelSupportsArtifactKind('question', 'planning_note')).toBe(false);
		expect(contentModelSupportsArtifactKind('question', 'planning_question')).toBe(true);
	});
	it('maps semantic note outputs only to note content models', () => {
		for (const artifactKind of [
			'planning_note',
			'proposal_feedback_note',
			'proposal_estimate',
			'question_answer',
			'decision_feedback',
			'workday_summary',
		]) {
			expect(contentModelSupportsArtifactKind('note', artifactKind)).toBe(true);
			expect(contentModelSupportsArtifactKind('proposal', artifactKind)).toBe(false);
		}
		expect(contentModelSupportsArtifactKind('proposal', 'planning_proposal')).toBe(true);
		expect(contentModelSupportsArtifactKind('knowledge', 'knowledge_page')).toBe(true);
		expect(contentModelSupportsArtifactKind('knowledge', 'knowledge_update')).toBe(true);
		expect(contentModelSupportsArtifactKind('note', 'knowledge_update')).toBe(false);
	});
	it('coalesces repeated TreeDX receipts by path and preserves the final subject relation', () => {
		const result = collectExecutionContentArtifactReceipts({
			agent: { slug: 'tester' }, capacity: { assignmentId: 'assignment-a' },
		} as never, {
			artifacts: [{
				kind: 'treedx_content_receipt', metadata: { contentRef: { model: 'note', path: 'notes/dummy.mdx' } },
			}, {
				kind: 'treedx_content_receipt', metadata: { contentRef: { model: 'note', path: 'notes/dummy.mdx', subjectId: 'decision-a', subjectField: 'relatedDecisions', commitSha: 'abc123', ref: 'refs/heads/assignment-a' } },
			}],
		} as never, 'revision_verification');
		expect(result).toEqual([expect.objectContaining({
			contentPath: 'notes/dummy.mdx', subjectId: 'decision-a', subjectField: 'relatedDecisions', commitSha: 'abc123',
		})]);
	});
	it('preserves configured source-write authority only for acting handlers', () => {
		const context = { agent: { execution: { sandboxMode: 'workspace_write', allowedPaths: ['src/**'] } } } as never;
		expect(executionAgentForAccess(context, 'configured').execution).toMatchObject({ sandboxMode: 'workspace_write', allowedPaths: ['src/**'] });
		expect(executionAgentForAccess(context, 'read_only').execution).toMatchObject({ sandboxMode: 'read_only', allowedPaths: [] });
	});

	it('passes configured workspace authority to the writer execution provider', async () => {
		let executionAgent: Record<string, unknown> | null = null;
		const context = { agent: { slug: 'guide-steward', execution: { sandboxMode: 'workspace_write', allowedPaths: ['src/content/**'] } },
			capacity: { assignmentId: 'assignment-a', assignment: { id: 'assignment-a' }, envelope: {}, decisionInput: {}, workspaceAccessMode: 'workspace_write' },
			execution: { start: async (input: { agent: Record<string, unknown> }) => { executionAgent = input.agent; return { status: 'completed', summary: 'done', outputs: {}, artifacts: [] }; } } } as never;
		await writerHandler.execute(context, { payload: {}, subject: { model: 'objective', id: 'core', title: 'Core' }, artifactKind: 'agent_note', nextMessageTypes: [],
			workPackage: { kind: 'writer', title: 'Write', summary: 'Write', instructions: 'Write', context: {}, expectedOutputs: [],
				constraints: { mode: 'acting', requiredCapabilities: [], allowedPaths: ['src/content/**'], forbiddenPaths: [], metadata: {} }, metadata: {} } } as never);
		expect(executionAgent).toMatchObject({ execution: { sandboxMode: 'workspace_write', allowedPaths: ['src/content/**'] } });
	});

	it('uses assignment content architecture instead of inferring from provider-local paths', () => {
		const context = {
			repoRoot: '/provider/data/assignment-contexts/project-a',
			capacity: {
				assignment: {
					metadata: { contentRoot: 'template/src/content' },
					workspaceContext: { project: { architecture: { contentPath: 'template/src/content' } } },
				},
			},
		} as never;
		expect(executionContentRoot(context, {})).toBe('template/src/content');
		expect(executionContentRoot(context, { contentRoot: 'configured/content' })).toBe('configured/content');
	});

	it('resolves content extensions in order without batching a missing alternative', async () => {
		const reads: string[][] = [];
		const context = {
			repoRoot: '/provider/data/assignment-contexts/project-a',
			agent: { slug: 'architect', context: { queries: [] } },
			capacity: {
				assignmentId: 'assignment-a',
				treedxProxyHandle: { repositoryId: 'repo-a' },
				assignment: { metadata: { contentRoot: 'template/src/content' } },
			},
			treeDx: {
				async readRepositoryFiles(input: { paths: string[] }) {
					reads.push(input.paths);
					const path = input.paths[0]!;
					return { payload: { files: [{ path, text: `content for ${path}` }] } };
				},
			},
		} as never;
		const result = await resolveExecutionTreeDxContext(context, { model: 'objective', id: 'objective-a', title: 'Objective A' }, { objectiveId: 'objective-a' });
		expect(reads).toEqual([
			['template/src/content/objectives/objective-a.mdx'],
			['template/src/content/agents/architect.mdx'],
		]);
		expect(result.assignedObjective).toMatchObject({ path: 'template/src/content/objectives/objective-a.mdx' });
		expect(result.diagnostics.warnings).toEqual([]);
	});

	it('reads assignment-authoritative objective and agent paths before compatibility candidates', async () => {
		const reads: string[] = [];
		const context = {
			repoRoot: '/provider/data/assignment-contexts/market',
			agent: { slug: 'guide-steward', activityType: 'planning', context: { queries: [] } },
			capacity: { assignmentId: 'assignment-guide', treedxProxyHandle: { repositoryId: 'repo-market' },
				assignment: { metadata: { contentRoot: 'src/content', agentContentPath: 'src/content/agents/editorial/guide-steward.mdx' } } },
			treeDx: { async readRepositoryFiles(input: { paths: string[] }) {
				const path = input.paths[0]!; reads.push(path);
				return { payload: { files: [{ path, text: `content for ${path}`, sha: 'a'.repeat(40) }] } };
			} },
		} as never;
		await resolveExecutionTreeDxContext(context,
			{ model: 'objective', id: 'core', title: 'Core', path: 'src/content/objectives/core.md' },
			{ objectiveId: 'core', subjectPath: 'src/content/objectives/core.md' });
		expect(reads).toContain('src/content/objectives/core.md');
		expect(reads).toContain('src/content/agents/editorial/guide-steward.mdx');
		expect(reads).not.toContain('src/content/objectives/core.mdx');
		expect(reads).not.toContain('src/content/agents/guide-steward.mdx');
	});

	it('discovers repository paths before reading and never probes an absent extension', async () => {
		const reads: string[] = [];
		const paths = [
			'src/content/objectives/core.md',
			'src/content/notes/editorial/core.mdx',
			'src/content/notes/editorial/books/treeseed-guide/core.mdx',
			'src/content/agents/editorial/guide-steward.mdx',
		];
		const result = await resolveExecutionTreeDxContext({
			repoRoot: '/provider/data/assignment-contexts/market',
			agent: { slug: 'guide-steward', activityType: 'planning', context: { queries: [] } },
			capacity: { assignmentId: 'assignment-guide', treedxProxyHandle: { repositoryId: 'repo-market' },
				assignment: { metadata: { contentRoot: 'src/content' } } },
			treeDx: {
				async listRepositoryPaths() { return { entries: paths.map((path) => ({ path })) }; },
				async buildContext() { return { results: [] }; },
				async readRepositoryFiles(input: { paths: string[] }) {
					const path = input.paths[0]!; reads.push(path);
					return { payload: { files: [{ path, text: `content for ${path}`, sha: 'a'.repeat(40) }] } };
				},
			},
		} as never, { model: 'objective', id: 'core', title: 'Core' }, { objectiveId: 'core' });
		expect(reads).toEqual(paths);
		expect(reads).not.toContain('src/content/objectives/core.mdx');
		expect(result.diagnostics.warnings).toEqual([]);
	});

	it('compiles revision-pinned editorial layers through TreeDX for Guide agents', async () => {
		const context = {
			repoRoot: '/provider/data/assignment-contexts/market',
			agent: { slug: 'guide-writer', activityType: 'acting', context: { queries: [] } },
			capacity: { assignmentId: 'assignment-guide', treedxProxyHandle: { repositoryId: 'repo-market' },
				assignment: { metadata: { contentRoot: 'src/content' } } },
			treeDx: {
				async readRepositoryFiles(input: { paths: string[] }) {
					const path = input.paths[0]!;
					return { payload: { files: [{ path, text: `editorial content for ${path}`, sha: path.includes('/core.') ? 'a'.repeat(40) : 'b'.repeat(40) }] } };
				},
			},
		} as never;
		const result = await resolveExecutionTreeDxContext(context,
			{ model: 'knowledge', id: 'guide.deployment.knowledge', title: 'Knowledge',
				path: 'src/content/knowledge/treeseed-guide/deployment/knowledge.md' },
			{ bookId: 'treeseed-guide' });
		expect(result.editorialContext?.layers.map((layer) => layer.kind)).toEqual([
			'core-objective', 'project-core', 'book-core', 'chapter-brief', 'target-page', 'assignment',
		]);
		expect(result.editorialContext?.digest).toMatch(/^[a-f0-9]{64}$/u);
		expect(result.diagnostics).toMatchObject({ editorialContextSchemaVersion: 'treeseed.editorial-context/v1',
			declarativeContextPackCount: 1 });
	});

	it('allows Guide planning to orient from the editorial cores before a chapter is selected', async () => {
		const context = {
			repoRoot: '/provider/data/assignment-contexts/market',
			agent: { slug: 'guide-steward', activityType: 'planning', context: { queries: [] } },
			capacity: { assignmentId: 'assignment-guide-plan', treedxProxyHandle: { repositoryId: 'repo-market' },
				assignment: { metadata: { contentRoot: 'src/content' } } },
			treeDx: {
				async readRepositoryFiles(input: { paths: string[] }) {
					const path = input.paths[0]!;
					return { payload: { files: [{ path, text: `editorial content for ${path}`, sha: 'a'.repeat(40) }] } };
				},
			},
		} as never;
		const result = await resolveExecutionTreeDxContext(context,
			{ model: 'objective', id: 'core', title: 'Core TreeSeed Objective' },
			{ objectiveId: 'core' });
		expect(result.editorialContext?.layers.map((layer) => layer.kind)).toEqual([
			'core-objective', 'project-core', 'book-core', 'assignment',
		]);
	});

	it('gives the provider the assignment-owned content root and exact subject relation', () => {
		const instructions = buildExecutionContentInstructions({
			agent: { systemPrompt: 'Architect prompt.' },
			capacity: { mode: 'acting', assignmentId: 'assignment-a' },
		} as never, {
			payload: { decisionId: 'decision-a' },
			subject: { model: 'decision', id: 'decision-a', title: 'Decision A' },
			artifactKind: 'architecture_plan',
			contextPackSummaries: [],
			assignedObjective: null,
			contentRoot: 'template/src/content',
		});
		expect(instructions).toContain('Content root: template/src/content');
		expect(instructions).toContain('exact changedPaths entry back as placement.path');
		expect(instructions).toContain('Never batch-read inferred repository paths');
		expect(instructions).toContain('commit exactly once as the final mutating action');
		expect(instructions).toContain('"field":"relatedDecisions"');
		expect(instructions).not.toContain('Content root: src/content');
	});

	it('distinguishes red-proof work from post-implementation verification', () => {
		const instructionsFor = (artifactKind: string) => buildExecutionContentInstructions({
			agent: { systemPrompt: 'Tester prompt.' },
			capacity: { mode: 'acting', assignmentId: 'assignment-a' },
		} as never, {
			payload: {},
			subject: { model: 'decision', id: 'decision-a', title: 'Decision A' },
			artifactKind,
			contextPackSummaries: [],
			assignedObjective: null,
			contentRoot: 'template/src/content',
		});
		expect(instructionsFor('failing_test_proof')).toContain('nonzero expected exit code');
		expect(instructionsFor('failing_test_proof')).toContain('Checkpoint the authored test');
		expect(instructionsFor('passing_verification')).toContain('expected exit code 0');
		expect(instructionsFor('passing_verification')).toContain('Do not create a new red test');
		expect(instructionsFor('passing_verification')).toContain('or create a source checkpoint');
		expect(instructionsFor('review_decision')).toContain('authenticated governedPredecessorEvidence');
		expect(instructionsFor('review_decision')).toContain('Do not require documentation, release readiness');
		const requiredRevision = buildExecutionContentInstructions({
			agent: { systemPrompt: 'Reviewer prompt.' },
			capacity: { mode: 'acting', assignmentId: 'assignment-a' },
		} as never, {
			payload: { governedReviewPolicy: { requireRevisionCycle: true, completedRevisionCycles: 0, requiredDisposition: 'rejected' } },
			subject: { model: 'decision', id: 'decision-a', title: 'Decision A' },
			artifactKind: 'review_decision',
			contextPackSummaries: [],
			assignedObjective: null,
			contentRoot: 'template/src/content',
		});
		expect(requiredRevision).toContain('requires this initial review to reject once');
		expect(requiredRevision).toContain('Do not invent a downstream prerequisite');
	});

	it('gives every governed research stage its authenticated output contract', () => {
		const instructionsFor = (researchStage: string) => buildExecutionContentInstructions({
			agent: { systemPrompt: 'Research prompt.' },
			capacity: { mode: 'planning', assignmentId: 'assignment-research' },
		} as never, {
			payload: {
				researchStage, minimumIndependentSources: 2, maxRevisionCycles: 3,
				latestReviewAttempt: { reason: 'The prior claim exceeded the cited evidence.' },
			},
			subject: { model: 'question', id: 'question-a', title: 'Question A' },
			artifactKind: researchStage === 'question-decomposition' ? 'planning_question'
				: researchStage === 'cited-knowledge-publication' ? 'knowledge_page' : 'planning_note',
			contextPackSummaries: [],
			assignedObjective: null,
			contentRoot: 'template/src/content',
		});
		expect(instructionsFor('question-decomposition')).toContain('Create a new question model artifact');
		expect(instructionsFor('question-decomposition')).toContain('A note cannot satisfy the required planning_question artifact');
		expect(instructionsFor('independent-source-fetch')).toContain('research.fetch_source');
		expect(instructionsFor('independent-source-fetch')).toContain('claimIds ["claim-1"]');
		expect(instructionsFor('claim-synthesis')).toContain('treeseed.research_claims');
		expect(instructionsFor('claim-synthesis')).toContain('status is "unsupported"');
		expect(instructionsFor('citation-review-rejection')).toContain('disposition "rejected"');
		expect(instructionsFor('revision')).toContain('at most 3 revision cycles');
		expect(instructionsFor('revision')).toContain('The prior claim exceeded the cited evidence.');
		expect(instructionsFor('revision')).toContain('exact text is no broader than facts established');
		expect(instructionsFor('citation-review-approval')).toContain('disposition "approved"');
	});

	it('rejects a content link that contains no validated relation', async () => {
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000',
			providerAccessToken: 'redacted',
			assignmentId: 'assignment-a',
			descriptor: {
				id: 'treeseed.content.link', handleId: 'handle-a', routes: {},
				metadata: { contentAction: 'link', contentRoot: 'template/src/content' },
			} as never,
			input: { model: 'note', slug: 'architecture-plan', relations: [] },
		});
		expect(result).toMatchObject({ ok: false, code: 'content_relation_required' });
	});

	it('keeps model-aware writes under the transported assignment root when given a path-shaped slug', async () => {
		const urls: string[] = [];
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000',
			providerAccessToken: 'redacted',
			assignmentId: 'assignment-a',
			descriptor: {
				id: 'treeseed.content.create',
				handleId: 'handle-a',
				projectId: 'project-a',
				assignmentId: 'assignment-a',
				workspaceId: 'workspace-a',
				allowedOperations: ['files:write', 'files:read'],
				allowedPaths: ['template/src/content/**'],
				routes: {
					applyWorkspaceChangeset: 'POST /v1/dx/projects/project-a/workspaces/workspace-a/changesets',
					readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path',
				},
				metadata: { contentAction: 'create', contentRoot: 'template/src/content', baseCommitSha: 'abc123', baseRef: 'refs/heads/main' },
			} as never,
			input: {
				model: 'note',
				slug: 'template/src/content/notes/release-channel-evidence.mdx',
				title: 'Release channel evidence',
				body: 'Evidence body.',
				relations: [{ field: 'relatedDecisions', targetSlug: 'normalize-release-channel-inputs' }],
			},
			fetchImpl: (async (url) => {
				urls.push(String(url));
				return new Response(JSON.stringify({ ok: true, payload: {} }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}) as typeof fetch,
		});
		expect(result).toMatchObject({
			ok: true,
			changedPaths: ['template/src/content/notes/release-channel-evidence.mdx'],
		});
		expect(urls).toHaveLength(2);
		expect(urls.some((url) => url.includes('path=template%2Fsrc%2Fcontent%2Fnotes%2Frelease-channel-evidence.mdx'))).toBe(true);
		expect(urls.some((url) => url.includes('/changesets'))).toBe(true);
	});

	it('accepts a canonical placement path without duplicating the content root and collection', async () => {
		const urls: string[] = [];
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: {
				id: 'treeseed.content.create', handleId: 'handle-a', projectId: 'project-a',
				assignmentId: 'assignment-a', workspaceId: 'workspace-a',
				allowedOperations: ['files:write', 'files:read'], allowedPaths: ['src/content/**'],
				routes: {
					applyWorkspaceChangeset: 'POST /v1/dx/projects/project-a/workspaces/workspace-a/changesets',
					readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path',
				},
				metadata: { contentAction: 'create', contentRoot: 'src/content', baseCommitSha: 'abc123', baseRef: 'refs/heads/main' },
			} as never,
			input: {
				model: 'note', slug: 'audience-review-plan', title: 'Audience review plan', body: 'Review body.',
				placement: { path: 'src/content/notes/editorial/books/treeseed-guide/reviews/audience-review-plan.mdx' },
				relations: [{ field: 'about', targetSlug: 'objective:core' }],
			},
			fetchImpl: (async (url) => {
				urls.push(String(url));
				return new Response(JSON.stringify({ ok: true, payload: {} }), {
					status: 200, headers: { 'content-type': 'application/json' },
				});
			}) as typeof fetch,
		});
		expect(result).toMatchObject({
			ok: true,
			changedPaths: ['src/content/notes/editorial/books/treeseed-guide/reviews/audience-review-plan.mdx'],
		});
		expect(urls.some((url) => url.includes('path=src%2Fcontent%2Fnotes%2Feditorial%2Fbooks%2Ftreeseed-guide%2Freviews%2Faudience-review-plan.mdx'))).toBe(true);
		expect(urls.some((url) => url.includes('/changesets'))).toBe(true);
	});

	it('preserves a canonical Guide knowledge path through model-aware creation', async () => {
		const urls: string[] = [];
		const path = 'src/content/knowledge/treeseed-guide/foundation/agent-lab-guide-writing.mdx';
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: { id: 'treeseed.content.create', handleId: 'handle-a', projectId: 'project-a', assignmentId: 'assignment-a', workspaceId: 'workspace-a', allowedOperations: ['files:write', 'files:read'], allowedPaths: ['src/content/**'], routes: { applyWorkspaceChangeset: 'POST /v1/dx/projects/project-a/workspaces/workspace-a/changesets', readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path' }, metadata: { contentAction: 'create', contentRoot: 'src/content', baseCommitSha: 'abc123', baseRef: 'refs/heads/main' } } as never,
			input: { model: 'knowledge', slug: 'agent-lab-guide-writing', title: 'Agent Lab Guide Writing', placement: { path }, body: 'Guide body.' },
			fetchImpl: (async (url) => { urls.push(String(url)); return new Response(JSON.stringify({ ok: true, payload: {} }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as typeof fetch,
		});
		expect(result).toMatchObject({ ok: true, changedPaths: [path] });
		expect(urls.some((url) => url.includes(`path=${encodeURIComponent(path)}`))).toBe(true);
		expect(urls.some((url) => url.includes('/changesets'))).toBe(true);
	});

	it('reads the assigned agent from its authoritative nested content path', async () => {
		const urls: string[] = [];
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: {
				id: 'treeseed.content.read', handleId: 'handle-a', projectId: 'project-a', assignmentId: 'assignment-a', workspaceId: 'workspace-a',
				allowedOperations: ['files:read'], allowedPaths: ['src/content/**'],
				routes: { readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path' },
				metadata: { contentAction: 'read', contentRoot: 'src/content', agentSlug: 'guide-steward', agentContentPath: 'src/content/agents/editorial/guide-steward.mdx' },
			} as never,
			input: { model: 'agent', id: 'guide-steward' },
			fetchImpl: (async (url) => {
				urls.push(String(url));
				return new Response(JSON.stringify({ ok: true, payload: { content: 'Guide Steward' } }), { status: 200, headers: { 'content-type': 'application/json' } });
			}) as typeof fetch,
		});
		expect(result).toMatchObject({ ok: true, refs: [{ path: 'src/content/agents/editorial/guide-steward.mdx' }] });
		expect(urls).toHaveLength(1);
		expect(urls[0]).toContain('path=src%2Fcontent%2Fagents%2Feditorial%2Fguide-steward.mdx');
	});

	it('reads a hierarchically placed content record from its explicit receipt path', async () => {
		const urls: string[] = [];
		const path = 'src/content/notes/editorial/books/treeseed-guide/planning/stewardship/run-note.mdx';
		const result = await callContentTool({ apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: { id: 'treeseed.content.read', handleId: 'handle-a', projectId: 'project-a', assignmentId: 'assignment-a', workspaceId: 'workspace-a', allowedOperations: ['files:read'], allowedPaths: ['src/content/**'], routes: { readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path' }, metadata: { contentAction: 'read', contentRoot: 'src/content' } } as never,
			input: { model: 'note', path }, fetchImpl: (async (url) => { urls.push(String(url)); return new Response(JSON.stringify({ ok: true, payload: { content: 'Run note' } }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as typeof fetch });
		expect(result).toMatchObject({ ok: true, refs: [{ path }] });
		expect(urls[0]).toContain(encodeURIComponent(path));
	});

	it('validates the existing record at an exact hierarchical placement', async () => {
		const urls: string[] = [];
		const existing = renderContentRecord({
			model: 'note', title: 'Technical review plan', body: 'Review body.',
			relations: [{ field: 'relatedObjectives', targetSlug: 'objective:core' }],
		});
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: {
				id: 'treeseed.content.validate', handleId: 'handle-a', projectId: 'project-a',
				assignmentId: 'assignment-a', workspaceId: 'workspace-a',
				allowedOperations: ['files:read'], allowedPaths: ['src/content/**'],
				routes: { readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path' },
				metadata: { contentAction: 'validate', contentRoot: 'src/content' },
			} as never,
			input: {
				model: 'note',
				placement: { path: 'src/content/notes/editorial/books/treeseed-guide/reviews/technical-review-plan.mdx' },
			},
			fetchImpl: (async (url) => {
				urls.push(String(url));
				return new Response(JSON.stringify({ ok: true, payload: { content: existing.content } }), {
					status: 200, headers: { 'content-type': 'application/json' },
				});
			}) as typeof fetch,
		});

		expect(result).toMatchObject({
			ok: true,
			refs: [{ path: 'src/content/notes/editorial/books/treeseed-guide/reviews/technical-review-plan.mdx' }],
		});
		expect(urls).toHaveLength(1);
	});

	it('validates persisted relations from an exact existing record when the request only repeats identity and relations', async () => {
		const existing = renderContentRecord({
			model: 'note', title: 'Workday report', body: 'Durable report body.',
			relations: [{ field: 'relatedObjectives', targetSlug: 'objective:core' }],
		});
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: { content: existing.content } }), {
			status: 200, headers: { 'content-type': 'application/json' },
		}));
		const path = 'src/content/notes/editorial/books/treeseed-guide/reports/workday-report.mdx';
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: {
				id: 'treeseed.content.validate', handleId: 'handle-a', projectId: 'project-a', assignmentId: 'assignment-a', workspaceId: 'workspace-a',
				allowedOperations: ['files:read'], allowedPaths: ['src/content/**'],
				routes: { readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path' },
				metadata: { contentAction: 'validate', contentRoot: 'src/content' },
			} as never,
			input: {
				model: 'note', id: 'note:workday-report', slug: 'workday-report', placement: { path },
				relations: [{ field: 'relatedObjectives', targetModel: 'objective', targetSlug: 'core' }],
			},
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(result).toMatchObject({ ok: true, refs: [{ path }] });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('preflights a proposed record at an exact placement without requiring the file to exist', async () => {
		const path = 'src/content/notes/editorial/books/treeseed-guide/reviews/proposed-review.mdx';
		const fetchImpl = vi.fn(async () => { throw new Error('preflight validation must not read a missing workspace file'); });
		const result = await callContentTool({
			apiBaseUrl: 'http://127.0.0.1:3000', providerAccessToken: 'redacted', assignmentId: 'assignment-a',
			descriptor: {
				id: 'treeseed.content.validate', handleId: 'handle-a', projectId: 'project-a', assignmentId: 'assignment-a', workspaceId: 'workspace-a',
				allowedOperations: ['files:read'], allowedPaths: ['src/content/**'],
				routes: { readWorkspaceFile: 'GET /v1/dx/projects/project-a/workspaces/workspace-a/files?path=:path' },
				metadata: { contentAction: 'validate', contentRoot: 'src/content' },
			} as never,
			input: {
				model: 'note', title: 'Proposed technical review', body: 'Review body.',
				relations: [{ field: 'relatedObjectives', targetModel: 'objective', targetSlug: 'objective:core' }],
				placement: { path },
			},
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(result).toMatchObject({ ok: true, refs: [expect.objectContaining({ path })] });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
