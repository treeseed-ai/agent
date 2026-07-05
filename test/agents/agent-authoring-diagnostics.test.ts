import { describe, expect, it } from 'vitest';
import { diagnoseAgentAuthoring } from '../../src/agents/testing/agent-authoring-diagnostics.ts';

describe('agent authoring diagnostics', () => {
	it('accepts a generic, classed, capability-scoped agent', () => {
		const diagnostics = diagnoseAgentAuthoring({
			slug: 'docs-engineer',
			projectAgentClassId: 'implementation',
			activityProfiles: {
				acting: {
					handler: 'actor',
					contentAccess: { readModels: ['decision', 'note'] },
					context: { queries: [{ kind: 'treedx', paths: ['src/content/**'] }] },
					execution: {
						allowedPaths: ['src/content/**'],
						forbiddenPaths: ['src/content/private/**'],
						requiredCapabilities: ['files:write', 'treedx_workspace'],
					},
					outputs: { content: ['implementation_report'] },
				},
			},
		});
		expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
	});

	it('flags old handlers and incomplete profile contracts', () => {
		const diagnostics = diagnoseAgentAuthoring({
			slug: 'legacy-engineer',
			activityProfiles: {
				acting: {
					handler: 'engineer',
					context: {},
					execution: {},
					outputs: {},
				},
			},
		});
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('agent.handler_not_profile_handler');
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('agent.missing_project_agent_class');
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('agent.missing_context_queries');
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('agent.missing_required_capabilities');
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('agent.output_contract_ambiguous');
	});
});
