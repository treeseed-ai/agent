import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';

export type AgentAuthoringDiagnosticCode =
	| 'agent.handler_not_generic'
	| 'agent.missing_project_agent_class'
	| 'agent.missing_context_queries'
	| 'agent.missing_required_capabilities'
	| 'agent.act_missing_path_constraints'
	| 'agent.content_write_requires_treedx'
	| 'agent.governance_frontmatter_missing'
	| 'agent.output_contract_ambiguous'
	| 'agent.execution_provider_too_specific'
	| 'agent.local_filesystem_content_dependency';

export interface AgentAuthoringDiagnostic {
	code: AgentAuthoringDiagnosticCode;
	severity: 'info' | 'warning' | 'error';
	message: string;
	filePath?: string | null;
	fieldPath: string;
	fixSuggestion: string;
	docsLink: string;
	agentSlug?: string | null;
}

const GENERIC_HANDLERS = new Set(['plan', 'research', 'act', 'review', 'report']);

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown) {
	return array(value).filter((entry): entry is string => typeof entry === 'string');
}

export function diagnoseAgentAuthoring(spec: AgentRuntimeSpec | Record<string, unknown>, options: {
	filePath?: string | null;
	docsBase?: string;
} = {}): AgentAuthoringDiagnostic[] {
	const agent = spec as Record<string, unknown>;
	const slug = typeof agent.slug === 'string' ? agent.slug : null;
	const docsBase = options.docsBase ?? '/docs/agent-docs';
	const diagnostics: AgentAuthoringDiagnostic[] = [];
	const add = (
		code: AgentAuthoringDiagnosticCode,
		severity: AgentAuthoringDiagnostic['severity'],
		fieldPath: string,
		message: string,
		fixSuggestion: string,
	) => diagnostics.push({
		code,
		severity,
		message,
		filePath: options.filePath ?? null,
		fieldPath,
		fixSuggestion,
		docsLink: docsBase,
		agentSlug: slug,
	});
	const handler = typeof agent.handler === 'string' ? agent.handler : '';
	if (!GENERIC_HANDLERS.has(handler)) {
		add(
			'agent.handler_not_generic',
			'error',
			'handler',
			`Agent ${slug ?? '<unknown>'} uses non-generic handler "${handler || '<missing>'}".`,
			'Use one of plan, research, act, review, or report.',
		);
	}
	if (!agent.projectAgentClassId && !agent.projectAgentClassSlug) {
		add('agent.missing_project_agent_class', 'error', 'projectAgentClassId', 'Agent has no project agent class mapping.', 'Set projectAgentClassId or projectAgentClassSlug so allocation remains independent from handler choice.');
	}
	const context = record(agent.context);
	if (!array(context.queries).length) {
		add('agent.missing_context_queries', 'error', 'context.queries', 'Agent has no TreeDX/API context queries.', 'Declare at least one context query so the runtime can build scoped context through TreeDX/API handles.');
	}
	const handlerConfig = record(agent.handlerConfig);
	if (!handlerConfig.domain) {
		add('agent.output_contract_ambiguous', 'warning', 'handlerConfig.domain', 'Agent has no handlerConfig.domain.', 'Declare the domain, such as documentation_mutation, governance_review, or workday_report.');
	}
	const execution = record(agent.execution);
	const providerProfile = record(execution.providerProfile);
	const requiredCapabilities = stringArray(providerProfile.requiredCapabilities);
	if (!requiredCapabilities.length) {
		add('agent.missing_required_capabilities', 'error', 'execution.providerProfile.requiredCapabilities', 'Agent does not declare execution-provider capability requirements.', 'Declare required capabilities used by API/provider assignment.');
	}
	const allowedPaths = stringArray(execution.allowedPaths ?? record(handlerConfig.metadata).allowedPaths);
	const forbiddenPaths = stringArray(execution.forbiddenPaths ?? record(handlerConfig.metadata).forbiddenPaths);
	if (handler === 'act' && (!allowedPaths.length || !forbiddenPaths.length)) {
		add('agent.act_missing_path_constraints', 'error', 'execution.allowedPaths', 'Act agent is missing explicit allowed or forbidden path constraints.', 'Set allowedPaths and forbiddenPaths for every mutating act agent.');
	}
	const domain = String(handlerConfig.domain ?? '');
	const contentLike = /content|documentation|knowledge/u.test(domain) || allowedPaths.some((path) => /src\/content|docs|knowledge/u.test(path));
	if (handler === 'act' && contentLike && !requiredCapabilities.some((capability) => /treedx|workspace|content:write|files:write/u.test(capability))) {
		add('agent.content_write_requires_treedx', 'error', 'execution.providerProfile.requiredCapabilities', 'Content-writing act agent does not require TreeDX workspace/write capability.', 'Add a TreeDX workspace or files:write capability requirement.');
	}
	if ((handler === 'review' || /governance/u.test(domain)) && !record(agent.metadata).governance && !record(handlerConfig.metadata).governance) {
		add('agent.governance_frontmatter_missing', 'warning', 'metadata.governance', 'Governance or review agent has no governance metadata.', 'Add governance frontmatter or handlerConfig metadata describing policy scope.');
	}
	const outputs = record(agent.outputs);
	if (!Object.keys(outputs).length) {
		add('agent.output_contract_ambiguous', 'error', 'outputs', 'Agent has no explicit output contract.', 'Declare message/model output contracts so AgentKernel can validate results.');
	}
	if (typeof execution.provider === 'string' || typeof execution.providerId === 'string') {
		add('agent.execution_provider_too_specific', 'warning', 'execution', 'Agent pins a provider directly instead of declaring capability requirements.', 'Prefer providerProfile.requiredCapabilities and let API/provider assignment select the execution provider.');
	}
	const localDependency = stringArray(record(handlerConfig.metadata).requiredLocalPaths).length > 0
		|| stringArray(record(agent.metadata).requiredLocalPaths).length > 0;
	if (contentLike && localDependency) {
		add('agent.local_filesystem_content_dependency', 'warning', 'handlerConfig.metadata.requiredLocalPaths', 'Content agent declares local filesystem content dependencies.', 'Move content access to TreeDX context queries or assignment-scoped TreeDX tools.');
	}
	return diagnostics;
}

export function summarizeAgentAuthoringDiagnostics(specs: Array<AgentRuntimeSpec | Record<string, unknown>>) {
	const diagnostics = specs.flatMap((spec) => diagnoseAgentAuthoring(spec));
	return {
		ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
		diagnostics,
	};
}
