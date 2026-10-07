import assert from 'node:assert/strict';
import { assignmentWorkspaceSchema, effectiveActivityProfileSchema, exactGrantSchema, exactEntityReferenceSchema, assignmentAttemptSchema, assignmentReferenceSchema, assignmentResultSchema, validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { read, row, type Row } from '../../acceptance-cli.ts';
import { clockReading, timingAwarenessContract } from '../../../../src/sandbox/guest.ts';

/** Discover actual model execution from owning events, never configured role names
 * or completed status. Missing failed-attempt evidence must remain fatal. */
export function modelExecutionInventory(items: Row[], events: Row[], run: Row): Array<{ item: Row; started: Row; terminal: Row }> {
	assert.ok(typeof run.id === 'string' && run.id && typeof run.teamId === 'string' && run.teamId, 'ACCEPTANCE_MODEL_INVENTORY_SCOPE');
	const owners = new Map<string, Row>(), identities = new Set<string>(), indexes = new Set<number>();
	for (const item of items) {
		assert.ok(typeof item.id === 'string' && item.id && !owners.has(item.id), 'ACCEPTANCE_MODEL_INVENTORY_ASSIGNMENT'); owners.set(item.id, item);
	}
	for (const event of events) {
		assert.ok(typeof event.id === 'string' && event.id && !identities.has(event.id) && Number.isSafeInteger(event.eventIndex)
			&& Number(event.eventIndex) >= 0 && !indexes.has(Number(event.eventIndex)), 'ACCEPTANCE_MODEL_INVENTORY_EVENT');
		assert.equal(event.runId, run.id); assert.equal(event.teamId, run.teamId);
		identities.add(event.id); indexes.add(Number(event.eventIndex));
	}
	const modelEvent = (event: Row) => Object.hasOwn(row(event.payload), 'model') || row(event.payload).isolation === 'microvm';
	const starts = events.filter(event => event.eventType === 'provider.execution.started' && modelEvent(event));
	assert.ok(starts.length > 0, 'ACCEPTANCE_MODEL_INVENTORY_EMPTY');
	const seen = new Set<string>(), inventory = starts.map(started => {
		assert.ok(typeof row(started.payload).model === 'string' && String(row(started.payload).model).trim(), 'ACCEPTANCE_MODEL_INVENTORY_MODEL');
		assert.ok(typeof started.assignmentId === 'string' && !seen.has(started.assignmentId), 'ACCEPTANCE_MODEL_INVENTORY_ATTEMPT');
		seen.add(started.assignmentId); const item = owners.get(started.assignmentId);
		assert.ok(item, 'ACCEPTANCE_MODEL_INVENTORY_OWNER'); const attempt = row(item.assignmentAttempt);
		assert.equal(attempt.id, item.id); assert.equal(attempt.workdayId, run.id); assert.equal(attempt.teamId, run.teamId);
		assert.ok(typeof attempt.projectId === 'string' && attempt.projectId, 'ACCEPTANCE_MODEL_INVENTORY_PROJECT');
		const terminals = events.filter(event => event.assignmentId === item.id
			&& ['provider.execution.completed', 'provider.execution.failed'].includes(String(event.eventType)));
		assert.equal(terminals.length, 1, 'ACCEPTANCE_MODEL_INVENTORY_TERMINAL'); const terminal = terminals[0]!;
		for (const event of [started, terminal]) {
			assert.equal(event.workdayId, run.id); assert.equal(event.projectId, attempt.projectId);
			assert.ok(Number.isFinite(Date.parse(String(event.createdAt))), 'ACCEPTANCE_MODEL_INVENTORY_CLOCK');
		}
		assert.ok(Number(started.eventIndex) < Number(terminal.eventIndex)
			&& Date.parse(String(started.createdAt)) <= Date.parse(String(terminal.createdAt)), 'ACCEPTANCE_MODEL_INVENTORY_ORDER');
		return { item, started, terminal };
	});
	for (const event of events.filter(event => ['provider.execution.completed', 'provider.execution.failed'].includes(String(event.eventType)) && modelEvent(event)))
		assert.ok(seen.has(String(event.assignmentId)), 'ACCEPTANCE_MODEL_INVENTORY_MISSING_START');
	return inventory;
}

/** Raw public owning-event assertions, not a second runtime clock or receipt. */
export function verifyModelClockEvidence(item: Row, event: Row): void {
	const attempt = row(item.assignmentAttempt), result = row(item.assignmentResult), time = row(row(row(item.capacityEnvelope).budget).time);
	assert.equal(item.status, 'completed'); assert.equal(result.assignmentId, item.id); assert.equal(result.status, 'completed');
	for (const field of ['id', 'teamId', 'projectId', 'workdayId']) assert.ok(typeof attempt[field] === 'string' && attempt[field], 'ACCEPTANCE_MODEL_CLOCK_AUTHORITY');
	assert.equal(attempt.id, item.id); assert.equal(event.assignmentId, item.id); assert.equal(event.runId, attempt.workdayId);
	assert.equal(event.workdayId, attempt.workdayId); assert.equal(event.teamId, attempt.teamId); assert.equal(event.projectId, attempt.projectId);
	assert.equal(event.eventType, 'provider.execution.completed'); assert.ok(['recorded', 'completed'].includes(String(event.status)), 'ACCEPTANCE_MODEL_CLOCK_EVENT');
	assert.ok(typeof event.id === 'string' && event.id && Number.isSafeInteger(event.eventIndex), 'ACCEPTANCE_MODEL_CLOCK_EVENT_ID');
	const raw = row(event.protectedPayload).providerEvents;
	assert.ok(Array.isArray(raw) && raw.length > 0 && raw.every(value => value && typeof value === 'object' && !Array.isArray(value)), 'ACCEPTANCE_MODEL_CLOCK_RAW');
	const events = raw.map(row), actual = timingAwarenessContract(events);
	assert.ok(isDeepStrictEqual(actual, result.timingAwareness) && actual.completedChecks >= 2 && actual.firstToolCompliant && actual.finalToolCompliant,
		'ACCEPTANCE_MODEL_CLOCK_RECEIPT: Actual retained model actions must match the canonical receipt');
	const deadline = Date.parse(String(attempt.deadline)), started = Date.parse(String(time.executionStartedAt)), completed = Date.parse(String(result.completedAt));
	assert.ok([deadline, started, completed].every(Number.isFinite) && started <= completed && completed <= deadline, 'ACCEPTANCE_MODEL_CLOCK_WINDOW');
	assert.ok(Number.isFinite(Date.parse(String(event.createdAt))) && Date.parse(String(event.createdAt)) >= completed, 'ACCEPTANCE_MODEL_CLOCK_REPORTING');
	const ids = new Set<string>(), pending = new Set<string>(); let previous = -Infinity, checked = false;
	for (const action of events) {
		const value = row(action.item);
		if (action.type === 'item.started' && ['command_execution', 'mcp_tool_call'].includes(String(value.type))) pending.add(String(value.id));
		if (action.type !== 'item.completed') continue;
		if (value.type === 'mcp_tool_call' && value.server === 'treedx' && value.tool === 'treeseed_time_status') {
			const reading = clockReading(value.result); assert.ok(reading, 'ACCEPTANCE_MODEL_CLOCK_READING');
			assert.equal(reading.startedAt, time.executionStartedAt); assert.equal(reading.deadlineAt, attempt.deadline);
			const observed = Date.parse(reading.observedAt);
			assert.ok(observed >= started && observed >= previous && observed <= completed && reading.remainingSeconds > 0,
				'ACCEPTANCE_MODEL_CLOCK_TIMESTAMP: Original live observation must precede completion and not regress');
			assert.equal(reading.remainingSeconds, Math.ceil((deadline - observed) / 1_000));
			assert.ok(typeof value.id === 'string' && value.id && !ids.has(value.id), 'ACCEPTANCE_MODEL_CLOCK_DUPLICATE');
			ids.add(value.id); previous = observed; checked = true;
		} else if (value.type === 'command_execution') { assert.ok(checked, 'ACCEPTANCE_MODEL_CLOCK_RECHECK'); checked = false; }
		pending.delete(String(value.id));
	}
	assert.equal(ids.size, actual.completedChecks); assert.equal(pending.size, 0, 'ACCEPTANCE_MODEL_CLOCK_PENDING');
}

export function verifyGovernedProfile(item: Row, file: Row): void {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), profile = attempt.effectiveProfile;
	assert.equal(file.path, profile.profileRef.path, 'ACCEPTANCE_PROFILE_PATH: Exact governed path required');
	assert.equal(typeof file.content, 'string', 'ACCEPTANCE_PROFILE_BYTES: Original governed bytes required');
	const content = String(file.content);
	assert.equal(`sha256:${createHash('sha256').update(content).digest('hex')}`, profile.profileRef.digest,
		'ACCEPTANCE_PROFILE_DIGEST: Independent source bytes differ from immutable profile');
	// YAML configuration, including YAML frontmatter in a governed MDX file.
	let document = content;
	if (content.startsWith('---\n')) {
		const end = content.indexOf('\n---', 4); assert.ok(end > 4, 'ACCEPTANCE_PROFILE_YAML: Complete frontmatter required'); document = content.slice(4, end);
	}
	const checked = validateAgentDefinitionModel(parse(document));
	assert.ok(checked.ok && checked.data, 'ACCEPTANCE_PROFILE_YAML: Complete public governed profile required');
	const definition = checked.data, activity = definition.activityProfiles[profile.activity];
	assert.equal(definition.id, profile.profileRef.id); assert.equal(definition.agentClass, attempt.agentClass);
	assert.ok(activity, 'ACCEPTANCE_PROFILE_ACTIVITY: Missing selected governed activity');
	assert.equal(profile.handler, activity.handler); assert.deepEqual(profile.prompt, activity.prompt);
	assert.deepEqual(profile.parameters, activity.parameters); assert.deepEqual(profile.additionalContext, activity.additionalContext);
	assert.deepEqual(profile.permissionCeiling, activity.permissions);
	verifyAssignmentAuthority(item);
}
export function verifyHandlerInspection(item: Row, catalog: Row, selected: Row): void {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), profile = attempt.effectiveProfile;
	assert.equal(catalog.projectId, attempt.projectId, 'ACCEPTANCE_HANDLER_PROJECT: Exact owning project required');
	assert.ok(Array.isArray(catalog.handlers) && catalog.handlers.length > 0, 'ACCEPTANCE_HANDLER_INVENTORY: Nonempty declared inventory required');
	const identities = new Set<string>();
	for (const value of catalog.handlers) {
		const handler = row(value);
		assert.ok(typeof handler.id === 'string', 'ACCEPTANCE_HANDLER_ID: Original handler identity required');
		assert.ok(handler.id && !identities.has(handler.id), 'ACCEPTANCE_HANDLER_DUPLICATE: Handler inventory identities must be unique');
		identities.add(handler.id);
		assert.equal(handler.origin, handler.id.includes('/') ? 'project-runtime' : 'agent-package', 'ACCEPTANCE_HANDLER_ORIGIN: Declared origin must agree with the governed identity');
	}
	const matching = catalog.handlers.map(row).filter(handler => handler.id === profile.handler);
	assert.equal(matching.length, 1, 'ACCEPTANCE_HANDLER_MISSING: Frozen governed handler must remain inspectable');
	assert.deepEqual(matching[0], { id: profile.handler, origin: profile.handlerOrigin });
	assert.equal(selected.projectId, attempt.projectId, 'ACCEPTANCE_HANDLER_SELECTED_PROJECT: Show cannot broaden project scope');
	assert.deepEqual(selected.handler, matching[0], 'ACCEPTANCE_HANDLER_SELECTED: Show must retain the exact listed handler and origin');
}

