import {
	progressivelyAdmitPlanProposal,
	type CapacityPlan,
	type TaskEstimateProfile,
	type TaskUsageActual,
} from '@treeseed/sdk';
import { admissionForTaskProposal } from '../../services/task-admission.ts';
import { buildPlanningProposalFromTask, buildPlanningTaskPayload } from '../../services/task-planning.ts';
import type { WorkdayPolicy } from '@treeseed/sdk';

type JsonRecord = Record<string, unknown>;

export interface CapacitySchedulingEndToEndSummary {
	ok: boolean;
	taskCount: number;
	queuedTaskCount: number;
	eventKinds: string[];
	admissionOutcomes: string[];
	routingDecisionCount: number;
	reservationCount: number;
	usageActualCount: number;
	estimateProfileCount: number;
	learnedDraftEstimateCredits: number | null;
	completedDraftProfileCreditsP90: number | null;
	interruptedDraftSampleCount: number;
	planning: {
		proposedCount: number;
		admittedCount: number;
		deferredCount: number;
		materializedCount: number;
	};
	backfill: {
		firstAdmittedTaskSignature: string | null;
		idledWithoutUsefulWork: boolean;
		predictiveReserveBlocked: boolean;
	};
	checkpoint: {
		state: string;
		partialUsageExcludedFromCompletedCost: boolean;
	};
	hybrid: {
		phaseCount: number;
		escalationAdmitted: boolean;
	};
	metadata: {
		hasAttentionSnapshot: boolean;
		hasUtilitySnapshot: boolean;
		hasPredictiveReserveSnapshot: boolean;
		hasHybridSnapshot: boolean;
		hasCandidateScores: boolean;
	};
}

