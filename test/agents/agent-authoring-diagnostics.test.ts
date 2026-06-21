import { describe, expect, it } from 'vitest';
import { diagnoseAgentAuthoring } from '../../src/agents/testing/agent-authoring-diagnostics.ts';

describe('agent authoring diagnostics', () => {
	it('accepts a generic, classed, capability-scoped agent', () => {
		const diagnostics = diagnoseAgentAuthoring({
			slug: 'docs-engineer',
			handler: 'act',
			projectAgentClassId: 'implementation',
			handlerConfig: { domain: 'documentation_mutation' },
			context: { queries: [{ kind: 'treedx', paths: ['src/content/**'] }] },
			execution: {
				allowedPaths: ['src/content/**'],
				forbiddenPaths: ['src/content/private/**'],
				providerProfile: { requiredCapabilities: ['files:write', 'treedx_workspace'] },
			},
			outputs: { messages: ['task_completed'] },
		});
		expect(diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
	});

	it('flags old handlers and missing act constraints', () => {
		const diagnostics = diagnoseAgentAuthoring({
			slug: 'legacy-engineer',
			handler: 'engineer',
			handlerConfig: { domain: 'documentation_mutation' },
			context: {},
			execution: { providerProfile: { requiredCapabilities: [] } },
			outputs: {},
		});
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('agent.handler_not_generic');
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('agent.missing_project_agent_class');
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('agent.missing_context_queries');
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('agent.missing_required_capabilities');
		expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('agent.output_contract_ambiguous');
	});
});
