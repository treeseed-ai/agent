import {
	DEFAULT_EXECUTION_PROFILES,
	DEFAULT_TASK_ADMISSION_POLICY,
	decideTaskAdmission,
	estimateAttentionForTask,
	estimateForClassification,
	estimateUtilityForTask,
	normalizeHybridExecutionPlan,
	normalizeExecutionProfile,
	normalizeTaskAdmissionPolicy,
	predictReserveForCapacityPlan,
	routeAndReserveCapacity,
	type CapacityPlan,
	type CapacityEstimateConfidence,
	type CapacityTaskExecutionEnvelope,
	type ExecutionProfile,
	type AttentionEstimate,
	type HybridExecutionPlan,
	type ReservePrediction,
	type RouteAndReserveResult,
	type TaskAdmissionDecision,
	type TaskAdmissionPolicy,
	type TaskClassification,
	type TaskMutationScope,
	type TaskRiskClass,
	type UtilityEstimate,
	type WorkdayPolicy,
} from '@treeseed/sdk';

type TaskPayload = Record<string, unknown>;
type WorkDayRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if (typeof value === 'string' && value.trim()) {
			const parsed = Number.parseFloat(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return null;
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return '';
}

function readBoolean(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'boolean') return value;
		if (typeof value === 'string' && value.trim()) return value === 'true';
	}
	return null;
}