export function verifyExactContextSource(reference: Row, projectId: string, library: Row, returned: Row): void {
	const ref = exactEntityReferenceSchema.parse(reference);
	assert.equal(ref.store, 'treedx'); assert.ok(ref.repository && ref.commit && ref.path, 'ACCEPTANCE_CONTEXT_REF: Exact content identity required');
	const bound = library.repositoryId ?? row(row(row(library.topology).contentRepository).treeDx).repositoryId;
	assert.equal(bound, ref.repository, 'ACCEPTANCE_CONTEXT_BINDING: Independently read project binding differs from frozen repository');
	assert.equal(returned.resolvedRef, ref.commit, 'ACCEPTANCE_CONTEXT_MOVED: Independent exact ref read changed authority');
	assert.ok(Array.isArray(returned.files) && returned.files.length === 1, 'ACCEPTANCE_CONTEXT_FILE: One exact content result required');
	const file = row(returned.files[0]);
	assert.equal(file.requestedPath ?? file.logicalPath ?? file.path, ref.path, 'ACCEPTANCE_CONTEXT_PATH: Foreign content path');
	assert.equal(typeof file.content, 'string', 'ACCEPTANCE_CONTEXT_BYTES: Missing original bytes');
	if (ref.model === 'book') {
		assert.ok(ref.digest, 'ACCEPTANCE_CONTEXT_DIGEST: Exact Book content digest required');
		assert.equal(`sha256:${createHash('sha256').update(String(file.content)).digest('hex')}`, ref.digest,
			'ACCEPTANCE_CONTEXT_DIGEST: Original Book bytes differ');
		const content = row(file.frontmatter); assert.equal(content.schemaVersion, 'treeseed.book/v3');
		assert.equal(content.id, ref.id); assert.equal(content.projectId, projectId); assert.equal(content.revision, ref.revision);
	}
}

