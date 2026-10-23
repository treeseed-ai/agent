import { describe, expect, it } from 'vitest';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { portableKernel, portableProfile } from '../portable-kernel-fixture.ts';

// Real Kernel/registry, public YAML validation, native Git and loopback executor.
// Executor replies are controlled inputs, not live model or physical VM proof.
describe('activity-complete handlers through the original execution path', () => {
	it('uses every configured model handler for the same native Git product without role routing', async () => {
		for (const handler of ['writer', 'actor', 'estimate', 'reviewer', 'releaser']) {
			const f = await portableKernel();
			try {
				const profile = portableProfile('customer-owned-class', handler), acting = profile.activityProfiles.acting!;
				f.attempt.agentClass = profile.agentClass;
				f.attempt.effectiveProfile = { ...f.attempt.effectiveProfile, handler: acting.handler, prompt: acting.prompt,
					parameters: acting.parameters, permissionCeiling: acting.permissions };
				const candidate = await f.candidate(), before = structuredClone(f.input.assignment);
				const result = await f.run();
				expect(result.status, `${handler}: ${result.summary}`).toBe('completed');
				expect(f.requests).toHaveLength(1);
				expect(f.modelRequests[0]).toBeDefined();
				expect(f.modelRequests[0]).toHaveProperty('prompt', expect.stringContaining(acting.prompt.system));
				expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).references).toContainEqual(expect.objectContaining({ kind: 'git', commit: candidate }));
				expect(f.git('rev-parse', 'HEAD')).toBe(candidate);
				expect(f.input.assignment).toEqual(before);
			} finally { await f.close(); }
		}
	});
});
