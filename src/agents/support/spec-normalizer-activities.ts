import type { AgentActivityProfile, AgentActivityType, AgentBranchPolicy, AgentChatProfileConfiguration, AgentDefinitionIdentity, AgentHandlerKind, AgentOutputContract, AgentQuestionPolicy } from '@treeseed/sdk/types/agents';
import { validateAgentActivityProfilesConfiguration } from '@treeseed/sdk/agent-capacity';
import type { AgentSpecDiagnostic } from './spec-types.ts';
import { normalizeContentAccess, normalizeToolPolicy } from './spec-normalizer-policy.ts';
import { ACTIVITY_TYPES, GENERIC_HANDLER_KINDS, ensureBoolean, ensureString, isPlainObject } from './spec-normalizer-primitives.ts';

function normalizeOutputs(
	value: unknown,
	_diagnostics: AgentSpecDiagnostic[],
	_slug: string,
): AgentOutputContract {
	const next = isPlainObject(value) ? value : {};
	return {
		messageTypes: Array.isArray(next.messageTypes) ? next.messageTypes.filter((entry): entry is string => typeof entry === 'string') : [],
		modelMutations: Array.isArray(next.modelMutations) ? next.modelMutations.filter((entry): entry is string => typeof entry === 'string') : [],
	};
}

