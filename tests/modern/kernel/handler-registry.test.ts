import { describe, expect, it, vi } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { HandlerRegistry } from '../../../src/kernel/handler-registry.ts';
import type { Handler } from '../../../src/kernel/contracts.ts';
import { request } from './provider-kernel-fixture.ts';

describe('pinned handler and activity authority', () => {
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