function parsePayloadJson(value: unknown) {
	if (isRecord(value)) return value;
	if (typeof value !== 'string' || !value.trim()) return {};
	try {
		const parsed = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function taskSignatureFor(type: string, payload: TaskPayload) {
	if (typeof payload.taskSignature === 'string' && payload.taskSignature.trim()) {
		return payload.taskSignature.trim();
	}
	if (type === 'planning_task') return 'planner.dag_proposal';
	if (type === 'refresh_project_graph') return 'system.refresh_graph';
	if (type === 'scan_codebase_documentation_surface') return 'system.scan_codebase_documentation_surface';
	if (type === 'agent_trigger' || type === 'agent_root') return 'agent.activation';
	if (type === 'research_question') return 'researcher.research_question';
	if (type === 'generate_knowledge_draft') return 'knowledge.generate_draft';
	if (type === 'optimize_knowledge_draft') return 'knowledge.optimize_draft';
	if (type === 'promote_knowledge_draft_request' || type === 'promote_knowledge_to_staging') return 'review.promote_request';
	if (type === 'apply_approved_docs_mutation') return 'docs.apply_approved_mutation';
	if (type === 'create_repair_task') return 'docs.create_repair_task';
	if (type === 'release_staged_knowledge_request') return 'review.promote_request';
	if (readString(payload, 'executionKind') === 'workflow_dispatch' || readString(payload, 'executionKind') === 'sdk_dispatch') return 'workflow.dispatch';
	if (type.endsWith('_review')) return 'agent.activation';
	return type ? type.replace(/_/g, '.') : 'unknown';
}

function defaultCreditsForSignature(signature: string) {
	if (signature === 'system.refresh_graph') return 1;
	if (signature === 'system.scan_codebase_documentation_surface') return 1;
	if (signature === 'agent.activation') return 1;
	if (signature === 'researcher.research_question') return 3;
	if (signature === 'knowledge.generate_draft') return 5;
	if (signature === 'knowledge.optimize_draft') return 4;
	if (signature === 'review.promote_request') return 2;
	if (signature === 'docs.apply_approved_mutation') return 5;
	if (signature === 'docs.create_repair_task') return 1;
	if (signature === 'workflow.dispatch') return 3;
	if (signature === 'planner.dag_proposal') return 2;
	return 2;
}

function riskFor(type: string, payload: TaskPayload): TaskRiskClass {
	const explicit = readString(payload, 'risk');
	if (explicit === 'low' || explicit === 'medium' || explicit === 'high') return explicit;
	if (type === 'promote_knowledge_to_staging' || type === 'apply_approved_docs_mutation' || type === 'release_staged_knowledge_request') return 'high';
	if (readString(payload, 'executionKind') === 'workflow_dispatch') return 'medium';
	return 'low';
}

function mutationScopeFor(type: string, payload: TaskPayload): TaskMutationScope {
	const explicit = readString(payload, 'mutationScope');
	if (explicit === 'none' || explicit === 'repository_read' || explicit === 'repository_write' || explicit === 'production') return explicit;
	if (type === 'planning_task') return 'none';
	if (type === 'scan_codebase_documentation_surface') return 'none';
	if (type === 'create_repair_task') return 'none';
	if (type === 'promote_knowledge_to_staging') return 'repository_write';
	if (type === 'apply_approved_docs_mutation') return 'repository_write';
	if (type === 'release_staged_knowledge_request') return 'production';
	if (readString(payload, 'executionKind') === 'workflow_dispatch') return 'repository_read';
	return 'repository_read';
}

function executionProfileFor(classification: TaskClassification, payload: TaskPayload): ExecutionProfile {
	const explicit = readString(payload, 'executionProfileId', 'executionProfile');
	if (explicit) return normalizeExecutionProfile(explicit);
	if (classification.taskSignature === 'review.promote_request' && classification.mutationScope === 'production') {
		return normalizeExecutionProfile('human-review');
	}
	if (classification.risk === 'high' || classification.expectedFanout > 2) {
		return normalizeExecutionProfile('large-reasoning-model');
	}
	if (classification.mutationScope === 'none' || classification.mutationScope === 'repository_read') {
		return normalizeExecutionProfile('local-runner');
	}
	return normalizeExecutionProfile('standard-code-model');
}

function readStringArray(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (Array.isArray(value)) {
			const values = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
				.map((entry) => entry.trim());
			if (values.length > 0) return values;
		}
		if (typeof value === 'string' && value.trim()) {
			const values = value.split(',').map((entry) => entry.trim()).filter(Boolean);
			if (values.length > 0) return values;
		}
	}
	return [];
}

function distinctProfileIds(ids: string[]) {
	const known = new Set(Object.keys(DEFAULT_EXECUTION_PROFILES));
	const seen = new Set<string>();
	return ids
		.map((id) => id.trim())
		.filter((id) => id.length > 0)
		.filter((id) => {
			if (seen.has(id)) return false;
			seen.add(id);
			return known.has(id) || id.includes('-');
		});
}

function candidateExecutionProfileIds(classification: TaskClassification, payload: TaskPayload) {
	const preferred = readStringArray(payload, 'preferredExecutionProfiles', 'executionProfiles');
	const explicit = readString(payload, 'executionProfileId', 'executionProfile');
	if (preferred.length > 0) return distinctProfileIds(preferred);
	if (explicit) return distinctProfileIds([explicit]);
	if (classification.taskSignature === 'review.promote_request' && classification.mutationScope === 'production') {
		return ['human-review', 'large-reasoning-model', 'long-context-architect'];
	}
	if (classification.risk === 'high' || classification.mutationScope === 'production') {
		return ['large-reasoning-model', 'long-context-architect', 'standard-code-model'];
	}
	if (classification.expectedFanout > 2 || classification.confidence === 'low') {
		return ['standard-code-model', 'large-reasoning-model', 'small-code-model'];
	}
	if (classification.mutationScope === 'none' || classification.mutationScope === 'repository_read') {
		return ['local-runner', 'local-fast-model', 'small-code-model', 'standard-code-model'];
	}
	return ['small-code-model', 'standard-code-model', 'large-reasoning-model'];
}

function routeBlockOutcome(route: Extract<RouteAndReserveResult, { ok: false }>): TaskAdmissionDecision['outcome'] {
	if (route.code === 'approval_required') return 'approval_required';
	if (route.code === 'insufficient_budget') return 'budget_blocked';
	return 'deferred';
}

function minimumQualityWeightFor(classification: TaskClassification, payload: TaskPayload) {
	const explicit = readNumber(payload, 'minimumQualityWeight');
	if (explicit !== null) return explicit;
	if (classification.mutationScope === 'production') return 1.5;
	if (classification.risk === 'high') return 1.25;
	if (classification.confidence === 'low') return 1.1;
	if (classification.mutationScope === 'repository_write') return 0.75;
	return 0;
}

function attentionPayloadOverrides(payload: TaskPayload) {
	return {
		attentionWeight: readNumber(payload, 'attentionWeight'),
		estimatedContextTokens: readNumber(payload, 'estimatedContextTokens', 'contextTokens'),
		coordinationWeight: readNumber(payload, 'coordinationWeight'),
		minimumAttentionAvailable: readNumber(payload, 'minimumAttentionAvailable'),
		requiredContextTokens: readNumber(payload, 'requiredContextTokens'),
	};
}

function utilityPayloadOverrides(payload: TaskPayload) {
	const metadata = isRecord(payload.metadata) ? payload.metadata : {};
	return {
		utilityValue: readNumber(payload, 'utilityValue') ?? readNumber(metadata, 'utilityValue'),
		maintenanceValue: readNumber(payload, 'maintenanceValue') ?? readNumber(metadata, 'maintenanceValue'),
		deadlineAt: readString(payload, 'deadlineAt') || readString(metadata, 'deadlineAt') || null,
		successProbability: readNumber(payload, 'successProbability') ?? readNumber(metadata, 'successProbability'),
		trustRequirement: readNumber(payload, 'trustRequirement') ?? readNumber(metadata, 'trustRequirement'),
		cooperativeRouting: readBoolean(payload, 'cooperativeRouting') ?? readBoolean(metadata, 'cooperativeRouting'),
		priority: readNumber(payload, 'priority') ?? readNumber(metadata, 'priority'),
	};
}

function policyRecord(value: unknown) {
	return isRecord(value) ? value : {};
}

export function policyMetadataAdmissionPolicy(policy: WorkdayPolicy): TaskAdmissionPolicy {
	const metadata = isRecord(policy.metadata) ? policy.metadata : {};
	return normalizeTaskAdmissionPolicy({
		planningThresholdCredits: readNumber(metadata, 'planningThresholdCredits') ?? DEFAULT_TASK_ADMISSION_POLICY.planningThresholdCredits,
		approvalThresholdCredits: readNumber(metadata, 'approvalThresholdCredits') ?? DEFAULT_TASK_ADMISSION_POLICY.approvalThresholdCredits,
		reserveBufferPercent: readNumber(metadata, 'reserveBufferPercent') ?? DEFAULT_TASK_ADMISSION_POLICY.reserveBufferPercent,
		recoveryBudgetCredits: readNumber(metadata, 'recoveryBudgetCredits') ?? DEFAULT_TASK_ADMISSION_POLICY.recoveryBudgetCredits,
		maxDownstreamTasks: readNumber(metadata, 'maxDownstreamTasks') ?? DEFAULT_TASK_ADMISSION_POLICY.maxDownstreamTasks,
		maxPlanningDepth: readNumber(metadata, 'maxPlanningDepth') ?? DEFAULT_TASK_ADMISSION_POLICY.maxPlanningDepth,
		maxAdmittedPlanTasksPerCycle: readNumber(metadata, 'maxAdmittedPlanTasksPerCycle') ?? DEFAULT_TASK_ADMISSION_POLICY.maxAdmittedPlanTasksPerCycle,
		planningTaskSignature: readString(metadata, 'planningTaskSignature') || DEFAULT_TASK_ADMISSION_POLICY.planningTaskSignature,
		allowBackfill: typeof metadata.allowBackfill === 'boolean' ? metadata.allowBackfill : DEFAULT_TASK_ADMISSION_POLICY.allowBackfill,
		maxAttentionLoad: readNumber(metadata, 'maxAttentionLoad') ?? DEFAULT_TASK_ADMISSION_POLICY.maxAttentionLoad,
		reserveAttentionPercent: readNumber(metadata, 'reserveAttentionPercent') ?? DEFAULT_TASK_ADMISSION_POLICY.reserveAttentionPercent,
		maxContextTokens: readNumber(metadata, 'maxContextTokens') ?? DEFAULT_TASK_ADMISSION_POLICY.maxContextTokens,
		maxContextSaturationPercent: readNumber(metadata, 'maxContextSaturationPercent') ?? DEFAULT_TASK_ADMISSION_POLICY.maxContextSaturationPercent,
		coordinationOverheadFactor: readNumber(metadata, 'coordinationOverheadFactor') ?? DEFAULT_TASK_ADMISSION_POLICY.coordinationOverheadFactor,
		predictiveReservePolicy: policyRecord(metadata.predictiveReservePolicy),
		utilityPolicy: policyRecord(metadata.utilityPolicy),
	});
}

export function classifyTaskProposal(input: {
	type: string;
	payload?: TaskPayload | null;
}): TaskClassification {
	const payload = input.payload ?? {};
	const signature = taskSignatureFor(input.type, payload);
	const risk = riskFor(input.type, payload);
	const mutationScope = mutationScopeFor(input.type, payload);
	const fanout = Math.max(0, Math.floor(readNumber(payload, 'expectedFanout') ?? 0));
	const confidence = (readString(payload, 'confidence') || (signature === 'agent.activation' ? 'high' : 'medium')) as CapacityEstimateConfidence;
	return {
		taskSignature: signature,
		risk,
		mutationScope,
		concurrencyClass: mutationScope === 'repository_write' || mutationScope === 'production'
			? 'repository_claim'
			: 'read_only',
		expectedFanout: fanout,
		confidence: confidence === 'low' || confidence === 'medium' || confidence === 'high' ? confidence : 'medium',
		requiresPlanning: Boolean(payload.requiresPlanning) || fanout > 4,
		requiresApproval: Boolean(payload.requiresApproval) || mutationScope === 'production',
		features: isRecord(payload.features) ? payload.features : {},
	};
}

export function admissionForTaskProposal(input: {
	type: string;
	payload?: TaskPayload | null;
	workDay: WorkDayRecord;
	policy: WorkdayPolicy;
	capacityPlan?: CapacityPlan | null;
	queuedCredits?: number | null;
	source?: string;
}): {
	classification: TaskClassification;
	executionProfile: ExecutionProfile;
	admission: TaskAdmissionDecision;
	payload: TaskPayload;
	state: string;
	enqueue: boolean;
	capacityEnvelope: CapacityTaskExecutionEnvelope | null;
	route: RouteAndReserveResult | null;
} {
	const basePayload = input.payload ?? {};
	const classification = classifyTaskProposal({ type: input.type, payload: basePayload });
	const fallbackExecutionProfile = executionProfileFor(classification, basePayload);
	const explicitP50 = readNumber(basePayload, 'estimatedCreditsP50');
	const explicitP90 = readNumber(basePayload, 'estimatedCreditsP90');
	const defaultCredits = readNumber(basePayload, 'estimatedCredits') ?? defaultCreditsForSignature(classification.taskSignature);
	const candidateProfileIds = candidateExecutionProfileIds(classification, basePayload);
	const fallbackProfile = normalizeExecutionProfile(candidateProfileIds[0] ?? fallbackExecutionProfile.id);
	const attentionOverrides = attentionPayloadOverrides(basePayload);
	const utilityOverrides = utilityPayloadOverrides(basePayload);
	const baseEstimate = estimateForClassification({
		classification,
		estimatedCreditsP50: explicitP50 ?? undefined,
		estimatedCreditsP90: explicitP90 ?? explicitP50 ?? undefined,
		defaultCredits,
		executionProfile: fallbackProfile,
		executionProfileId: fallbackProfile.id,
		profiles: input.capacityPlan?.estimateProfiles ?? null,
	});
	const policySnapshot = policyMetadataAdmissionPolicy(input.policy);
	const hybridExecutionPlan = normalizeHybridExecutionPlan(isRecord(basePayload.hybridExecutionPlan) ? basePayload.hybridExecutionPlan : null);
	const fallbackAttentionEstimate = estimateAttentionForTask({
		classification,
		executionProfile: fallbackProfile,
		attentionPolicy: policySnapshot,
		...attentionOverrides,
		source: input.source ?? 'agent.task_admission',
	});
	const fallbackUtilityEstimate = estimateUtilityForTask({
		classification,
		executionProfile: fallbackProfile,
		estimate: baseEstimate,
		utilityPolicy: policySnapshot.utilityPolicy,
		...utilityOverrides,
		source: input.source ?? 'agent.task_admission',
	});
	const fallbackReservePrediction = predictReserveForCapacityPlan({
		plan: input.capacityPlan,
		policy: policySnapshot.predictiveReservePolicy,
		dailyCreditBudget: Number(input.workDay.capacityBudget ?? input.policy.dailyTaskCreditBudget ?? 0),
		remainingCredits: Number(input.workDay.capacityBudget ?? input.policy.dailyTaskCreditBudget ?? 0) - Number(input.workDay.capacityUsed ?? 0) - Number(input.queuedCredits ?? 0),
		metadata: isRecord(input.policy.metadata) ? input.policy.metadata : {},
	});
	const route = input.capacityPlan && input.capacityPlan.grants.length > 0 && input.capacityPlan.lanes.length > 0
		? routeAndReserveCapacity({
			plan: input.capacityPlan,
			estimate: baseEstimate,
			classification,
			taskKind: classification.taskSignature,
			repositoryMutation: classification.mutationScope === 'repository_write' || classification.mutationScope === 'production',
			production: classification.mutationScope === 'production',
			executionProfiles: candidateProfileIds,
			estimateProfiles: input.capacityPlan.estimateProfiles,
			minimumQualityWeight: minimumQualityWeightFor(classification, basePayload),
			requiredContextTokens: attentionOverrides.requiredContextTokens,
			estimatedContextTokens: attentionOverrides.estimatedContextTokens,
			attentionWeight: attentionOverrides.attentionWeight,
			coordinationWeight: attentionOverrides.coordinationWeight,
			minimumAttentionAvailable: attentionOverrides.minimumAttentionAvailable,
			attentionPolicy: policySnapshot,
			utilityPolicy: policySnapshot.utilityPolicy,
			utilityValue: utilityOverrides.utilityValue,
			maintenanceValue: utilityOverrides.maintenanceValue,
			deadlineAt: utilityOverrides.deadlineAt,
			successProbability: utilityOverrides.successProbability,
			trustRequirement: utilityOverrides.trustRequirement,
			cooperativeRouting: utilityOverrides.cooperativeRouting,
			predictiveReservePolicy: policySnapshot.predictiveReservePolicy,
			hybridExecutionPlan,
			preferredExecutionProfiles: readStringArray(basePayload, 'preferredExecutionProfiles'),
			disallowedExecutionProfiles: readStringArray(basePayload, 'disallowedExecutionProfiles'),
			source: input.source ?? 'agent.task_admission',
			metadata: {
				taskSignature: classification.taskSignature,
				classification,
				priority: utilityOverrides.priority,
				hybridExecutionPlan,
				...(isRecord(input.policy.metadata) ? { predictiveReserveSignals: input.policy.metadata } : {}),
			},
		})
		: null;
	const estimate = route?.ok ? route.estimate : baseEstimate;
	const executionProfile = normalizeExecutionProfile(estimate.executionProfileId ?? fallbackProfile.id);
	const attentionEstimate = (route?.ok ? route.capacityMetadata.attentionEstimate : null) as AttentionEstimate | null
		?? estimateAttentionForTask({
			classification,
			executionProfile,
			attentionPolicy: policySnapshot,
			...attentionOverrides,
			source: input.source ?? 'agent.task_admission',
		})
		?? fallbackAttentionEstimate;
	const utilityEstimate = (route?.ok ? route.capacityMetadata.utilityEstimate : null) as UtilityEstimate | null
		?? estimateUtilityForTask({
			classification,
			executionProfile,
			estimate,
			utilityPolicy: policySnapshot.utilityPolicy,
			...utilityOverrides,
			source: input.source ?? 'agent.task_admission',
		})
		?? fallbackUtilityEstimate;
	const reservePrediction = (route?.ok ? route.capacityMetadata.reservePrediction : null) as ReservePrediction | null
		?? fallbackReservePrediction;
	const admission = decideTaskAdmission({
		classification,
		estimate,
		budget: {
			dailyCreditBudget: Number(input.workDay.capacityBudget ?? input.policy.dailyTaskCreditBudget ?? 0),
			usedCredits: Number(input.workDay.capacityUsed ?? 0),
			queuedCredits: input.queuedCredits ?? 0,
		},
		policy: policySnapshot,
		source: input.source ?? 'agent.task_admission',
		metadata: route
			? {
				route: route.ok
					? route.capacityMetadata
					: {
						code: route.code,
						reason: route.reason,
						candidates: route.candidates,
					},
			}
			: undefined,
	});
	if (route && !route.ok) {
		const routeCandidateReasons = route.candidates.flatMap((candidate) => candidate.reasons);
		admission.outcome = routeBlockOutcome(route);
		admission.requiresApproval = admission.requiresApproval || route.code === 'approval_required';
		admission.reasons = [...new Set([
			...admission.reasons,
			route.code,
			route.reason,
			...routeCandidateReasons,
		])];
		admission.metadata = {
			...(admission.metadata ?? {}),
			route: {
				code: route.code,
				reason: route.reason,
				candidates: route.candidates,
			},
		};
	}
	const enqueue = admission.outcome === 'admitted';
	const state = enqueue ? 'pending' : admission.outcome === 'approval_required' ? 'paused_for_approval' : 'waiting';
	const inheritedEnvelope = isRecord(basePayload.capacityEnvelope)
		? basePayload.capacityEnvelope as CapacityTaskExecutionEnvelope
		: null;
	const capacityEnvelope = inheritedEnvelope
		? {
			...inheritedEnvelope,
			maxCredits: admission.reservedCredits,
			metadata: {
				...(isRecord(inheritedEnvelope.metadata) ? inheritedEnvelope.metadata : {}),
				executionProfileId: executionProfile.id,
				admissionOutcome: admission.outcome,
				attentionEstimate,
				utilityEstimate,
				reservePrediction,
				hybridExecutionPlan,
				capacityRoute: route?.ok ? route.capacityMetadata : route ? { code: route.code, reason: route.reason } : null,
			},
		}
		: {
			maxCredits: admission.reservedCredits,
			approvalBehavior: 'pause_task',
			pausePolicy: { onOverrun: 'pause_for_approval' },
			metadata: {
				executionProfileId: executionProfile.id,
				admissionOutcome: admission.outcome,
				attentionEstimate,
				utilityEstimate,
				reservePrediction,
				hybridExecutionPlan,
				capacityRoute: route?.ok ? route.capacityMetadata : route ? { code: route.code, reason: route.reason } : null,
			},
		};
	return {
		classification,
		executionProfile,
		admission,
		state,
		enqueue,
		capacityEnvelope,
		route,
		payload: {
			...basePayload,
			taskSignature: classification.taskSignature,
			taskClassification: classification,
			taskAdmission: admission,
			executionProfile,
			executionProfileId: executionProfile.id,
			estimatedCredits: admission.reservedCredits,
			attentionEstimate,
			utilityEstimate,
			reservePrediction,
			hybridExecutionPlan,
			capacityRoute: route?.ok ? route.capacityMetadata : route ? { code: route.code, reason: route.reason, candidates: route.candidates } : null,
			capacityEnvelope,
		},
	};
}

export function payloadForExistingTask(task: Record<string, unknown>) {
	return parsePayloadJson(task.payloadJson ?? task.payload_json);
}
