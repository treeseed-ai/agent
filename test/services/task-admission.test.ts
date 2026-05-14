import { describe, expect, it } from 'vitest';
import { admissionForTaskProposal } from '../../src/services/task-admission.ts';
import type { CapacityPlan } from '@treeseed/sdk';

const capacityPlan = {
	projectId: 'project-1',
	teamId: 'team-1',
	environment: 'staging',
	providers: [],
	lanes: [],
	grants: [],
	activeReservations: [],
	remaining: {
		dailyCredits: 100,
		weeklyCredits: null,
		monthlyCredits: null,
		weeklyQuotaMinutes: null,
		dailyUsd: null,
	},
	estimateProfiles: [{
		taskSignature: 'knowledge.generate_draft',
		executionProfileId: 'local-runner',
		sampleCount: 20,
		completedSampleCount: 20,
		interruptedSampleCount: 0,
		inputTokensP50: null,
		inputTokensP90: null,
		outputTokensP50: null,
		outputTokensP90: null,
		quotaMinutesP50: null,
		quotaMinutesP90: null,
		filesChangedP50: null,
		filesChangedP90: null,
		creditsP50: 7,
		creditsP90: 9,
		creditsVariance: 1,
		confidenceScore: 0.9,
		outlierCount: 0,
		partialCredits: null,
		firstSampleAt: '2026-05-01T00:00:00.000Z',
		lastSampleAt: '2026-05-10T00:00:00.000Z',
		updatedAt: '2026-05-10T00:00:00.000Z',
	}],
} satisfies CapacityPlan;

function workPolicy(metadata: Record<string, unknown> = {}) {
	return {
		projectId: 'project-1',
		environment: 'staging',
		enabled: true,
		schedule: { timezone: 'UTC', windows: [] },
		startCron: '0 9 * * 1-5',
		durationMinutes: 480,
		dailyCreditBudget: 100,
		closeoutGraceMinutes: 10,
		dailyTaskCreditBudget: 100,
		maxQueuedTasks: 10,
		maxQueuedCredits: 100,
		maxRunners: 1,
		maxWorkersPerRunner: 1,
		autoscale: { minWorkers: 0, maxWorkers: 1, targetQueueDepth: 1, cooldownSeconds: 60 },
		creditWeights: [],
		metadata,
	};
}

const routedCapacityPlan = {
	...capacityPlan,
	providers: [{
		id: 'provider-1',
		teamId: 'team-1',
		ownerTeamId: 'team-1',
		name: 'Provider',
		kind: 'treeseed_managed',
		status: 'active',
		provider: 'railway',
		billingScope: 'team',
		monthlyCreditBudget: 1000,
		dailyCreditBudget: 100,
		maxConcurrentWorkdays: 1,
		maxConcurrentWorkers: 2,
		capacityModel: {},
		metadata: {},
		createdAt: '2026-05-01T00:00:00.000Z',
		updatedAt: '2026-05-01T00:00:00.000Z',
	}],
	lanes: [{
		id: 'lane-1',
		capacityProviderId: 'provider-1',
		name: 'Lane',
		businessModel: 'subscription_quota',
		modelFamily: 'gpt',
		modelClass: 'local',
		regionPolicy: 'us',
		unit: 'treeseed_credit',
		scarcityLevel: 'low',
		hardLimits: { maxAttentionLoad: 8, maxContextTokens: 1000 },
		routingPolicy: {
			taskKinds: ['knowledge.generate_draft'],
			requiredCapabilities: [],
			allowedEnvironments: ['staging'],
			maxCreditsPerTask: 100,
		},
		metadata: {},
		createdAt: '2026-05-01T00:00:00.000Z',
		updatedAt: '2026-05-01T00:00:00.000Z',
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
		createdAt: '2026-05-01T00:00:00.000Z',
		updatedAt: '2026-05-01T00:00:00.000Z',
	}],
} satisfies CapacityPlan;