// Readback-only association through the existing canonical Knowledge model.
// No reverse Book-page inventory, new digest rule or page-status policy.
export function verifyKnowledgeBookSource(reference: Row, target: Row, book: Row, projectId: string, returned: Row): void {
	const ref = assignmentReferenceSchema.parse(reference), write = exactEntityReferenceSchema.parse(target);
	const exactBook = exactEntityReferenceSchema.parse(book);
	assert.ok(ref.kind === 'treedx' && write.store === 'treedx' && write.model === 'knowledge');
	assert.ok(exactBook.store === 'treedx' && exactBook.model === 'book');
	assert.equal(ref.projectId, projectId); assert.equal(ref.repository, write.repository); assert.equal(ref.path, write.path);
	assert.equal(returned.resolvedRef, ref.commit, 'ACCEPTANCE_KNOWLEDGE_COMMIT: Exact committed artifact required');
	assert.ok(Array.isArray(returned.files) && returned.files.length === 1, 'ACCEPTANCE_KNOWLEDGE_FILE: One exact Knowledge file required');
	const file = row(returned.files[0]); assert.equal(file.path, ref.path); assert.equal(typeof file.content, 'string');
	const document = String(file.content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u);
	assert.ok(document, 'ACCEPTANCE_KNOWLEDGE_BYTES: Native frontmatter and body required');
	const frontmatter = row(parse(document[1]!));
	assert.deepEqual(file.frontmatter, frontmatter, 'ACCEPTANCE_KNOWLEDGE_BYTES: Parsed readback contradicts original bytes');
	const checked = validatePortableContentData('knowledge', { ...frontmatter, body: document[2]!.trim() });
	assert.ok(checked.ok, 'ACCEPTANCE_KNOWLEDGE_MODEL: Complete canonical Knowledge required');
	const knowledge = row(checked.data); assert.equal(knowledge.id, write.id); assert.equal(knowledge.projectId, projectId);
	assert.deepEqual(knowledge.bookRef, exactBook, 'ACCEPTANCE_KNOWLEDGE_BOOK: Exact authorized Book association required');
}

