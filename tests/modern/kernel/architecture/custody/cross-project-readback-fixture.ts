import { createHash } from 'node:crypto';
import { assignmentAttemptSchema, assignmentResultSchema, executionEdgeSchema, executionNodeSchema } from '@treeseed/sdk/agent-capacity';
import { exactDependencyLinkSchema } from '@treeseed/sdk/content-validation';
import { request } from '../../provider-kernel-fixture.ts';
import { exactFileKey } from '../../../../acceptance/workday/support/cross-project-custody.ts';
import type { Row } from '../../../../acceptance/acceptance-cli.ts';

// Supplied UNIT inputs only. No API admission, actual review, relation creation,
// provider charge, native clocks or physical closure evidence is manufactured.
export function crossProjectReadbackInputs() {
	const original = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	const source = (project: string) => ({ store: 'treedx' as const, model: 'proposal', id: `${project}-proposal`,
		revision: 1, digest: `sha256:${'c'.repeat(64)}`, repository: `${project}-library`, commit: 'a'.repeat(40), path: 'proposals/work.md' });
	const decisionRef = { store: 'treedx' as const, model: 'decision', id: 'review-approval', repository: 'precursor-library',
		commit: 'b'.repeat(40), path: 'decisions/review-approval.md' };
	const attempts = ['actor', 'review', 'dependent'].map((id, index) => {
		const project = index < 2 ? 'precursor' : 'dependent', reviewing = id === 'review';
		const createdAt = `2026-09-13T12:00:0${index * 2}.000Z`;
		const workspace = reviewing ? { mode: 'treedx', repository: 'precursor-library', baseCommit: 'a'.repeat(40), workspaceId: 'review-workspace', writablePaths: [decisionRef.path] }
			: { mode: 'git', repository: `treeseed-ai/${project}`, baseCommit: 'a'.repeat(40), branch: `simulation/fixture/${id}`, writablePaths: ['src'] };
		return assignmentAttemptSchema.parse({ ...original, id, idempotencyKey: id, projectId: project, nodeId: id, workItemId: 'bounded-work',
			createdAt, deadline: '2026-09-13T12:00:30.000Z', sourceRef: source(project), workspace,
			contextRefs: id === 'dependent' ? [decisionRef, { store: 'git', model: 'repository', id: 'dependent-source', repository: 'treeseed-ai/dependent', commit: 'a'.repeat(40) }] : [], predecessorResultIds: id === 'review' ? ['result-actor'] : id === 'dependent' ? ['result-actor', 'result-review'] : [],
			effectiveProfile: { ...original.effectiveProfile, profileRef: { ...original.effectiveProfile.profileRef, id: reviewing ? 'configured-independent-auditor' : 'configured-bounded-builder' }, activity: reviewing ? 'reviewing' : 'acting', handler: reviewing ? 'reviewer' : 'actor',
				permissionCeiling: { content: { read: ['proposal', 'decision'], write: reviewing ? ['decision'] : [] }, tools: reviewing ? ['source.read'] : ['source.read', 'source.write'] } },
			grant: { contentRead: id === 'dependent' ? [decisionRef] : [], contentWrite: reviewing ? [decisionRef] : [],
				sourceRead: [`treeseed-ai/${project}`], sourceWrite: reviewing ? [] : [`treeseed-ai/${project}`], tools: reviewing ? ['source.read'] : ['source.read', 'source.write'] } });
	});
	const items: Row[] = attempts.map((attempt, index) => ({ id: attempt.id, projectId: attempt.projectId, workDayId: attempt.workdayId,
		executionNodeId: attempt.nodeId, executionNodeRevision: attempt.nodeRevision, status: 'completed', createdAt: attempt.createdAt,
		completedAt: `2026-09-13T12:00:0${index * 2 + 1}.000Z`, assignmentAttempt: attempt,
		assignmentResult: assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${attempt.id}`, assignmentId: attempt.id,
			status: 'completed', summary: 'Supplied exact readback assertion input.', references: attempt.id === 'review'
				? [{ kind: 'treedx', projectId: 'precursor', repository: decisionRef.repository, commit: decisionRef.commit, path: decisionRef.path }]
				: [{ kind: 'git', repository: `treeseed-ai/${attempt.projectId}`, commit: 'b'.repeat(40) }],
			verification: [], usage: { elapsedSeconds: 1, native: { activeSeconds: 1 } }, diagnostics: [], completedAt: `2026-09-13T12:00:0${index * 2 + 1}.000Z` }) }));
	const nodes = attempts.map(attempt => executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: attempt.nodeId,
		teamId: attempt.teamId, projectId: attempt.projectId, workdayId: attempt.workdayId, workItemId: attempt.workItemId,
		kind: attempt.id === 'review' ? 'reviewing' : 'acting', pairRole: attempt.id === 'review' ? 'reviewer' : 'actor', sourceRef: attempt.sourceRef,
		authorityRefs: attempt.authorityRefs, ruleRevision: 1, nodeRevision: 1, agentClass: attempt.agentClass, status: 'completed',
		estimate: attempt.estimate, requiredCapabilities: [], requestedPermissions: attempt.effectiveProfile.permissionCeiling,
		workspace: attempt.id === 'review' ? 'treedx' : 'git', acceptanceCriteria: attempt.acceptanceCriteria,
		maximumReviewCycles: 2, graphRevisionCreated: 1, graphRevisionUpdated: 1 }));
	const link = exactDependencyLinkSchema.parse({ relation: 'depends_on', from: { ...source('precursor'), anchor: 'work-item/bounded-work' }, to: { ...source('dependent'), anchor: 'work-item/bounded-work' } });
	const content = ' # Governed exact dependency note\n', noteRef = { store: 'treedx' as const, model: 'note', id: 'dependency-note',
		repository: 'precursor-library', commit: 'd'.repeat(40), path: 'notes/dependency.md', digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
	const edge = (id: string, fromNodeId: string, toNodeId: string, provenance: 'review-pair' | 'treedx-link') => executionEdgeSchema.parse({
		schemaVersion: 'treeseed.execution-edge/v1', id, teamId: original.teamId, fromNodeId, toNodeId, provenance,
		sourceRef: provenance === 'treedx-link' ? noteRef : source('precursor'), graphRevisionCreated: 1 });
	const graph = { teamId: original.teamId, revision: 1, digest: `sha256:${'e'.repeat(64)}`, nodes,
		edges: [edge('paired', 'actor', 'review', 'review-pair'), edge('cross', 'review', 'dependent', 'treedx-link')] };
	const notes = new Map<string, Row>([[exactFileKey(noteRef), { path: noteRef.path, content, frontmatter: { schemaVersion: 'treeseed.note/v1',
		id: noteRef.id, projectId: 'precursor', classification: 'general', subjectRefs: [link.from, link.to], body: content, createdAt: original.createdAt, links: [link] } }]]);
	const decisions = new Map<string, Row>([[exactFileKey(decisionRef), { path: decisionRef.path, frontmatter: { schemaVersion: 'treeseed.decision/v1',
		id: decisionRef.id, projectId: 'precursor', decisionClass: 'work-review', decisionMethod: 'authority', disposition: 'approved',
		subjectRef: { store: 'git', model: 'source', id: 'candidate', repository: 'treeseed-ai/precursor', commit: 'b'.repeat(40) },
		authorityRefs: [source('precursor')], decidedByRefs: [attempts[1]!.effectiveProfile.profileRef], rationale: 'Supplied independent approval assertion input.', decidedAt: items[1]!.completedAt } }]]);
	return { graph, items, notes, decisions, noteRef, decisionRef, link };
}
