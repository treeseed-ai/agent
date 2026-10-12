import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveProviderConfig, loadProviderManifest, loadCapacityProviderIdentity } from '@treeseed/agent/provider-governance';
import { assignmentAttemptSchema, assignmentResultSchema, capabilityAccountingLimitsSchema, remainingCapabilitySeconds } from '@treeseed/sdk/agent-capacity';
import { capabilityOfferDigest, capabilityOfferSchema } from '@treeseed/sdk/capacity-provider';
import { verifyPlatformRepository } from '@treeseed/sdk/platform';
import { acceptanceWorkdayId, read, row, type Row } from '../../acceptance-cli.ts';
import { readWorkdayAssignments, verifyGolden } from '../../sdk-runtime-golden.test.ts';
import { readCompleteEvidence } from './evidence-pages.ts';
export { availabilityHistory } from './monitoring/provider-history.ts';
import { verifyAppliedWorkdayCustody, verifyDerivedWorkdayModes } from './campaign-observation.ts';
import { publicCanonicalRecords, verifyTerminalRecordCustody, verifyFailedExecutionCustody, verifyAvailabilityAccountingHistory, verifySandboxCloseoutCustody, verifyWorkdayContinuationCustody, verifySandboxHostAbsence, verifySandboxDirectoryAbsence, verifyProviderConformanceSignature, verifyProviderQualification, verifyProviderLocalSlotClosure, verifyProviderPollingSelection } from './record-custody.ts';

export function actual(id = acceptanceWorkdayId()) {
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	assert.match(id, /^workday-[a-f0-9-]+$/u, 'ACCEPTANCE_CANONICAL_RUN: Exact native workday required');
	const observed = read(['workdays', 'show', id], team), run = row(observed.run); assert.equal(run.id, id); assert.equal(run.executionMode, 'simulation');
	const items = readWorkdayAssignments(id, String(run.startedAt), team), views: unknown[] = [observed, items], measurements = [];
	assert.ok(items.length > 0);
	for (const item of items) { const shown = read(['assignments', 'show', String(item.id)], team); assert.deepEqual(shown, item); views.push(shown); }
	for (const project of new Set(items.map(item => String(item.projectId)))) {
		assert.ok(project && project !== 'undefined');
		measurements.push(...readCompleteEvidence(['capacity', 'usage', '--project', project, '--workday', id], team, 100, 'ACCEPTANCE_CANONICAL_USAGE'));
		views.push(readCompleteEvidence(['capacity', 'ledger', '--project', project, '--workday', id], team, 100, 'ACCEPTANCE_CANONICAL_LEDGER'));
	}
	return { id, team, run, observed, items, views, measurements };
}
export function verify(f: ReturnType<typeof actual>) {
	verifyAppliedWorkdayCustody(f.run);
	verifyDerivedWorkdayModes(f.run, [...f.views.flat().map(row), ...f.measurements]);
	// Public record shape checks are NOT the whole canonical equivalence gate.
	// Use the original owning SDK repository verifier on the exact existing
	// development authority, with no copied schema or record reconstruction.
	const root = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
	assert.ok(root, 'ACCEPTANCE_CANONICAL_INPUT: Existing exact development authority required');
	const schemaPath = resolve(root, 'docs/agent.schema.yml'), bytes = readFileSync(schemaPath, 'utf8');
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	assert.equal(execFileSync('git', ['show', `${head}:docs/agent.schema.yml`], { cwd: root, encoding: 'utf8' }), bytes);
	const canonical = verifyPlatformRepository(root);
	assert.equal(canonical.ok, true, 'ACCEPTANCE_CANONICAL_EQUIVALENCE: Complete original SDK contract verification must pass before records can be accepted');
	assert.deepEqual(canonical.diagnostics, []);
	for (const item of f.items) {
		assert.deepEqual(assignmentAttemptSchema.parse(item.assignmentAttempt), item.assignmentAttempt,
			'ACCEPTANCE_CANONICAL_RAW: Frozen attempt must already be canonical; parsing cannot repair authority');
		if (item.assignmentResult !== null && item.assignmentResult !== undefined) assert.deepEqual(
			assignmentResultSchema.parse(item.assignmentResult), item.assignmentResult,
			'ACCEPTANCE_CANONICAL_RAW: Completed and failed results must retain their original canonical identities');
	}
	verifyTerminalRecordCustody(f.items, publicCanonicalRecords(f.views, 'treeseed.lease/v1'), publicCanonicalRecords(f.views, 'treeseed.reservation/v1'),
		publicCanonicalRecords(f.views, 'treeseed.usage-settlement/v1'), f.measurements);
	const again = actual(f.id); assert.deepEqual(again.observed, f.observed); assert.deepEqual(again.items, f.items); assert.deepEqual(again.views, f.views); assert.deepEqual(again.measurements, f.measurements);
	assert.deepEqual(verifyPlatformRepository(root), canonical);
	assert.equal(readFileSync(schemaPath, 'utf8'), bytes);
	assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head);
}

