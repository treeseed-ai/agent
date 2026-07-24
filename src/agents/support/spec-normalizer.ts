import { AGENT_CLI_ALLOW_TOOLS, type AgentHandlerKind, type AgentTriggerConfig } from '@treeseed/sdk/types/agents';
import { AGENT_MESSAGE_TYPES } from '../contracts/messages.ts';
import { normalizeAgentCliOptions } from '../cli-tools.ts';
import { normalizeActivityProfiles, normalizeIdentity, selectDefaultActivityProfile } from './spec-normalizer-activities.ts';
import { normalizeExecution } from './spec-normalizer-execution.ts';
import { normalizePermissionPolicy, normalizeTrigger } from './spec-normalizer-policy.ts';
import { LEGACY_AGENT_FIELDS, ensureBoolean, ensureString, isPlainObject } from './spec-normalizer-primitives.ts';
import type {
	AgentSpecDiagnostic,
	AgentSpecNormalizationResult,
	AgentSpecParts,
	AgentSpecValidationContext,
	NormalizedAgentRuntimeSpec,
	RawAgentRuntimeSpec,
} from './spec-types.ts';

function normalizeParts(
	raw: RawAgentRuntimeSpec,
	slugHint: string,
	diagnostics: AgentSpecDiagnostic[],
): AgentSpecParts | null {
	const slug = ensureString(raw.slug ?? slugHint, 'slug', diagnostics, slugHint) || slugHint;
	for (const field of LEGACY_AGENT_FIELDS) {
		if (raw[field] !== undefined) {
			diagnostics.push({
				severity: 'error',
				slug,
				field,
				message: `${field} is legacy top-level agent configuration. Move it under activityProfiles.<activity>.`,
			});
		}
	}
	const activityProfiles = normalizeActivityProfiles(raw.activityProfiles, diagnostics, slug);
	const selected = selectDefaultActivityProfile(activityProfiles);
	if (!selected) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'activityProfiles',
			message: 'Expected at least one enabled activity profile.',
		});
		return null;
	}
	const [activityType, profile] = selected;
	const handler = profile.handler as AgentHandlerKind;
	const triggers = Array.isArray(raw.triggers)
		? raw.triggers.map((entry, index) => normalizeTrigger(entry, index, diagnostics, slug)).filter((entry): entry is AgentTriggerConfig => Boolean(entry))
		: [];
	if (!triggers.length) {
		triggers.push({ type: 'startup', runOnStart: true });
	}
	try {
		const cli = normalizeAgentCliOptions(raw.cli);
		const enabled = ensureBoolean(raw.enabled, 'enabled', diagnostics, slug, true);
		const spec: AgentSpecParts = {
			slug,
			handler,
			activityType,
			activityProfiles,
			branchPolicy: profile.branchPolicy,
			questionPolicy: profile.questionPolicy,
			identity: normalizeIdentity(raw.identity, diagnostics, slug),
			projectAgentClassId: ensureString(
				raw.projectAgentClassId ?? raw.agentClassId ?? raw.agentClass,
				'projectAgentClassId',
				diagnostics,
				slug,
			),
			projectAgentClassSlug: ensureString(
				raw.projectAgentClassSlug ?? raw.agentClassSlug ?? raw.projectAgentClassId ?? raw.agentClassId ?? raw.agentClass,
				'projectAgentClassSlug',
				diagnostics,
				slug,
			),
			activityConfig: {
				workPackageKind: profile.handler,
				domain: activityType,
				activityType,
				branchPolicy: profile.branchPolicy,
				questionPolicy: profile.questionPolicy,
			},
			enabled,
			systemPrompt: profile.prompt.system,
			persona: typeof raw.persona === 'string' ? raw.persona : '',
			cli,
			triggers,
			triggerPolicy: isPlainObject(raw.triggerPolicy)
				? {
					maxRunsPerCycle:
						typeof raw.triggerPolicy.maxRunsPerCycle === 'number' ? raw.triggerPolicy.maxRunsPerCycle : undefined,
					messageBatchSize:
						typeof raw.triggerPolicy.messageBatchSize === 'number' ? raw.triggerPolicy.messageBatchSize : undefined,
				}
				: undefined,
			permissions: [],
			permissionPolicy: normalizePermissionPolicy(raw.permissionPolicy, diagnostics, slug),
			tools: profile.tools,
			contentAccess: profile.contentAccess,
			context: { queries: [] },
			execution: normalizeExecution(raw.execution, diagnostics, slug),
			outputs: profile.outputs,
		};
		return spec;
	} catch (error) {
		diagnostics.push({
			severity: 'error',
			slug,
			field: 'cli',
			message: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export function normalizeAgentRuntimeSpec(
	raw: RawAgentRuntimeSpec,
	context: AgentSpecValidationContext,
): AgentSpecNormalizationResult {
	const slugHint = typeof raw.slug === 'string' && raw.slug ? raw.slug : 'unknown-agent';
	const diagnostics: AgentSpecDiagnostic[] = [];
	const parts = normalizeParts(raw, slugHint, diagnostics);
	if (!parts) {
		return { spec: null, diagnostics };
	}

	const spec: NormalizedAgentRuntimeSpec = {
		...parts,
		name: typeof raw.name === 'string' ? raw.name : undefined,
		description: typeof raw.description === 'string' ? raw.description : undefined,
		summary: typeof raw.summary === 'string' ? raw.summary : undefined,
		operator: typeof raw.operator === 'string' ? raw.operator : undefined,
		runtimeStatus: typeof raw.runtimeStatus === 'string' ? raw.runtimeStatus : undefined,
		capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.filter((entry): entry is string => typeof entry === 'string') : [],
		tags: Array.isArray(raw.tags) ? raw.tags.filter((entry): entry is string => typeof entry === 'string') : [],
	};

	if (!context.registeredHandlers.includes(spec.handler)) {
		diagnostics.push({
			severity: 'error',
			slug: spec.slug,
			field: 'handler',
			message: `No runtime handler is registered for "${spec.handler}".`,
		});
	}

	for (const trigger of spec.triggers) {
		if (trigger.type === 'message') {
			for (const messageType of trigger.messageTypes ?? []) {
				if (
					!context.messageTypes.includes(messageType)
					|| !AGENT_MESSAGE_TYPES.includes(messageType as (typeof AGENT_MESSAGE_TYPES)[number])
				) {
					diagnostics.push({
						severity: 'error',
						slug: spec.slug,
						field: 'triggers.messageTypes',
						message: `Unknown message trigger type "${messageType}".`,
					});
				}
			}
		}
		if (trigger.type === 'follow' && !(trigger.models?.length)) {
			diagnostics.push({
				severity: 'error',
				slug: spec.slug,
				field: 'triggers.models',
				message: 'Follow triggers must declare at least one model.',
			});
		}
	}

	for (const messageType of spec.outputs.messageTypes) {
		if (
			!context.messageTypes.includes(messageType)
			|| !AGENT_MESSAGE_TYPES.includes(messageType as (typeof AGENT_MESSAGE_TYPES)[number])
		) {
			diagnostics.push({
				severity: 'error',
				slug: spec.slug,
				field: 'outputs.messageTypes',
				message: `Unknown emitted message type "${messageType}".`,
			});
		}
	}

	if (spec.cli.allowTools?.some((tool) => !AGENT_CLI_ALLOW_TOOLS.includes(tool))) {
		diagnostics.push({
			severity: 'error',
			slug: spec.slug,
			field: 'cli.allowTools',
			message: 'Agent declared an unsupported tool allowance.',
		});
	}

	return {
		spec: diagnostics.some((entry) => entry.severity === 'error') ? null : spec,
		diagnostics,
	};
}