describe('task admission', () => {
	it('uses learned task-signature plus execution-profile estimates before static defaults', () => {
		const result = admissionForTaskProposal({
			type: 'generate_knowledge_draft',
			payload: {},
			workDay: {
				id: 'workday-1',
				capacityBudget: 100,
				capacityUsed: 0,
			},
			policy: workPolicy(),
			capacityPlan,
			queuedCredits: 0,
		});

		expect(result.classification.taskSignature).toBe('knowledge.generate_draft');
		expect(result.executionProfile.id).toBe('local-runner');
		expect(result.admission).toMatchObject({
			estimatedCreditsP50: 7,
			estimatedCreditsP90: 9,
			reservedCredits: 9,
			executionProfileId: 'local-runner',
		});
		expect(result.payload).toMatchObject({
			executionProfileId: 'local-runner',
			estimatedCredits: 9,
		});
	});

	it('attaches attention estimates and honors policy context saturation', () => {
		const admitted = admissionForTaskProposal({
			type: 'generate_knowledge_draft',
			payload: {
				estimatedContextTokens: 400,
				attentionWeight: 2,
			},
			workDay: {
				id: 'workday-1',
				capacityBudget: 100,
				capacityUsed: 0,
			},
			policy: workPolicy({ maxAttentionLoad: 8, maxContextTokens: 1000 }),
			capacityPlan: routedCapacityPlan,
			queuedCredits: 0,
		});
		expect(admitted.enqueue).toBe(true);
		expect(admitted.payload.attentionEstimate).toMatchObject({
			attentionWeight: 2,
			estimatedContextTokens: 400,
		});
		expect(admitted.payload.capacityEnvelope).toMatchObject({
			metadata: {
				attentionEstimate: expect.objectContaining({ totalAttentionWeight: 2 }),
			},
		});

		const blocked = admissionForTaskProposal({
			type: 'generate_knowledge_draft',
			payload: {
				estimatedContextTokens: 900,
				attentionWeight: 2,
			},
			workDay: {
				id: 'workday-1',
				capacityBudget: 100,
				capacityUsed: 0,
			},
			policy: workPolicy({ maxAttentionLoad: 8, maxContextTokens: 1000, maxContextSaturationPercent: 50 }),
			capacityPlan: routedCapacityPlan,
			queuedCredits: 0,
		});
		expect(blocked.enqueue).toBe(false);
		expect(blocked.admission.reasons.join(' ')).toContain('context_saturation_exceeded');
	});

	it('attaches utility, predictive reserve, and hybrid metadata before queueing', () => {
		const result = admissionForTaskProposal({
			type: 'generate_knowledge_draft',
			payload: {
				utilityValue: 100,
				maintenanceValue: 10,
				successProbability: 0.8,
				cooperativeRouting: true,
				hybridExecutionPlan: {
					planId: 'hybrid-1',
					phases: [
						{ kind: 'planning', executionProfileId: 'large-reasoning-model', mutationAllowed: false },
						{ kind: 'implementation', executionProfileId: 'local-runner' },
						{ kind: 'review', executionProfileId: 'cheap-review-model', mutationAllowed: false },
					],
				},
			},
			workDay: {
				id: 'workday-1',
				capacityBudget: 100,
				capacityUsed: 0,
			},
			policy: workPolicy({
				utilityPolicy: { minimumUtilityScore: 1 },
				predictiveReservePolicy: { enabled: true, baseReservePercent: 10 },
			}),
			capacityPlan: routedCapacityPlan,
			queuedCredits: 0,
		});

		expect(result.enqueue).toBe(true);
		expect(result.payload.utilityEstimate).toMatchObject({
			utilityScore: expect.any(Number),
			successProbability: 0.8,
		});
		expect(result.payload.reservePrediction).toMatchObject({
			reservePercent: 10,
		});
		expect(result.payload.hybridExecutionPlan).toMatchObject({
			planId: 'hybrid-1',
			phases: expect.arrayContaining([
				expect.objectContaining({ kind: 'planning', admissionRequired: true, mutationAllowed: false }),
			]),
		});
		expect(result.payload.capacityEnvelope).toMatchObject({
			metadata: {
				utilityEstimate: expect.any(Object),
				reservePrediction: expect.any(Object),
				hybridExecutionPlan: expect.any(Object),
			},
		});
	});

	it('predictive reserve defers low-utility opportunistic work', () => {
		const result = admissionForTaskProposal({
			type: 'generate_knowledge_draft',
			payload: {
				utilityValue: 1,
			},
			workDay: {
				id: 'workday-1',
				capacityBudget: 100,
				capacityUsed: 0,
			},
			policy: workPolicy({
				predictiveReservePolicy: { enabled: true, baseReservePercent: 97, maxReservePercent: 100 },
			}),
			capacityPlan: routedCapacityPlan,
			queuedCredits: 0,
		});

		expect(result.enqueue).toBe(false);
		expect(result.admission.reasons.join(' ')).toContain('predictive_reserve_blocked');
	});
});
