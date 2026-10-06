import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { state } from '../golden-readback-fixture.ts';
import { request } from '../../provider-kernel-fixture.ts';
import { portableProfile } from '../portable/portable-kernel-fixture.ts';
import { verifyGovernedProfile, verifyHandlerInspection } from '../../../../acceptance/workday/support/assignment-authority.ts';
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
