import { describe, expect, it } from 'vitest';
import { HandlerRegistry } from '../../../../../src/kernel/handler-registry.ts';
import { ActorHandler, WriterHandler } from '../../../../../src/kernel/handlers/model-handler.ts';
import { portableProfile } from './portable-kernel-fixture.ts';

describe('one build-time registry and governed portable identity', () => {
	it('selects the same reusable handler for arbitrary renamed identities without role dispatch', () => {
		const actor = new ActorHandler(), writer = new WriterHandler(), registry = new HandlerRegistry([actor, writer]);
		for (const name of ['renamed-author', 'customer-owned-class', 'entirely-new-agent']) {
			const profile = portableProfile(name); expect(profile.agentClass).toBe(name);
			expect(registry.resolve(profile.activityProfiles.acting!.handler)).toBe(actor);
		}
		expect(registry.describe()).toEqual([{ id: 'actor' }, { id: 'writer' }]);
	});
	it('rejects duplicate and unknown selections without replacing the original compiled handler', () => {
		const first = new ActorHandler(), second = new ActorHandler(), registry = new HandlerRegistry([first]);
		expect(() => new HandlerRegistry([first, second])).toThrow('duplicate_handler:actor');
		expect(() => registry.resolve('uncompiled/customer-handler')).toThrow('unknown_handler:uncompiled/customer-handler');
		expect(registry.resolve('actor')).toBe(first);
	});
	it('keeps prompts parameters context selectors and permission ceilings solely in the configured profile', () => {
		const profile = portableProfile(); const before = structuredClone(profile), actor = new ActorHandler();
		new HandlerRegistry([actor]).resolve(profile.activityProfiles.acting!.handler);
		expect(profile).toEqual(before); expect(profile.context.include).toEqual(['assignment-subject', 'predecessor-results']);
		expect(profile.activityProfiles.acting!.parameters).toEqual({ temperature: 0.25 });
		expect(profile.activityProfiles.acting!.permissions.tools).toEqual(['source.read', 'source.write']);
	});
});
