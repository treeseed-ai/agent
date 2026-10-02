import assert from 'node:assert/strict';
import { exactEntityReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { read, row, type Row } from '../acceptance-cli.ts';

export function readDecisionContent(reference: Row, projectId: string, team: string, cache: Map<string, Row>, code: string): Row {
	assert.ok(reference.repository && reference.path && reference.commit, `${code}_SOURCE: Native exact content readback required`);
	const key = JSON.stringify([reference.repository, reference.commit, reference.path]);
	let content = cache.get(key);
	if (!content) {
		const returned = read(['library', 'read', projectId, String(reference.path), '--ref', String(reference.commit)], team, true);
		const observed = row(returned.result ?? returned);
		const file = Array.isArray(observed.files) ? observed.files.map(row).find(item => item.path === reference.path) : undefined;
		assert.ok(observed.resolvedRef === reference.commit && file, `${code}_READBACK: Exact returned commit and path required`);
		content = row(file.frontmatter); cache.set(key, content);
	}
	return content;
}

export function verifyDecisionContent(content: Row, projectId: string, code: string): Row {
	const parsed = validatePortableContentData('decision', content);
	assert.ok(parsed.ok, `${code}_CONTENT: Complete canonical classed Decision required`);
	const decision = row(parsed.data);
	assert.equal(decision.projectId, projectId, `${code}_PROJECT: Decision project authority drifted`);
	for (const refs of [decision.authorityRefs, decision.decidedByRefs]) {
		assert.ok(Array.isArray(refs) && refs.length > 0 && new Set(refs.map(value => JSON.stringify(value))).size === refs.length
			&& refs.every(value => exactEntityReferenceSchema.safeParse(value).success), `${code}_EVIDENCE: Exact unique authority and decision-maker evidence required`);
	}
	if (decision.decisionMethod === 'approval' || decision.decisionMethod === 'vote') {
		assert.ok(Array.isArray(decision.positions) && decision.positions.length > 0 && decision.positions.map(row).every(position =>
			exactEntityReferenceSchema.safeParse(position.actorRef).success && ['approve', 'reject', 'abstain'].includes(String(position.position))
			&& typeof position.recordedAt === 'string' && Number.isFinite(Date.parse(position.recordedAt))), `${code}_POSITIONS: Signed-method evidence required`);
	}
	return decision;
}
