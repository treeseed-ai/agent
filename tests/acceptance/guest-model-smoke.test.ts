import { readFileSync } from 'node:fs';
import { verifyFreezeIntegrity } from './freeze-integrity.ts';
import { verifySandboxGuestImage } from './workday/support/monitoring/provider-history.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { read, row } from './acceptance-cli.ts';

test('Current Codex subscription completes one measured Kata-backed response', () => {
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	const path=process.env.TREESEED_ACCEPTANCE_FREEZE_PATH;assert.ok(path,'ACCEPTANCE_SANDBOX_IMAGE: Original operator freeze path required');
	const freeze=row(JSON.parse(readFileSync(path,'utf8')));verifyFreezeIntegrity(freeze,readFileSync);
	const marker = randomUUID();
	const topic = `guest-model-smoke-${marker}`;
	const host = read(['dev', 'host', 'status'], team, true);
	assert.equal(host.status, 'active', 'ACCEPTANCE_GUEST_MODEL_SMOKE: Development guest must be active');
	assert.match(String(host.guestImageDigest ?? ''), /^sha256:[a-f0-9]{64}$/u,
		'ACCEPTANCE_GUEST_MODEL_SMOKE: Exact guest image digest required');
	assert.equal(host.guestImageDigest,row(freeze.guest).digest,'ACCEPTANCE_SANDBOX_IMAGE: Current host guest differs from frozen image');
	for(const field of ['generationId','manifestDigest','guestImageDigest'])assert.equal(host[field],row(freeze.host)[field],'ACCEPTANCE_SANDBOX_IMAGE: Current host differs from frozen generation');
	const send = read(['send', topic, `@sdk/architect: Reply briefly to this execution smoke check (${marker}). Do not inspect project files.`,
		'--idempotency-key', `guest-model-smoke:${marker}`, '--timeout', '180', '--diagnostics', 'full'], team, false, 210_000);
	assert.equal(send.status, 'complete', 'ACCEPTANCE_GUEST_MODEL_SMOKE: Agent response did not complete');
	const targets = Array.isArray(send.targets) ? send.targets.map(row) : [];
	const target = targets.find(item => item.projectSlug === 'sdk' && item.agentSlug === 'architect');
	assert.equal(target?.status, 'responded', 'ACCEPTANCE_GUEST_MODEL_SMOKE: SDK Architect did not respond');
	const assignmentId = row(target?.capacity).assignmentId;
	assert.match(String(assignmentId ?? ''), /^assignment_[A-Za-z0-9_-]+$/u,
		'ACCEPTANCE_GUEST_MODEL_SMOKE: Real capacity assignment required');
	const traces=row(row(target?.diagnostics).fullPayload).events;assert.ok(Array.isArray(traces),'ACCEPTANCE_SANDBOX_IMAGE: Original protected native trace required');
	const created=traces.map(row).filter(event=>event.type==='sandbox.observed'&&row(event.payload).brokerSequence===0);assert.equal(created.length,1,'ACCEPTANCE_SANDBOX_IMAGE: Exactly one live native creation required');
	const live=row(created[0]!.protectedPayload).sandboxEvent;verifySandboxGuestImage(live,row(freeze.guest).digest);assert.equal(row(live).assignmentId,assignmentId,'ACCEPTANCE_SANDBOX_IMAGE: Foreign native execution');
	const destroyed=traces.map(row).filter(event=>event.type==='sandbox.destroyed');assert.equal(destroyed.length,1,'ACCEPTANCE_SANDBOX_IMAGE: Original native closeout required');
	const native=row(destroyed[0]!.protectedPayload).sandboxEvents;assert.ok(Array.isArray(native)&&native.length>0,'ACCEPTANCE_SANDBOX_IMAGE: Retained native closeout required');verifySandboxGuestImage(native[0],row(freeze.guest).digest);assert.equal(row(native[0]).assignmentId,assignmentId,'ACCEPTANCE_SANDBOX_IMAGE: Foreign native closeout');
	const responses = Array.isArray(send.responses) ? send.responses.map(row) : [];
	assert.ok(responses.some(item => item.projectSlug === 'sdk' && item.agentSlug === 'architect'
		&& typeof item.markdown === 'string' && item.markdown.trim().length > 0),
	'ACCEPTANCE_GUEST_MODEL_SMOKE: Durable nonempty response required');
	const assignment = read(['assignments', 'show', String(assignmentId)], team);
	assert.equal(assignment.status, 'completed', 'ACCEPTANCE_GUEST_MODEL_SMOKE: Assignment must complete');
	assert.equal(assignment.executionKind, 'conversation', 'ACCEPTANCE_GUEST_MODEL_SMOKE: Must execute through the normal conversation path');
	assert.equal(assignment.capacityProviderId, (read(['providers', 'list'], team).items as Record<string, unknown>[])
		.find(item => item.status === 'approved')?.providerId,
	'ACCEPTANCE_GUEST_MODEL_SMOKE: Assignment must use the approved provider');
	const usage = row(row(assignment.assignmentResult).usage);
	assert.ok(Number(row(usage.native).activeSeconds) > 0 && Number(usage.modelOutputTokens) > 0,
		'ACCEPTANCE_GUEST_MODEL_SMOKE: Model execution must have measured active time and output tokens');
});