// Authorization and exact-byte readback only. A valid draft does not prove that
// a model noticed unfinished work in time, or that governance accepted it.
export function verifyDraftProposalHandoff(item: Row, reference: Row, returned: Row): void {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), result = assignmentResultSchema.parse(item.assignmentResult);
	const ref = assignmentReferenceSchema.parse(reference);
	assert.equal(item.status, 'completed'); assert.equal(result.status, 'completed'); assert.equal(result.assignmentId, attempt.id);
	assert.ok(ref.kind === 'treedx' && attempt.workspace.mode === 'treedx', 'ACCEPTANCE_HANDOFF_WRITE: Governed content workspace required');
	assert.equal(ref.projectId, attempt.projectId); assert.equal(ref.repository, attempt.workspace.repository);
	assert.ok(result.references.some(value => isDeepStrictEqual(value, ref)), 'ACCEPTANCE_HANDOFF_RESULT: Reference is not owned by this Result');
	const targets = attempt.grant.contentWrite.filter(value => value.store === 'treedx' && value.model === 'proposal'
		&& value.repository === ref.repository && value.path === ref.path);
	assert.equal(targets.length, 1, 'ACCEPTANCE_HANDOFF_GRANT: One exact assigned Proposal write required');
	assert.ok(attempt.effectiveProfile.permissionCeiling.content.write.includes('proposal'), 'ACCEPTANCE_HANDOFF_PERMISSION: Profile does not permit this model');
	assert.equal(returned.resolvedRef, ref.commit, 'ACCEPTANCE_HANDOFF_COMMIT: Exact publication readback required');
	assert.ok(Array.isArray(returned.files) && returned.files.length === 1, 'ACCEPTANCE_HANDOFF_FILE: One exact file required');
	const file = row(returned.files[0]); assert.equal(file.path, ref.path); assert.equal(typeof file.content, 'string');
	const document = String(file.content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u);
	assert.ok(document && document[2]!.trim(), 'ACCEPTANCE_HANDOFF_BYTES: Original nonempty Markdown required');
	const frontmatter = row(parse(document[1]!)); assert.deepEqual(file.frontmatter, frontmatter);
	const checked = validatePortableContentData('proposal', frontmatter); assert.ok(checked.ok, 'ACCEPTANCE_HANDOFF_MODEL: Canonical Proposal required');
	const proposal = row(checked.data); assert.equal(proposal.id, targets[0]!.id); assert.equal(proposal.projectId, attempt.projectId);
	assert.equal(proposal.status, 'draft', 'ACCEPTANCE_HANDOFF_STATUS: Draft is not an accepted execution decision');
	const work = row(proposal.executionPlan).workItems; assert.ok(Array.isArray(work) && work.length > 0, 'ACCEPTANCE_HANDOFF_PLAN: Concrete next work required');
	const evidence = proposal.evidenceRefs; assert.ok(Array.isArray(evidence) && evidence.length > 0, 'ACCEPTANCE_HANDOFF_EVIDENCE: Exact source evidence required');
	const authorized = [attempt.sourceRef, ...attempt.contextRefs, ...attempt.authorityRefs];
	for (const value of evidence) assert.ok(authorized.some(allowed => isDeepStrictEqual(allowed, exactEntityReferenceSchema.parse(value))),
		'ACCEPTANCE_HANDOFF_EVIDENCE: Foreign or changed source authority');
	const completed = Date.parse(result.completedAt), created = Date.parse(attempt.createdAt), deadline = Date.parse(attempt.deadline);
	assert.ok(Number.isFinite(completed) && completed >= created && completed <= deadline, 'ACCEPTANCE_HANDOFF_CLOCK: Original completion window required');
}

