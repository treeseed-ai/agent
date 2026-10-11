import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse, parseDocument, visit } from 'yaml';
import { exactEntityReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { read, row, type Row } from '../../acceptance-cli.ts';

function verifyDecisionFile(reference: Row, file: Row, code: string): Row {
	assert.ok(exactEntityReferenceSchema.safeParse(reference).success && reference.store === 'treedx'
		&& reference.model === 'decision' && reference.id && reference.revision && reference.digest
		&& reference.repository && reference.commit && reference.path, `${code}_SOURCE: Exact Decision authority required`);
	assert.ok(file.path === reference.path && typeof file.content === 'string' && Buffer.byteLength(file.content) <= 1_048_576
		&& `sha256:${createHash('sha256').update(file.content).digest('hex')}` === reference.digest,
		`${code}_BYTES: Original untrimmed Decision bytes must match issued authority`);
	const match = file.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
	assert.ok(match, `${code}_BYTES: Original Decision frontmatter required`);
	const document = parseDocument(match[1]);
	assert.equal(document.errors.length, 0, `${code}_BYTES: Unambiguous Decision YAML required`);
	visit(document, (_key, node) => {
		if (node && typeof node === 'object' && 'anchor' in node) assert.ok(!node.anchor, `${code}_BYTES: Anchored Decision YAML denied`);
	});
	const content = row(document.toJS({ maxAliasCount: 0 }));
	assert.deepEqual(content, file.frontmatter, `${code}_READBACK: Parsed Decision view contradicts original bytes`);
	assert.ok(content.schemaVersion === 'treeseed.decision/v1' && content.id === reference.id,
		`${code}_CONTENT: Original exact Decision identity required`);
	return file;
}

/** Shared by the original CLI consumer and native public library-read proof. */
export function verifyGovernedDecisionRead(reference: Row, returned: Row, code: string): Row {
	assert.ok(returned.ok === true && returned.repoId === reference.repository && returned.resolvedRef === reference.commit
		&& Array.isArray(returned.files) && returned.files.length === 1,
		`${code}_READBACK: Complete exact owning Decision inventory required`);
	return verifyDecisionFile(reference, row(returned.files[0]), code);
}

export function readGovernedContentFile(reference: Row, projectId: string, team: string, cache: Map<string, Row>, code: string): Row {
	assert.ok(reference.repository && reference.path && reference.commit, `${code}_SOURCE: Native exact content readback required`);
	const key = JSON.stringify([reference.repository, reference.commit, reference.path]);
	let content = cache.get(key);
	if (!content) {
		const returned = read(['library', 'read', projectId, String(reference.path), '--ref', String(reference.commit)], team, true);
		const observed = row(returned.result ?? returned);
		const file = Array.isArray(observed.files) ? observed.files.map(row).find(item => item.path === reference.path) : undefined;
		assert.ok(observed.resolvedRef === reference.commit && file, `${code}_READBACK: Exact returned commit and path required`);
		content = reference.model === 'decision' ? verifyGovernedDecisionRead(reference, observed, code) : file;
		cache.set(key, content);
	}
	if (reference.model === 'decision') verifyDecisionFile(reference, content, code);
	return content;
}

export function readDecisionContent(reference: Row, projectId: string, team: string, cache: Map<string, Row>, code: string): Row {
	return row(readGovernedContentFile(reference, projectId, team, cache, code).frontmatter);
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

// Acceptance assertion only. Writer finding references omit the commit while
// being published in the same batch as their owning Decision; resolve that
// existing representation, without adding a new receipt or Note revision field.
export function verifyReviewFindingContent(reference: Row, decisionReference: Row, decision: Row, file: Row, review: Row, code: string): Row {
	assert.ok(exactEntityReferenceSchema.safeParse(reference).success && reference.store === 'treedx'
		&& reference.model === 'note' && reference.repository && reference.path && reference.id
		&& Number.isInteger(reference.revision) && Number(reference.revision) > 0 && typeof reference.digest === 'string',
		`${code}_FINDING_REFERENCE: Exact versioned finding authority required`);
	const commit = reference.commit ?? decisionReference.commit, result = row(review.assignmentResult), attempt = row(review.assignmentAttempt);
	assert.ok(typeof commit === 'string' && /^[a-f0-9]{40}$/u.test(commit) && result.assignmentId === review.id && result.status === 'completed'
		&& Array.isArray(result.references) && result.references.map(row).some(value => value.kind === 'treedx'
			&& value.projectId === review.projectId && value.repository === reference.repository && value.path === reference.path && value.commit === commit),
		`${code}_FINDING_OWNER: Finding must be returned by this exact completed Reviewer result`);
	const targets = row(attempt.grant).contentWrite;
	assert.ok(Array.isArray(targets) && targets.map(row).filter(value => value.store === 'treedx' && value.model === 'note'
		&& value.id === reference.id && value.repository === reference.repository && value.path === reference.path
		&& (value.revision ?? 1) === reference.revision).length === 1, `${code}_FINDING_GRANT: Exact original finding target required`);
	assert.ok(file.path === reference.path && typeof file.content === 'string', `${code}_FINDING_BYTES: Native raw finding bytes required`);
	assert.equal(`sha256:${createHash('sha256').update(file.content).digest('hex')}`, reference.digest,
		`${code}_FINDING_DIGEST: Untrimmed native bytes must match the Decision finding reference`);
	const match = file.content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
	assert.ok(match, `${code}_FINDING_BYTES: Canonical native Markdown required`);
	const frontmatter = row(parse(match[1]!)), body = match[2]!.trim();
	assert.deepEqual(frontmatter, file.frontmatter, `${code}_FINDING_READBACK: Parsed and raw native observations must agree`);
	if (file.body !== undefined) assert.equal(file.body, body, `${code}_FINDING_READBACK: Native body observation drifted`);
	const parsed = validatePortableContentData('note', { ...frontmatter, body });
	assert.ok(parsed.ok, `${code}_FINDING_CONTENT: Complete canonical feedback Note required`);
	const finding = row(parsed.data);
	assert.equal(finding.id, reference.id, `${code}_FINDING_ID: Exact finding identity required`);
	assert.equal(finding.projectId, review.projectId, `${code}_FINDING_PROJECT: Finding project drifted`);
	assert.equal(finding.classification, 'feedback', `${code}_FINDING_CLASS: Actual Reviewer feedback required`);
	assert.deepEqual(finding.subjectRefs, [decision.subjectRef], `${code}_FINDING_SUBJECT: Finding must bind the same original Actor artifact`);
	const created = Date.parse(String(finding.createdAt)), start = Date.parse(String(review.createdAt)), end = Date.parse(String(review.completedAt));
	assert.ok([created, start, end].every(Number.isFinite) && start <= created && created <= end,
		`${code}_FINDING_CLOCK: Original owning review interval required`);
	return finding;
}