function normalizeBranchPolicy(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string): AgentBranchPolicy {
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be an object.`,
		});
		return { kind: 'read-only', base: 'main' };
	}
	const kind = typeof value.kind === 'string' ? value.kind : 'read-only';
	switch (kind) {
		case 'read-only':
			return { kind, base: value.base === 'staging' ? 'staging' : 'main' };
		case 'main-planning-content':
			return { kind, base: 'main' };
		case 'staging-content':
			return { kind, base: 'staging' };
		case 'assignment-feature':
			return {
				kind,
				base: 'staging',
				target: 'staging',
				prefix: typeof value.prefix === 'string' ? value.prefix : undefined,
				branchNameTemplate: typeof value.branchNameTemplate === 'string' ? value.branchNameTemplate : 'agent/{agentSlug}/{assignmentId}',
				worktree: value.worktree === 'reuse' ? 'reuse' : 'new',
				updateBaseBeforeRun: value.updateBaseBeforeRun !== false,
				mergeTargetBeforeSave: value.mergeTargetBeforeSave !== false,
			};
		case 'staging-release':
			return { kind, base: 'staging', target: 'main' };
		default:
			diagnostics.push({
				severity: 'error',
				slug,
				field: `${field}.kind`,
				message: `Unsupported branch policy "${kind}".`,
			});
			return { kind: 'read-only', base: 'main' };
	}
}

function normalizeQuestionPolicy(value: unknown, field: string, diagnostics: AgentSpecDiagnostic[], slug: string): AgentQuestionPolicy | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field,
			message: `Expected ${field} to be an object.`,
		});
		return undefined;
	}
	return value as AgentQuestionPolicy;
}

export function normalizeIdentity(value: unknown, diagnostics: AgentSpecDiagnostic[], slug: string): AgentDefinitionIdentity | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({ severity: 'error', slug, field: 'identity', message: 'Expected identity to be an object.' });
		return undefined;
	}
	return {
		purpose: typeof value.purpose === 'string' ? value.purpose : '',
		responsibilities: Array.isArray(value.responsibilities) ? value.responsibilities.filter((entry): entry is string => typeof entry === 'string') : [],
		durableInstructions: typeof value.durableInstructions === 'string' ? value.durableInstructions : '',
	};
}

function normalizeActivityProfile(
	value: unknown,
	activityType: AgentActivityType,
	diagnostics: AgentSpecDiagnostic[],
	slug: string,
): AgentActivityProfile | null {
	const field = `activityProfiles.${activityType}`;
	if (!isPlainObject(value)) {
		diagnostics.push({ severity: 'error', slug, field, message: `Expected ${field} to be an object.` });
		return null;
	}
	const enabled = ensureBoolean(value.enabled, `${field}.enabled`, diagnostics, slug, true);
	const handler = ensureString(value.handler, `${field}.handler`, diagnostics, slug) as AgentHandlerKind;
	if (!GENERIC_HANDLER_KINDS.has(handler)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: `${field}.handler`,
			message: `Unsupported first-party handler "${handler}". Use writer, actor, estimate, releaser, or reporter.`,
		});
	}
	const prompt = isPlainObject(value.prompt) ? value.prompt : {};
	if (!isPlainObject(value.prompt)) {
		diagnostics.push({ severity: 'error', slug, field: `${field}.prompt`, message: `Expected ${field}.prompt to be an object.` });
	}
	const execution = isPlainObject(value.execution) ? value.execution : {};
	return {
		enabled,
		handler: handler as AgentActivityProfile['handler'],
		prompt: {
			system: ensureString(prompt.system, `${field}.prompt.system`, diagnostics, slug),
			task: typeof prompt.task === 'string' ? prompt.task : undefined,
			templates: isPlainObject(prompt.templates) ? prompt.templates as Record<string, string> : undefined,
		},
		branchPolicy: normalizeBranchPolicy(value.branchPolicy, `${field}.branchPolicy`, diagnostics, slug),
		contentAccess: normalizeContentAccess(value.contentAccess, diagnostics, slug, `${field}.contentAccess`),
		tools: normalizeToolPolicy(value.tools, `${field}.tools`, enabled, diagnostics, slug),
		signals: isPlainObject(value.signals) ? value.signals as AgentActivityProfile['signals'] : undefined,
		outputs: normalizeOutputs(value.outputs, diagnostics, slug),
		planningIntent: isPlainObject(value.planningIntent) ? value.planningIntent as AgentActivityProfile['planningIntent'] : undefined,
		questionPolicy: normalizeQuestionPolicy(value.questionPolicy, `${field}.questionPolicy`, diagnostics, slug),
		execution: {
			...execution,
			maxTotalTokens: Number.isInteger(execution.maxTotalTokens) && Number(execution.maxTotalTokens) > 0 ? Number(execution.maxTotalTokens) : 136_000,
			warningTokens: Number.isInteger(execution.warningTokens) && Number(execution.warningTokens) > 0 ? Number(execution.warningTokens) : 100_000,
			enforcementConfidence: ['exact', 'bounded', 'estimated', 'opaque'].includes(String(execution.enforcementConfidence)) ? execution.enforcementConfidence : 'bounded',
		} as AgentActivityProfile['execution'],
	};
}


function normalizeChatSpecialization(value: unknown, diagnostics: AgentSpecDiagnostic[], slug: string): AgentChatProfileConfiguration {
	if (!isPlainObject(value)) {
		return { foundation: 'discussion-v1' };
	}
	if (value.foundation !== 'discussion-v1') diagnostics.push({ severity: 'error', slug, field: 'chatProfile.foundation', message: 'chatProfile.foundation must be discussion-v1.' });
	return {
		foundation: 'discussion-v1',
		responseStyle: typeof value.responseStyle === 'string' ? value.responseStyle : undefined,
		promptTask: typeof value.promptTask === 'string' ? value.promptTask : undefined,
		providerPreference: Array.isArray(value.providerPreference) ? value.providerPreference.map(String).filter(Boolean) : undefined,
		maxRuntimeSeconds: typeof value.maxRuntimeSeconds === 'number' ? value.maxRuntimeSeconds : undefined,
		maxTotalTokens: typeof value.maxTotalTokens === 'number' ? value.maxTotalTokens : undefined,
		warningTokens: typeof value.warningTokens === 'number' ? value.warningTokens : undefined,
		maxCostAmount: typeof value.maxCostAmount === 'number' ? value.maxCostAmount : undefined,
		costCurrency: typeof value.costCurrency === 'string' ? value.costCurrency : undefined,
		toolAdditions: Array.isArray(value.toolAdditions) ? value.toolAdditions.map(String).filter(Boolean) : undefined,
		contextModels: Array.isArray(value.contextModels) ? value.contextModels.map(String).filter(Boolean) : undefined,
	};
}

function defaultChatProfile(slug: string, specialization: AgentChatProfileConfiguration): AgentActivityProfile {
	const contextModels = [...new Set(['discussion', 'discussion_message', 'discussion_event', 'agent', 'note', 'question', 'proposal', 'decision', 'objective', 'knowledge', ...(specialization.contextModels ?? [])])];
	const tools = [...new Set(['treeseed.content.describe', 'treeseed.content.query', 'treeseed.content.read', 'treedx.build_context', 'treedx.read_repository_files', 'treedx.search_workspace', 'treedx.read_workspace_file', 'treeseed.content.create', 'treeseed.content.update', 'treeseed.content.link', 'treeseed.content.validate', 'treeseed.content.commit', 'treeseed.status', ...(specialization.toolAdditions ?? [])])];
	return {
		enabled: true,
		handler: 'writer',
		prompt: {
			system: `Participate as ${slug} in a TreeSeed Discussion. Answer from your configured identity and durable instructions, cite exact TreeDX content or repository refs, distinguish evidence from inference, and keep the response scoped to the current turn. You may create or update discussion messages, linked notes, questions, and proposals. Never change knowledge or code without an approved governed acting assignment.${specialization.responseStyle ? ` Response style: ${specialization.responseStyle}` : ''}`,
			task: specialization.promptTask ?? 'Respond to the committed Discussion turn and produce durable, source-grounded output.',
		},
		branchPolicy: { kind: 'staging-content', base: 'staging' },
		contentAccess: {
			read: { models: contextModels, actions: ['describe', 'query', 'read'] },
			write: { models: ['discussion_message', 'note', 'question', 'proposal'], actions: ['create', 'update', 'link', 'validate', 'commit'], paths: ['src/content/discussion-messages/**', 'src/content/notes/**', 'src/content/questions/**', 'src/content/proposals/**'] },
			commit: { allowed: true },
		},
		tools: { allowed: tools },
		outputs: { messageTypes: ['discussion_response'], modelMutations: ['discussion_message:create', 'linked_note:create', 'question:create', 'proposal:create'] },
		questionPolicy: { blockExecutionWhenCreated: false, defaultAnswerPolicy: { kind: 'team-human' } },
		execution: { providerPreference: specialization.providerPreference ?? ['codex-treeseed', 'codex-sub', 'codex-key'], maxRuntimeSeconds: specialization.maxRuntimeSeconds ?? 900, maxRetries: 1, verificationRequired: false, maxTotalTokens: specialization.maxTotalTokens ?? 136_000, warningTokens: specialization.warningTokens ?? 100_000, maxCostAmount: specialization.maxCostAmount, costCurrency: specialization.costCurrency ?? 'USD', pricingGeneration: 'provider-runtime', enforcementConfidence: 'bounded' },
	};
}

export function normalizeActivityProfiles(value: unknown, diagnostics: AgentSpecDiagnostic[], slug: string, chatProfile?: unknown) {
	if (!isPlainObject(value)) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'activityProfiles',
			message: 'Expected activityProfiles to be an object.',
		});
		return {};
	}
	for (const diagnostic of validateAgentActivityProfilesConfiguration(value).diagnostics) {
		diagnostics.push({ severity: 'error', slug, field: diagnostic.path, message: diagnostic.message });
	}
	const profiles: Partial<Record<AgentActivityType, AgentActivityProfile>> = {};
	for (const [key, profile] of Object.entries(value)) {
		if (!ACTIVITY_TYPES.has(key)) {
			diagnostics.push({
				severity: 'error',
				slug,
				field: `activityProfiles.${key}`,
				message: `Unsupported activity profile "${key}".`,
			});
			continue;
		}
		const normalized = normalizeActivityProfile(profile, key as AgentActivityType, diagnostics, slug);
		if (normalized) profiles[key as AgentActivityType] = normalized;
	}
	profiles.chat ??= defaultChatProfile(slug, normalizeChatSpecialization(chatProfile, diagnostics, slug));
	return profiles;
}

export function selectDefaultActivityProfile(
	profiles: Partial<Record<AgentActivityType, AgentActivityProfile>>,
): [AgentActivityType, AgentActivityProfile] | null {
	for (const activity of ['acting', 'estimating', 'planning', 'reviewing', 'reporting', 'chat'] as const) {
		const profile = profiles[activity];
		if (profile?.enabled) return [activity, profile];
	}
	return null;
}
