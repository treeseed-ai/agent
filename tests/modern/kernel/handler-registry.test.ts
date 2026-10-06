import { describe, expect, it, vi } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { HandlerRegistry } from '../../../src/kernel/handler-registry.ts';
import type { Handler } from '../../../src/kernel/contracts.ts';
import { request } from './provider-kernel-fixture.ts';

describe('pinned handler and activity authority', () => {
	it('retains exact renamed project implementations in the sole registry and rejects a conflicting implementation before either handler executes', () => {
		const first: Handler = { id: 'configured/renamed-a', run: vi.fn() }, second: Handler = { id: 'other-project/renamed-b', run: vi.fn() };
		const selected = [second, first], before = [...selected], registry = new HandlerRegistry(selected);
		expect(registry.describe()).toEqual([{ id: first.id }, { id: second.id }]);
		expect(registry.resolve(first.id)).toBe(first); expect(registry.resolve(second.id)).toBe(second);
		const conflicting: Handler = { id: first.id, run: vi.fn() };
		expect(() => new HandlerRegistry([first, second, conflicting])).toThrow(`duplicate_handler:${first.id}`);
		expect(() => registry.resolve('configured/missing')).toThrow('unknown_handler:configured/missing');
		expect(selected).toEqual(before); expect(selected[0]).toBe(second); expect(selected[1]).toBe(first);
		expect(first.run).not.toHaveBeenCalled(); expect(second.run).not.toHaveBeenCalled(); expect(conflicting.run).not.toHaveBeenCalled();
	});
	it('rejects duplicate handlers rather than choosing an arbitrary implementation', () => {
		const handler: Handler = { id: 'actor', run: vi.fn() };
		expect(() => new HandlerRegistry([handler, handler])).toThrow('duplicate_handler:actor');
	});
	it('resolves only registered handlers and rejects retired generic aliases', () => {
		const handler: Handler = { id: 'actor', run: vi.fn() };
		const registry = new HandlerRegistry([handler]);
		expect(registry.resolve('actor')).toBe(handler);
		for (const id of ['generic', 'generic-agent', 'default', 'unknown'])
			expect(() => registry.resolve(id)).toThrow(`unknown_handler:${id}`);
	});
	it('preserves the exact effective activity profile without synthesizing another agent', () => {
		const attempt = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
		expect(attempt.effectiveProfile.handler).toBe('actor');
		expect(attempt.effectiveProfile.activity).toBe('acting');
		expect(attempt.effectiveProfile.profileRef.id).toBe('engineer');
		expect(attempt.effectiveProfile.permissionCeiling.tools).toEqual(['source.read', 'source.write']);
	});
	it('rejects legacy top-level configuration and duplicate profile permission fields', () => {
		const attempt = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
		for (const field of ['systemPrompt', 'agentConfig', 'execution', 'activityProfiles'])
			expect(assignmentAttemptSchema.safeParse({ ...attempt, [field]: {} }).success).toBe(false);
		expect(assignmentAttemptSchema.safeParse({ ...attempt,
			effectiveProfile: { ...attempt.effectiveProfile, permissions: attempt.effectiveProfile.permissionCeiling },
		}).success).toBe(false);
	});
});
