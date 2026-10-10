import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { state } from '../golden-readback-fixture.ts';
import { request } from '../../provider-kernel-fixture.ts';
import { portableProfile } from '../portable/portable-kernel-fixture.ts';
import { verifyGovernedProfile, verifyHandlerInspection } from '../../../../acceptance/workday/support/assignment-authority.ts';
import { inspectLiveAssignmentProfile } from '../../../../acceptance/workday/support/monitoring/live-assignment-records.ts';
import { liveAssignmentRecord } from '../../../guarantees/monitoring/live-assignment-fixture.ts';
await import('../../../../acceptance/workday/profile-custody.test.ts');

function input() {
	const definition = portableProfile(), activity = definition.activityProfiles.acting!;
	const content = stringify(definition), path = 'agents/portable-author.yaml';
	const attempt = assignmentAttemptSchema.parse({ ...assignmentAttemptSchema.parse(request().assignment.assignmentAttempt), agentClass: definition.agentClass,
		effectiveProfile: { profileRef: { store: 'treedx', model: 'agent', id: definition.id, revision: 1,
			digest: `sha256:${createHash('sha256').update(content).digest('hex')}`, repository: 'team-library', commit: 'a'.repeat(40), path },
			activity: 'acting', handler: activity.handler, handlerOrigin: 'agent-package', prompt: activity.prompt,
			parameters: activity.parameters, permissionCeiling: activity.permissions } });
	return { item: { id: attempt.id, assignmentAttempt: attempt }, file: { path, content } };
}
describe('independent governed profile assertion contract', () => {
	it('live profile inspection reads the independent canonical assignment exact governed bytes and public handler boundary before accepting a new observation', () => {
		const f = input(), item = liveAssignmentRecord(f.item.assignmentAttempt), attempt = f.item.assignmentAttempt, profile = attempt.effectiveProfile;
		const handler = { id: profile.handler, origin: profile.handlerOrigin };
		state.replies.set('assignments show', item);
		state.replies.set(`library read ${f.file.path}`, { result: { resolvedRef: profile.profileRef.commit, files: [f.file] } });
		state.replies.set('agents handlers --project', { projectId: attempt.projectId, handlers: [handler] });
		state.replies.set(`agents handlers ${profile.handler}`, { projectId: attempt.projectId, handler });
		const before = structuredClone([...state.replies]); inspectLiveAssignmentProfile(item, attempt.teamId);
		expect(state.calls.map(args => args.slice(0, 3))).toEqual([
			['assignments', 'show', attempt.id], ['library', 'read', attempt.projectId],
			['agents', 'handlers', 'list'], ['agents', 'handlers', 'show'],
		]);
		expect(state.calls[0]).toContain(attempt.teamId);
		for (const args of state.calls.slice(1)) expect(args).not.toContain('--team');
		expect([...state.replies]).toEqual(before);
	});
	it('live profile inspection denies an independently substituted runtime or failed public read without repairing the original attempt', () => {
		const f = input(), item = liveAssignmentRecord(f.item.assignmentAttempt), shown = structuredClone(item), before = structuredClone(item);
		const attempt = shown.assignmentAttempt as Record<string, unknown>, provider = attempt.provider as Record<string, unknown>;
		provider.runtimeBuild = `sha256:${'f'.repeat(64)}`; state.replies.set('assignments show', shown);
		expect(() => inspectLiveAssignmentProfile(item, f.item.assignmentAttempt.teamId)).toThrow('Independent public view changed issued authority');
		state.failure = new Error('controlled_denial');
		expect(() => inspectLiveAssignmentProfile(item, f.item.assignmentAttempt.teamId)).toThrow('ACCEPTANCE_CLI_COMMAND');
		expect(item).toEqual(before);
	});
	it('native handler readback composition uses exact project and server without attaching an unsupported team option', () => {
		const f = input(), id = 'workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', attempt = f.item.assignmentAttempt;
		vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID', id);
		const run = { id, executionMode: 'simulation', startedAt: attempt.createdAt };
		const item = { ...f.item, workDayId: id, createdAt: attempt.createdAt };
		const profile = attempt.effectiveProfile, catalog = { projectId: attempt.projectId,
			handlers: [{ id: profile.handler, origin: profile.handlerOrigin }] };
		state.replies.set('workdays show', { run });
		state.replies.set('assignments list', { items: [item], page: { limit: 50, hasMore: false, nextCursor: null } });
		state.replies.set(`library read ${f.file.path}`, { result: { resolvedRef: profile.profileRef.commit, files: [f.file] } });
		state.replies.set('agents handlers --project', catalog);
		state.replies.set(`agents handlers ${profile.handler}`, { projectId: attempt.projectId, handler: catalog.handlers[0] });
		const held = structuredClone([...state.replies]);
		const nativeCase = state.cases.get('Actual governed handlers remain inspectable through exact public list and show without changing frozen execution authority or profile bytes');
		expect(nativeCase).toBeTypeOf('function'); expect(() => nativeCase!()).not.toThrow();
		const list = ['agents', 'handlers', 'list', '--project', attempt.projectId, '--server', 'local', '--json'];
		const show = ['agents', 'handlers', 'show', profile.handler, '--project', attempt.projectId, '--server', 'local', '--json'];
		expect(state.calls.filter(args => args.slice(0, 2).join(' ') === 'agents handlers')).toEqual([list, show, list, show]);
		expect([...state.replies]).toEqual(held);
		// Mocked CLI observation proves harness composition only; the existing
		// packaged CLI HTTP integration and managed native case remain separate.
	});
	it('binds public handler inspection to the exact frozen renamed identity and origin without changing grants or source bytes', () => {
		for (const handler of ['actor', 'configured/renamed-handler']) {
			const f = input(); f.item.assignmentAttempt.effectiveProfile.handler = handler;
			f.item.assignmentAttempt.effectiveProfile.handlerOrigin = handler.includes('/') ? 'project-runtime' : 'agent-package';
			const selected = { id: handler, origin: f.item.assignmentAttempt.effectiveProfile.handlerOrigin };
			const catalog = { projectId: f.item.assignmentAttempt.projectId, handlers: [selected] }, show = { projectId: catalog.projectId, handler: selected };
			const before = structuredClone({ f, catalog, show });
			expect(() => verifyHandlerInspection(f.item, catalog, show)).not.toThrow(); expect({ f, catalog, show }).toEqual(before);
		}
	});
	it('denies absent foreign duplicated substituted and origin contradictory handler inspection without repairing frozen authority', () => {
		for (const failure of ['project', 'empty', 'missing', 'duplicate', 'origin', 'show-project', 'show-handler', 'show-origin']) {
			const f = input(), profile = f.item.assignmentAttempt.effectiveProfile;
			const catalog = { projectId: f.item.assignmentAttempt.projectId, handlers: [{ id: profile.handler, origin: profile.handlerOrigin }] };
			const show = { projectId: catalog.projectId, handler: { ...catalog.handlers[0]! } };
			if (failure === 'project') catalog.projectId = 'foreign'; if (failure === 'empty') catalog.handlers = [];
			if (failure === 'missing') catalog.handlers[0]!.id = 'unregistered'; if (failure === 'duplicate') catalog.handlers.push({ ...catalog.handlers[0]! });
			if (failure === 'origin') catalog.handlers[0]!.origin = 'project-runtime'; if (failure === 'show-project') show.projectId = 'foreign';
			if (failure === 'show-handler') show.handler.id = 'unregistered'; if (failure === 'show-origin') show.handler.origin = 'project-runtime';
			const before = structuredClone({ f, catalog, show }); expect(() => verifyHandlerInspection(f.item, catalog, show)).toThrow(/ACCEPTANCE_HANDLER/u);
			expect({ f, catalog, show }).toEqual(before);
		}
	});
	it('retains whole exact governed YAML bytes and frozen handler prompt parameters ceiling without rewriting input', () => {
		const f = input(), before = structuredClone(f); expect(() => verifyGovernedProfile(f.item, f.file)).not.toThrow(); expect(f).toEqual(before);
	});
	it('denies moved missing malformed and digest-contradicting profile content despite valid terminal labels', () => {
		const outcomes = [];
		for (const mutation of ['path', 'missing', 'malformed', 'changed-bytes']) {
			const f = input(); if (mutation === 'path') f.file.path = 'agents/foreign.yaml';
			if (mutation === 'missing') f.file.content = ''; if (mutation === 'malformed') f.file.content = '[';
			if (mutation === 'changed-bytes') f.file.content += '\n# moved source\n';
			try { verifyGovernedProfile(f.item, f.file); outcomes.push(false); } catch { outcomes.push(true); }
		}
		expect(outcomes).toEqual([true, true, true, true]);
	});
	it('denies frozen handler identity prompt parameters and permission drift against independent governed authority', () => {
		const outcomes = [];
		for (const mutation of ['handler', 'identity', 'prompt', 'parameters', 'ceiling']) {
			const f = input(), attempt = f.item.assignmentAttempt;
			if (mutation === 'handler') attempt.effectiveProfile.handler = 'writer'; if (mutation === 'identity') attempt.agentClass = 'foreign-agent';
			if (mutation === 'prompt') attempt.effectiveProfile.prompt.system = 'Altered prompt does not belong to the governed profile.';
			if (mutation === 'parameters') attempt.effectiveProfile.parameters = { temperature: 1 };
			if (mutation === 'ceiling') attempt.effectiveProfile.permissionCeiling.tools.push('release');
			try { verifyGovernedProfile(f.item, f.file); outcomes.push(false); } catch { outcomes.push(true); }
		}
		expect(outcomes).toEqual([true, true, true, true, true]);
	});
	it('binds independent profile and public whole-record cases separately from supplied unit evidence', () => {
		expect(state.cases.has('Every actual assignment matches independently read exact governed profile bytes handler prompt parameters and narrower grants')).toBe(true);
		expect(state.cases.has('Public assignment views preserve whole canonical attempts results and original authority across repeated readback')).toBe(true);
	});
});
