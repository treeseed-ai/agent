import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';

export type AgentAuthoringDiagnosticCode =
	| 'agent.handler_not_profile_handler'
	| 'agent.missing_project_agent_class'
	| 'agent.missing_activity_profiles'
	| 'agent.missing_context_queries'
	| 'agent.missing_required_capabilities'
	| 'agent.actor_missing_path_constraints'
	| 'agent.content_write_requires_treedx'
	| 'agent.mutation_output_requires_content_commit'
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

const PROFILE_HANDLERS = new Set(['writer', 'actor', 'estimate', 'releaser', 'reporter']);

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown) {
	return array(value).filter((entry): entry is string => typeof entry === 'string');
}

function profileEntries(agent: Record<string, unknown>) {
	const profiles = record(agent.activityProfiles);
	return Object.entries(profiles).filter(([, value]) => record(value).enabled !== false);
}

function profilePath(activity: string, field: string) {
	return `activityProfiles.${activity}.${field}`;
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
	if (handler && !PROFILE_HANDLERS.has(handler)) {
		add(
			'agent.handler_not_profile_handler',
			'error',
			'handler',
			`Agent ${slug ?? '<unknown>'} uses unsupported handler "${handler}".`,
			'Use one of writer, actor, estimate, releaser, or reporter through an activity profile.',
		);
	}
	if (!agent.projectAgentClassId && !agent.projectAgentClassSlug) {
		add('agent.missing_project_agent_class', 'error', 'projectAgentClassId', 'Agent has no project agent class mapping.', 'Set projectAgentClassId or projectAgentClassSlug so allocation remains independent from handler choice.');
	}
	const profiles = profileEntries(agent);
	const hasProfiles = profiles.length > 0;
	if (!hasProfiles) {
		add('agent.missing_activity_profiles', 'error', 'activityProfiles', 'Agent has no enabled activity profiles.', 'Declare activityProfiles for planning, estimating, acting, reviewing, reporting, or releaser work.');
	}
	const fallbackProfile = {
		handler,
		context: record(agent.context),
		execution: record(agent.execution),
		outputs: record(agent.outputs),
		contentAccess: record(agent.contentAccess),
	};
	const entries = hasProfiles ? profiles : [['runtime', fallbackProfile] as [string, unknown]];
	for (const [activity, rawProfile] of entries) {
		const profile = record(rawProfile);
		const profileHandler = typeof profile.handler === 'string' ? profile.handler : handler;
		if (profileHandler && !PROFILE_HANDLERS.has(profileHandler)) {
			add(
				'agent.handler_not_profile_handler',
				'error',
				profilePath(activity, 'handler'),
				`Agent ${slug ?? '<unknown>'} activity ${activity} uses unsupported handler "${profileHandler}".`,
				'Use one of writer, actor, estimate, releaser, or reporter.',
			);
		}
		const context = record(profile.context);
		const contentAccess = record(profile.contentAccess);
		const readModels = stringArray(contentAccess.readModels);
		if (!array(context.queries).length && !readModels.length) {
			add('agent.missing_context_queries', 'error', profilePath(activity, 'context.queries'), 'Activity profile has no TreeDX/API context queries or readable content models.', 'Declare context queries or contentAccess.readModels so runtime context is scoped through TreeDX/API handles.');
		}
		const execution = record(profile.execution);
		const requiredCapabilities = stringArray(execution.requiredCapabilities ?? record(execution.providerProfile).requiredCapabilities);
		if (!requiredCapabilities.length) {
			add('agent.missing_required_capabilities', 'error', profilePath(activity, 'execution.requiredCapabilities'), 'Activity profile does not declare execution-provider capability requirements.', 'Declare required capabilities used by API/provider assignment.');
		}
		const allowedPaths = stringArray(execution.allowedPaths);
		const forbiddenPaths = stringArray(execution.forbiddenPaths);
		if (profileHandler === 'actor' && (!allowedPaths.length || !forbiddenPaths.length)) {
			add('agent.actor_missing_path_constraints', 'error', profilePath(activity, 'execution.allowedPaths'), 'Actor activity profile is missing explicit allowed or forbidden path constraints.', 'Set allowedPaths and forbiddenPaths for every mutating actor profile.');
		}
		const contentLike = readModels.some((model) => /content|documentation|knowledge|note|question|proposal|decision/u.test(model))
			|| allowedPaths.some((path) => /src\/content|docs\/src\/content|knowledge/u.test(path));
		if (profileHandler === 'actor' && contentLike && !requiredCapabilities.some((capability) => /treedx|workspace|content:write|files:write/u.test(capability))) {
			add('agent.content_write_requires_treedx', 'error', profilePath(activity, 'execution.requiredCapabilities'), 'Content-writing actor profile does not require TreeDX workspace/write capability.', 'Add a TreeDX workspace or files:write capability requirement.');
		}
		const outputs = record(profile.outputs);
		if (!Object.keys(outputs).length) {
			add('agent.output_contract_ambiguous', 'error', profilePath(activity, 'outputs'), 'Activity profile has no explicit output contract.', 'Declare content, tool, signal, or terminal output contracts so AgentKernel can validate results.');
		}
		const modelMutations = stringArray(outputs.modelMutations);
		const commitAllowed = record(contentAccess.commit).allowed === true;
		const branchKind = typeof record(profile.branchPolicy).kind === 'string'
			? String(record(profile.branchPolicy).kind)
			: '';
		const allowedTools = stringArray(record(profile.tools).allowed);
		if (modelMutations.length > 0 && (
			!commitAllowed
			|| branchKind === 'read-only'
			|| !allowedTools.includes('treeseed.content.create')
			|| !allowedTools.includes('treeseed.content.commit')
		)) {
			add(
				'agent.mutation_output_requires_content_commit',
				'error',
				profilePath(activity, 'outputs.modelMutations'),
				'Activity profile promises model mutations but cannot create and commit TreeSeed content through TreeDX.',
				'Use a writable content branch, allow content commits, and grant treeseed.content.create plus treeseed.content.commit.',
			);
		}
		if (typeof execution.provider === 'string' || typeof execution.providerId === 'string') {
			add('agent.execution_provider_too_specific', 'warning', profilePath(activity, 'execution'), 'Activity profile pins a provider directly instead of declaring capability requirements.', 'Prefer execution.requiredCapabilities and let API/provider assignment select the execution provider.');
		}
		const localDependency = stringArray(record(profile.metadata).requiredLocalPaths).length > 0
			|| stringArray(record(agent.metadata).requiredLocalPaths).length > 0;
		if (contentLike && localDependency) {
			add('agent.local_filesystem_content_dependency', 'warning', profilePath(activity, 'metadata.requiredLocalPaths'), 'Content profile declares local filesystem content dependencies.', 'Move content access to TreeDX context queries or assignment-scoped TreeDX tools.');
		}
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