// A conservative unfinished-work scenario: preserve the exact unverified
// original work item, not a prose claim that its requirements were satisfied.
// Clock values are original observations supplied by the owning caller; unit
// inputs alone never establish model behavior or a live API clock.
export function verifyUnfinishedDraftHandoff(item: Row, reference: Row, returned: Row, source: Row, clocks: readonly Row[]): void {
	verifyDraftProposalHandoff(item, reference, returned);
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), result = assignmentResultSchema.parse(item.assignmentResult);
	const sourceRef = attempt.sourceRef;
	assert.ok(sourceRef.store === 'treedx' && sourceRef.model === 'proposal' && sourceRef.commit && sourceRef.path && sourceRef.digest,
		'ACCEPTANCE_UNFINISHED_SOURCE: Exact original governed Proposal required');
	assert.equal(source.resolvedRef, sourceRef.commit); assert.ok(Array.isArray(source.files) && source.files.length === 1);
	const file = row(source.files[0]); assert.equal(file.path, sourceRef.path); assert.equal(typeof file.content, 'string');
	assert.equal(`sha256:${createHash('sha256').update(String(file.content)).digest('hex')}`, sourceRef.digest);
	const raw = String(file.content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u); assert.ok(raw);
	const original = row(parse(raw[1]!)); assert.deepEqual(file.frontmatter, original);
	assert.ok(validatePortableContentData('proposal', original).ok); assert.equal(original.id, sourceRef.id); assert.equal(original.projectId, attempt.projectId);
	const work = row(original.executionPlan).workItems; assert.ok(Array.isArray(work));
	const pending = work.map(row).filter(value => value.id === attempt.workItemId); assert.equal(pending.length, 1);
	const draftFiles = returned.files; assert.ok(Array.isArray(draftFiles)); const draft = row(row(draftFiles[0]).frontmatter);
	const next = row(draft.executionPlan).workItems; assert.ok(Array.isArray(next));
	const retained = next.map(row).filter(value => value.id === attempt.workItemId); assert.equal(retained.length, 1);
	assert.deepEqual(retained[0], pending[0], 'ACCEPTANCE_UNFINISHED_WORK: Objective criteria permissions estimate and priority must not be weakened or silently declared complete');
	assert.ok(Array.isArray(draft.evidenceRefs) && draft.evidenceRefs.some(value => isDeepStrictEqual(value, sourceRef)),
		'ACCEPTANCE_UNFINISHED_EVIDENCE: Original pending work must remain exact evidence');
	assert.ok(result.verification.some(value => value.status === 'failed' && value.exitCode === 1 && typeof value.durationSeconds === 'number'),
		'ACCEPTANCE_UNFINISHED_FAILED: Genuine retained failed verification is required for this unfinished-work scenario');
	assert.ok(clocks.length >= 2); const first = clocks[0]!, last = clocks.at(-1)!;
	const start = Date.parse(String(first.startedAt)), end = Date.parse(String(first.deadlineAt));
	assert.ok(Number.isFinite(start) && Number.isFinite(end) && Date.parse(attempt.createdAt) <= start && start < end && end <= Date.parse(attempt.deadline));
	let previous = Infinity;
	for (const clock of clocks) {
		assert.equal(clock.startedAt, first.startedAt); assert.equal(clock.deadlineAt, first.deadlineAt);
		assert.ok(typeof clock.remainingSeconds === 'number' && Number.isInteger(clock.remainingSeconds) && clock.remainingSeconds > 0
			&& clock.remainingSeconds <= (end - start) / 1000 && clock.remainingSeconds <= previous, 'ACCEPTANCE_UNFINISHED_CLOCK: No expired refreshed or increasing authority');
		previous = clock.remainingSeconds;
	}
	const maximum = row(pending[0]!.estimate).maximumSeconds;
	assert.ok(typeof maximum === 'number' && typeof first.remainingSeconds === 'number' && first.remainingSeconds < maximum
		&& typeof last.remainingSeconds === 'number' && last.remainingSeconds < first.remainingSeconds,
		'ACCEPTANCE_UNFINISHED_ADAPTATION: Actual reduced remaining time and still-unverified larger work required');
	assert.ok(Date.parse(result.completedAt) >= start && Date.parse(result.completedAt) <= end);
}


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