function nowIso() {
	return '2026-05-13T12:00:00.000Z';
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function parsePayload(task: JsonRecord) {
	const raw = task.payloadJson;
	if (typeof raw !== 'string') return {};
	try {
		const parsed = JSON.parse(raw);
		return asRecord(parsed);
	} catch {
		return {};
	}
}

function percentile(values: number[], percent: number) {
	const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
	if (sorted.length === 0) return null;
	const index = Math.ceil((percent / 100) * sorted.length) - 1;
	return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function interruptedActual(actual: TaskUsageActual) {
	const metadata = asRecord(actual.metadata);
	return metadata.interrupted === true || metadata.partial === true;
}

function baseWorkPolicy(metadata: JsonRecord = {}): WorkdayPolicy {
	return {
		projectId: 'project-1',
		environment: 'staging',
		enabled: true,
		schedule: { timezone: 'UTC', windows: [] },
		startCron: '0 9 * * 1-5',
		durationMinutes: 480,
		maxRunners: 2,
		maxWorkersPerRunner: 2,
		dailyCreditBudget: 100,
		closeoutGraceMinutes: 10,
		dailyTaskCreditBudget: 100,
		maxQueuedTasks: 10,
		maxQueuedCredits: 100,
		autoscale: { minWorkers: 0, maxWorkers: 2, targetQueueDepth: 1, cooldownSeconds: 60 },
		creditWeights: [],
		metadata: {
			reserveBufferPercent: 10,
			recoveryBudgetCredits: 5,
			planningThresholdCredits: 20,
			approvalThresholdCredits: 80,
			maxDownstreamTasks: 3,
			maxPlanningDepth: 2,
			maxAdmittedPlanTasksPerCycle: 2,
			maxAttentionLoad: 12,
			maxContextTokens: 8000,
			coordinationOverheadFactor: 0.25,
			utilityPolicy: { minimumUtilityScore: 0 },
			predictiveReservePolicy: { enabled: true, baseReservePercent: 5, maxReservePercent: 40 },
			...metadata,
		},
	};
}

function baseCapacityPlan(profiles: TaskEstimateProfile[] = [], activeReservations: JsonRecord[] = []): CapacityPlan {
	return {
		projectId: 'project-1',
		teamId: 'team-1',
		environment: 'staging',
		providers: [{
			id: 'provider-1',
			teamId: 'team-1',
			ownerTeamId: 'team-1',
			name: 'Provider',
			kind: 'treeseed_managed',
			status: 'active',
			provider: 'local',
			billingScope: 'team',
			monthlyCreditBudget: 1000,
			dailyCreditBudget: 100,
			maxConcurrentWorkdays: 1,
			maxConcurrentWorkers: 2,
			capacityModel: {},
			metadata: { pressure: { trustScore: 0.95, availabilityScore: 0.9 } },
			createdAt: nowIso(),
			updatedAt: nowIso(),
		}],
		lanes: [{
			id: 'lane-1',
			capacityProviderId: 'provider-1',
			name: 'General Scheduling Lane',
			businessModel: 'subscription_quota',
			modelFamily: 'gpt',
			modelClass: 'local',
			regionPolicy: 'us',
			unit: 'treeseed_credit',
			scarcityLevel: 'low',
			hardLimits: { maxActiveReservations: 8, maxAttentionLoad: 12, maxContextTokens: 8000 },
			routingPolicy: {
				taskKinds: [
					'system.refresh_graph',
					'agent.activation',
					'knowledge.generate_draft',
					'workflow.dispatch',
					'planner.dag_proposal',
					'review.verify',
				],
				requiredCapabilities: [],
				allowedEnvironments: ['staging'],
				maxCreditsPerTask: 100,
			},
			metadata: {
				executionProfiles: ['local-runner', 'local-fast-model', 'small-code-model', 'standard-code-model', 'cheap-review-model', 'large-reasoning-model'],
				pressure: {
					quotaRemainingPercent: 90,
					sessionRemainingMinutes: 120,
					subscriptionSaturationPercent: 10,
					trustScore: 0.95,
					availabilityScore: 0.9,
					successProbability: 0.88,
				},
			},
			createdAt: nowIso(),
			updatedAt: nowIso(),
		}],
		grants: [{
			id: 'grant-1',
			capacityProviderId: 'provider-1',
			laneId: null,
			grantScope: 'project',
			teamId: 'team-1',
			projectId: 'project-1',
			environment: 'staging',
			state: 'active',
			dailyCreditLimit: 100,
			weeklyCreditLimit: null,
			monthlyCreditLimit: null,
			dailyUsdLimit: null,
			weeklyQuotaMinutes: null,
			monthlyProviderUnits: null,
			priorityWeight: 1,
			overflowPolicy: 'deny',
			metadata: {},
			createdAt: nowIso(),
			updatedAt: nowIso(),
		}],
		activeReservations: activeReservations as CapacityPlan['activeReservations'],
		remaining: {
			dailyCredits: 100,
			weeklyCredits: null,
			monthlyCredits: null,
			weeklyQuotaMinutes: null,
			dailyUsd: null,
		},
		estimateProfiles: profiles,
	};
}

class InMemoryCapacityRuntime {
	readonly tasks: JsonRecord[] = [];
	readonly events: JsonRecord[] = [];
	readonly estimates: JsonRecord[] = [];
	readonly reservations: JsonRecord[] = [];
	readonly routingDecisions: JsonRecord[] = [];
	readonly usageActuals: TaskUsageActual[] = [];
	readonly queuedTaskIds: string[] = [];
	private nextTask = 1;

	plan() {
		return baseCapacityPlan(this.profiles(), this.reservations.filter((entry) => entry.state === 'reserved'));
	}

	profiles(): TaskEstimateProfile[] {
		const keys = [...new Set(this.usageActuals.map((actual) => `${actual.taskSignature}:${actual.executionProfileId ?? 'standard-code-model'}`))];
		return keys.map((key) => {
			const [taskSignature, executionProfileId] = key.split(':');
			const actuals = this.usageActuals.filter((actual) =>
				actual.taskSignature === taskSignature
				&& (actual.executionProfileId ?? 'standard-code-model') === executionProfileId
			);
			const completed = actuals.filter((actual) => !interruptedActual(actual));
			const interrupted = actuals.filter(interruptedActual);
			return {
				taskSignature,
				executionProfileId,
				sampleCount: actuals.length,
				completedSampleCount: completed.length,
				interruptedSampleCount: interrupted.length,
				inputTokensP50: null,
				inputTokensP90: null,
				outputTokensP50: null,
				outputTokensP90: null,
				quotaMinutesP50: null,
				quotaMinutesP90: null,
				filesChangedP50: percentile(completed.map((actual) => Number(actual.filesChanged ?? Number.NaN)), 50),
				filesChangedP90: percentile(completed.map((actual) => Number(actual.filesChanged ?? Number.NaN)), 90),
				creditsP50: percentile(completed.map((actual) => Number(actual.actualCredits ?? Number.NaN)), 50),
				creditsP90: percentile(completed.map((actual) => Number(actual.actualCredits ?? Number.NaN)), 90),
				creditsVariance: 0,
				confidenceScore: completed.length >= 1 ? 0.4 : 0.1,
				outlierCount: 0,
				partialCredits: interrupted.reduce((total, actual) => total + Number(actual.actualCredits ?? 0), 0) || null,
				firstSampleAt: nowIso(),
				lastSampleAt: nowIso(),
				updatedAt: nowIso(),
			};
		});
	}

	appendEvent(taskId: string, kind: string, data: JsonRecord = {}) {
		this.events.push({ id: `event-${this.events.length + 1}`, taskId, kind, data, createdAt: nowIso() });
	}

	createTask(input: { type: string; state: string; payload: JsonRecord; parentTaskId?: string | null }) {
		const task = {
			id: `task-${this.nextTask++}`,
			workDayId: 'workday-1',
			agentId: 'planner',
			type: input.type,
			state: input.state,
			priority: 50,
			parentTaskId: input.parentTaskId ?? null,
			payloadJson: JSON.stringify(input.payload),
			createdAt: nowIso(),
			updatedAt: nowIso(),
		};
		this.tasks.push(task);
		return task;
	}

	admitTask(input: { type: string; payload?: JsonRecord; policy?: WorkdayPolicy; parentTaskId?: string | null; capacityUsed?: number; queuedCredits?: number; capacityPlan?: CapacityPlan | null }) {
		const workDay = {
			id: 'workday-1',
			projectId: 'project-1',
			state: 'active',
			capacityBudget: 100,
			capacityUsed: input.capacityUsed ?? 0,
		};
		const admission = admissionForTaskProposal({
			type: input.type,
			payload: input.payload ?? {},
			workDay,
			policy: input.policy ?? baseWorkPolicy(),
			capacityPlan: input.capacityPlan === undefined ? this.plan() : input.capacityPlan,
			queuedCredits: input.queuedCredits ?? 0,
			source: 'capacity-scheduling-e2e',
		});
		const task = this.createTask({
			type: input.type,
			state: admission.state,
			payload: admission.payload,
			parentTaskId: input.parentTaskId,
		});
		this.appendEvent(String(task.id), 'classified', admission.classification as unknown as JsonRecord);
		this.appendEvent(String(task.id), 'admission_decided', admission.admission as unknown as JsonRecord);
		if (admission.admission.outcome === 'budget_blocked' || admission.admission.outcome === 'deferred') {
			this.appendEvent(String(task.id), 'deferred_for_budget', admission.admission as unknown as JsonRecord);
		}
		this.estimates.push({
			taskId: task.id,
			taskSignature: admission.classification.taskSignature,
			executionProfileId: admission.executionProfile.id,
			estimatedCreditsP50: admission.admission.estimatedCreditsP50,
			estimatedCreditsP90: admission.admission.estimatedCreditsP90,
			reservedCredits: admission.admission.reservedCredits,
		});
		if (admission.enqueue && admission.route?.ok) {
			const reservation = {
				...admission.route.reservation,
				id: `reservation-${this.reservations.length + 1}`,
				taskId: task.id,
				workDayId: 'workday-1',
				state: 'reserved',
			};
			const routingDecision = {
				...admission.route.routingDecision,
				id: `routing-${this.routingDecisions.length + 1}`,
				taskId: task.id,
				workDayId: 'workday-1',
			};
			this.reservations.push(reservation);
			this.routingDecisions.push(routingDecision);
			const payload = parsePayload(task);
			task.payloadJson = JSON.stringify({
				...payload,
				capacity: {
					...asRecord(payload.capacity),
					providerId: reservation.capacityProviderId,
					laneId: reservation.laneId,
					grantId: asRecord(reservation.metadata).grantId,
					reservationId: reservation.id,
					routingDecisionId: routingDecision.id,
					reservedCredits: reservation.reservedCredits,
					executionProfileId: asRecord(reservation.metadata).executionProfileId,
					attentionEstimate: asRecord(reservation.metadata).attentionEstimate,
					utilityEstimate: asRecord(reservation.metadata).utilityEstimate,
					reservePrediction: asRecord(reservation.metadata).reservePrediction,
					hybridExecutionPlan: asRecord(reservation.metadata).hybridExecutionPlan,
				},
			});
			this.queuedTaskIds.push(String(task.id));
			this.appendEvent(String(task.id), 'queued', { reservationId: reservation.id });
		}
		return { task, admission };
	}

	recordUsage(actual: TaskUsageActual) {
		this.usageActuals.push({
			...actual,
			createdAt: actual.createdAt ?? nowIso(),
			executionProfileId: actual.executionProfileId ?? 'standard-code-model',
		});
	}
}

export async function runCapacitySchedulingEndToEndVerification(): Promise<CapacitySchedulingEndToEndSummary> {
	const runtime = new InMemoryCapacityRuntime();

	runtime.admitTask({ type: 'refresh_project_graph', payload: {} });

	runtime.recordUsage({
		taskId: 'historical-draft',
		workDayId: 'workday-0',
		projectId: 'project-1',
		taskSignature: 'knowledge.generate_draft',
		executionProfileId: 'local-runner',
		actualCredits: 7,
		filesChanged: 1,
		metadata: { completed: true },
		createdAt: nowIso(),
	} as TaskUsageActual);
	const learnedDraft = runtime.admitTask({
		type: 'generate_knowledge_draft',
		payload: {
			utilityValue: 80,
			maintenanceValue: 10,
			successProbability: 0.9,
			cooperativeRouting: true,
			estimatedContextTokens: 1200,
			attentionWeight: 2,
			hybridExecutionPlan: {
				planId: 'hybrid-1',
				phases: [
					{ kind: 'planning', executionProfileId: 'large-reasoning-model', mutationAllowed: false },
					{ kind: 'implementation', executionProfileId: 'local-runner' },
					{ kind: 'review', executionProfileId: 'cheap-review-model', mutationAllowed: false },
				],
			},
		},
	});

	const plannedSource = runtime.admitTask({
		type: 'workflow_followup',
		payload: {
			executionKind: 'workflow_dispatch',
			operation: 'refactor',
			requiresPlanning: true,
			expectedFanout: 6,
			mutationScope: 'repository_write',
			estimatedCreditsP50: 25,
			estimatedCreditsP90: 45,
			proposedTasks: [
				{ id: 'verify', type: 'workflow_followup', taskSignature: 'workflow.dispatch', estimatedCreditsP50: 2, estimatedCreditsP90: 4, priority: 100, boundedness: 1, payload: { executionKind: 'workflow_dispatch', operation: 'verify' } },
				{ id: 'draft', type: 'generate_knowledge_draft', taskSignature: 'knowledge.generate_draft', estimatedCreditsP50: 5, estimatedCreditsP90: 7, priority: 80, boundedness: 1, payload: { utilityValue: 70 } },
				{ id: 'too-large', type: 'workflow_followup', taskSignature: 'workflow.dispatch', estimatedCreditsP50: 80, estimatedCreditsP90: 90, priority: 50, boundedness: 0.5, payload: { executionKind: 'workflow_dispatch', operation: 'large' } },
			],
		},
	});
	const planningPayload = buildPlanningTaskPayload({
		sourceTaskId: String(plannedSource.task.id),
		sourceTaskType: 'workflow_followup',
		sourcePayload: parsePayload(plannedSource.task),
		classification: plannedSource.admission.classification,
		admission: plannedSource.admission.admission,
		policy: baseWorkPolicy(),
		now: new Date(nowIso()),
	});
	const planningTask = runtime.admitTask({ type: 'planning_task', payload: planningPayload, parentTaskId: String(plannedSource.task.id) });
	const proposal = buildPlanningProposalFromTask({
		task: planningTask.task,
		payload: parsePayload(planningTask.task),
		now: new Date(nowIso()),
	});
	runtime.appendEvent(String(planningTask.task.id), 'plan_proposed', proposal as unknown as JsonRecord);
	const planAdmission = progressivelyAdmitPlanProposal({
		proposal,
		policy: baseWorkPolicy({ maxAdmittedPlanTasksPerCycle: 2 }),
		availableCredits: 11,
		remainingQueuedCredits: 11,
	});
	let materializedCount = 0;
	for (const node of planAdmission.admitted) {
		const child = runtime.admitTask({
			type: node.type,
			payload: { ...(asRecord(node.payload)), taskSignature: node.taskSignature, estimatedCreditsP50: node.estimatedCreditsP50, estimatedCreditsP90: node.estimatedCreditsP90 },
			parentTaskId: String(planningTask.task.id),
		});
		if (child.admission.enqueue) materializedCount += 1;
	}
	if (planAdmission.deferred.length > 0) {
		runtime.appendEvent(String(planningTask.task.id), 'plan_partially_admitted', {
			deferred: planAdmission.deferred.map((node) => node.id),
		});
	}
	runtime.appendEvent(String(planningTask.task.id), 'plan_materialized', {
		admittedCount: planAdmission.admitted.length,
		deferredCount: planAdmission.deferred.length,
	});

	const highUtility = runtime.admitTask({
		type: 'workflow_followup',
		payload: { executionKind: 'workflow_dispatch', operation: 'maintenance', taskSignature: 'workflow.dispatch', utilityValue: 90, maintenanceValue: 15, estimatedCreditsP90: 4 },
		capacityUsed: 70,
	});
	const lowUtilityReserveBlocked = runtime.admitTask({
		type: 'workflow_followup',
		payload: { executionKind: 'workflow_dispatch', operation: 'nice-to-have', taskSignature: 'workflow.dispatch', utilityValue: 1, estimatedCreditsP90: 4 },
		policy: baseWorkPolicy({ predictiveReservePolicy: { enabled: true, baseReservePercent: 97, maxReservePercent: 100 } }),
	});
	const idleCandidates: Array<JsonRecord> = [];

	runtime.appendEvent(String(learnedDraft.task.id), 'checkpoint_started', { reason: 'reservation_exhaustion_risk' });
	runtime.appendEvent(String(learnedDraft.task.id), 'checkpointed', { checkpointId: 'checkpoint-1', repositoryState: 'checkpointed_dirty' });
	runtime.appendEvent(String(learnedDraft.task.id), 'continuation_required', { checkpointId: 'checkpoint-1' });
	runtime.recordUsage({
		taskId: String(learnedDraft.task.id),
		workDayId: 'workday-1',
		projectId: 'project-1',
		taskSignature: 'knowledge.generate_draft',
		executionProfileId: 'local-runner',
		actualCredits: 30,
		metadata: {
			interrupted: true,
			partial: true,
			checkpointId: 'checkpoint-1',
			attentionEstimate: parsePayload(learnedDraft.task).attentionEstimate,
			utilityEstimate: parsePayload(learnedDraft.task).utilityEstimate,
		},
		createdAt: nowIso(),
	} as TaskUsageActual);

	const escalation = runtime.admitTask({
		type: 'hybrid_escalation',
		payload: {
			taskSignature: 'review.verify',
			executionProfileId: 'cheap-review-model',
			hybridExecutionPlan: parsePayload(learnedDraft.task).hybridExecutionPlan,
			hybridPhase: { kind: 'review', executionProfileId: 'cheap-review-model', mutationAllowed: false },
			reason: 'insufficient_confidence',
		},
		parentTaskId: String(learnedDraft.task.id),
		capacityPlan: null,
	});

	const learnedProfile = runtime.profiles().find((profile) =>
		profile.taskSignature === 'knowledge.generate_draft' && profile.executionProfileId === 'local-runner'
	);
	const selectedRouting = runtime.routingDecisions[0] ?? {};
	const selectedCandidates = Array.isArray(selectedRouting.candidates) ? selectedRouting.candidates : [];
	const payload = parsePayload(learnedDraft.task);
	const capacity = asRecord(payload.capacity);

	return {
		ok: true,
		taskCount: runtime.tasks.length,
		queuedTaskCount: runtime.queuedTaskIds.length,
		eventKinds: runtime.events.map((event) => String(event.kind)),
		admissionOutcomes: runtime.tasks.map((task) => String(asRecord(parsePayload(task).taskAdmission).outcome)).filter(Boolean),
		routingDecisionCount: runtime.routingDecisions.length,
		reservationCount: runtime.reservations.length,
		usageActualCount: runtime.usageActuals.length,
		estimateProfileCount: runtime.profiles().length,
		learnedDraftEstimateCredits: Number(asRecord(payload.taskAdmission).estimatedCreditsP90 ?? Number.NaN) || null,
		completedDraftProfileCreditsP90: learnedProfile?.creditsP90 ?? null,
		interruptedDraftSampleCount: learnedProfile?.interruptedSampleCount ?? 0,
		planning: {
			proposedCount: proposal.tasks.length,
			admittedCount: planAdmission.admitted.length,
			deferredCount: planAdmission.deferred.length,
			materializedCount,
		},
		backfill: {
			firstAdmittedTaskSignature: String(asRecord(parsePayload(highUtility.task).taskClassification).taskSignature || ''),
			idledWithoutUsefulWork: idleCandidates.length === 0,
			predictiveReserveBlocked: lowUtilityReserveBlocked.admission.admission.reasons.includes('predictive_reserve_blocked'),
		},
		checkpoint: {
			state: 'continuation_required',
			partialUsageExcludedFromCompletedCost: learnedProfile?.creditsP90 === 7 && learnedProfile.interruptedSampleCount === 1,
		},
		hybrid: {
			phaseCount: Array.isArray(asRecord(payload.hybridExecutionPlan).phases) ? (asRecord(payload.hybridExecutionPlan).phases as unknown[]).length : 0,
			escalationAdmitted: escalation.admission.admission.outcome === 'admitted',
		},
		metadata: {
			hasAttentionSnapshot: Object.keys(asRecord(capacity.attentionEstimate)).length > 0,
			hasUtilitySnapshot: Object.keys(asRecord(capacity.utilityEstimate)).length > 0,
			hasPredictiveReserveSnapshot: Object.keys(asRecord(capacity.reservePrediction)).length > 0,
			hasHybridSnapshot: Object.keys(asRecord(capacity.hybridExecutionPlan)).length > 0,
			hasCandidateScores: selectedCandidates.some((candidate) =>
				Object.keys(asRecord(candidate)).includes('score')
				&& Object.keys(asRecord(candidate)).includes('attentionEstimate')
				&& Object.keys(asRecord(candidate)).includes('utilityEstimate')
			),
		},
	};
}
