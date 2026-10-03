import assert from 'node:assert/strict';
import { assignmentWorkspaceSchema, effectiveActivityProfileSchema, exactGrantSchema, exactEntityReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { read, row, type Row } from '../acceptance-cli.ts';

/** Independent supported read of the immutable TreeDX workspace, not a
 * substitute for Git worktree, sandbox or provider-session teardown evidence. */
export function verifyTreeDxWorkspaceClosure(item: Row, team: string): void {
	const workspace = assignmentWorkspaceSchema.safeParse(row(item.assignmentAttempt).workspace);
	assert.ok(workspace.success, 'ACCEPTANCE_WORKSPACE_AUTHORITY: Typed immutable workspace required');
	if (workspace.data.mode !== 'treedx') return;
	assert.ok(typeof item.projectId === 'string' && item.projectId, 'ACCEPTANCE_WORKSPACE_AUTHORITY: Exact project required');
	const scope = workspace.data;
	// This existing descriptor owns project context, not a team selector.
	const observed = read(['projects', 'treedx', 'workspaces', 'show', scope.workspaceId, '--project', item.projectId,
		'--server', 'local'], team, true);
	const resource = row(observed.result), receipt = row(observed.receipt);
	assert.ok(resource.workspaceId === scope.workspaceId && resource.repoId === scope.repository
		&& resource.status === 'closed' && receipt.projectId === item.projectId,
		'ACCEPTANCE_WORKSPACE_READBACK: Independent exact project/repository/workspace closed-resource agreement required');
}

/** Presented revoked authority is necessary, not proof of physical resource closure. */
export function verifyTeardownAuthority(item: Row): void {
	const ordinal = row(item.assignmentAttempt).attempt;
	assert.ok(typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal >= 1 && item.attemptCount === ordinal,
		'ACCEPTANCE_USAGE_ATTEMPT: Terminal assignment ordinal must retain its exact immutable attempt');
	const label = 'ACCEPTANCE_TEARDOWN_AUTHORITY';
	const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
	const context = row(item.workspaceContext);
	for (const proxy of [item.treedxProxyHandle, context.treedxProxyHandle]) {
		if (proxy === undefined || proxy === null) continue;
		assert.ok(object(proxy), `${label}: Malformed presented proxy authority`);
		assert.ok(Object.keys(proxy).length === 0 || proxy.status === 'revoked', `${label}: Proxy authority remains issued or unidentified`);
	}
	for (const handles of [item.capabilityHandles, context.capabilityHandles]) {
		if (handles === undefined || handles === null) continue;
		assert.ok(object(handles), `${label}: Malformed presented capability authority`);
		for (const kind of ['repository', 'treeDx', 'workflowOperations', 'secrets']) {
			const entries = handles[kind];
			if (entries === undefined) continue;
			assert.ok(Array.isArray(entries) && entries.every(entry => object(entry) && entry.status === 'revoked'),
				`${label}: Capability authority remains issued or unidentified`);
		}
	}
}

/** Assertions in the existing managed verifier, not a runtime grant compiler.
 * Independent profile/policy retrieval and atomic admission still need proof. */
export function verifyAssignmentAuthority(item: Row): void {
	const attempt = row(item.assignmentAttempt), label = 'ACCEPTANCE_ASSIGNMENT_GRANT';
	const profile = effectiveActivityProfileSchema.safeParse(attempt.effectiveProfile);
	const grant = exactGrantSchema.safeParse(attempt.grant), workspace = assignmentWorkspaceSchema.safeParse(attempt.workspace);
	assert.ok(profile.success && grant.success && workspace.success, `${label}: Typed frozen profile, exact grant and one workspace required`);
	const ceiling = profile.data.permissionCeiling, value = grant.data, scope = workspace.data;
	for (const list of [value.contentRead, value.contentWrite, value.sourceRead, value.sourceWrite, value.tools]) {
		assert.equal(new Set(list.map(entry => JSON.stringify(entry))).size, list.length, `${label}: Duplicate authority is not exact custody`);
	}
	const allowedTools = new Set<string>(ceiling.tools);
	assert.ok(value.tools.every(tool => allowedTools.has(tool)), `${label}: Tool exceeds profile ceiling`);
	for (const [references, allowed] of [[value.contentRead, ceiling.content.read], [value.contentWrite, ceiling.content.write]] as const) {
		assert.ok(references.every(reference => reference.store !== 'treedx' || allowed.includes(reference.model as typeof allowed[number])),
			`${label}: Content model exceeds profile ceiling`);
	}
	if (value.sourceRead.length) assert.ok(value.tools.includes('source.read'), `${label}: Source read lacks its tool grant`);
	if (scope.mode === 'read-only') {
		assert.ok(!value.sourceWrite.length && !value.contentWrite.length && !value.tools.includes('source.write'), `${label}: Read-only workspace has mutation authority`);
	} else if (scope.mode === 'git') {
		assert.ok(!value.contentWrite.length && value.sourceWrite.length === 1 && value.sourceWrite[0] === scope.repository
			&& value.tools.includes('source.write'), `${label}: Git mutation must belong to the sole workspace`);
	} else {
		assert.ok(!value.sourceWrite.length && !value.tools.includes('source.write') && value.contentWrite.length > 0,
			`${label}: TreeDX cannot also own source mutation`);
		for (const reference of value.contentWrite) assert.ok(reference.store === 'treedx' && reference.repository === scope.repository
			&& reference.commit === scope.baseCommit && reference.path && scope.writablePaths.includes(reference.path),
			`${label}: Mutable TreeDX authority is unpinned or outside its workspace`);
	}
	assert.ok(Array.isArray(attempt.contextRefs), `${label}: Exact context custody required`);
	for (const input of attempt.contextRefs) {
		const reference = exactEntityReferenceSchema.safeParse(input);
		assert.ok(reference.success, `${label}: Malformed context authority`);
		if (reference.data.store === 'git') assert.ok(reference.data.repository && value.sourceRead.includes(reference.data.repository),
			`${label}: Unassigned source context`);
		else if (reference.data.store === 'treedx') assert.ok(value.contentRead.some(allowed => JSON.stringify(allowed) === JSON.stringify(reference.data)),
			`${label}: Content context is not in the immutable exact grant`);
	}
}
