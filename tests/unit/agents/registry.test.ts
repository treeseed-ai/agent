import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	listRegisteredAgentHandlers,
	loadTenantAgentHandlerRegistry,
	resolveAgentHandler,
} from '../../../src/agents/support/registry.ts';
import { estimateHandler } from '../../../src/agents/handlers/estimate.ts';
import { normalizeAgentRuntimeSpec } from '../../../src/agents/support/spec-normalizer.ts';
import { selectAgentActivityProfile } from '../../../src/agents/kernel/telemetry/activity-profile-resolver.ts';
import { resolveAssignmentAgentToolPolicy } from '../../../src/provider/capacity/assignments/assignment-tool-policy.ts';

const tempRoots: string[] = [];
const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const marketRoot = resolve(agentRoot, '..', '..');
const hasIntegratedMarketAgentContent = existsSync(resolve(marketRoot, 'src/content/agents/architect.mdx'));

function createTenantRoot() {
	const tenantRoot = mkdtempSync(resolve(tmpdir(), 'treeseed-agent-registry-'));
	tempRoots.push(tenantRoot);
	mkdirSync(resolve(tenantRoot, 'src/agent-handlers'), { recursive: true });
	return tenantRoot;
}

function profileAgent(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'engineer',
		agentClass: 'engineering',
		projectAgentClassId: 'engineering',
		projectAgentClassSlug: 'engineering',
		enabled: true,
		identity: {
			purpose: 'Implement scoped work.',
			responsibilities: ['Plan', 'Estimate', 'Act'],
			durableInstructions: 'Stay scoped.',
		},
		activityProfiles: {
			planning: {
				enabled: true,
				handler: 'actor',
				prompt: { system: 'Plan engineering work.' },
				branchPolicy: { kind: 'read-only', base: 'main' },
				tools: { allowed: ['treeseed.content.query', 'treeseed.content.read', 'treeseed.status'] },
				outputs: { messageTypes: [], modelMutations: ['note:create'] },
				permissions: {
					content: {
						question: { operations: ['query', 'read'] },
						decision: { operations: ['query', 'read'] },
						note: { operations: ['create'] },
					},
					commit: { allowed: false },
				},
			},
			acting: {
				enabled: true,
				handler: 'actor',
				prompt: { system: 'Implement engineering work.' },
				branchPolicy: {
					kind: 'assignment-feature',
					base: 'staging',
					target: 'staging',
					branchNameTemplate: 'agent/{agentSlug}/{assignmentId}',
				},
				tools: { allowed: ['treeseed.content.query', 'treeseed.content.read', 'treeseed.verify', 'treeseed.changed_paths'] },
				outputs: { messageTypes: [], modelMutations: ['implementation_report:create'] },
				permissions: {
					content: {
						question: { operations: ['query', 'read'] },
						decision: { operations: ['query', 'read'] },
					},
					repository: { readPaths: ['src/**'], writePaths: ['src/**'], allowCodeMutation: true },
					commit: { allowed: false },
				},
				execution: {
					allowedPaths: ['src/**'],
					forbiddenPaths: ['test/**', 'tests/**'],
				},
			},
		},
		...overrides,
	};
}

describe('agent handler registry', () => {
	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('loads tenant TypeScript handlers without requiring a tenant tsconfig', async () => {
		const tenantRoot = createTenantRoot();
		writeFileSync(
			resolve(tenantRoot, 'src/agent-handlers/security-audit.ts'),
			`import type { AgentHandler } from '@treeseed/agent/runtime-types';

export const securityAuditHandler: AgentHandler = {
\tkind: 'security-audit',
\tasync resolveInputs() { return {}; },
\tasync execute() { return { ok: true }; },
\tasync emitOutputs() { return { status: 'completed', summary: 'ok' }; },
};
`,
			'utf8',
		);

		const registry = await loadTenantAgentHandlerRegistry(tenantRoot);

		expect(registry.writer?.kind).toBe('writer');
		expect(registry.actor?.kind).toBe('actor');
		expect(registry.estimate?.kind).toBe('estimate');
		expect(registry.releaser?.kind).toBe('releaser');
		expect(registry.reporter?.kind).toBe('reporter');
		expect(registry['security-audit']?.kind).toBe('security-audit');
		await expect(listRegisteredAgentHandlers({ tenantRoot })).resolves.toEqual(expect.arrayContaining([
			'writer',
			'actor',
			'estimate',
			'releaser',
			'reporter',
			'security-audit',
		]));
	});

	it('normalizes activity profile specs into runtime specs', () => {
		const result = normalizeAgentRuntimeSpec(profileAgent(), {
			registeredHandlers: ['actor'],
			messageTypes: [],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.spec).toMatchObject({
			slug: 'engineer',
			handler: 'actor',
			activityType: 'acting',
			projectAgentClassId: 'engineering',
			tools: { allowed: ['treeseed.content.query', 'treeseed.content.read', 'treeseed.verify', 'treeseed.changed_paths'] },
			branchPolicy: {
				kind: 'assignment-feature',
				base: 'staging',
				target: 'staging',
			},
		});
	});

	it('selects the complete configured activity profile for assignment mode', () => {
		const normalized = normalizeAgentRuntimeSpec(profileAgent(), {
			registeredHandlers: ['actor'],
			messageTypes: [],
		});
		expect(normalized.spec).not.toBeNull();
		const planning = selectAgentActivityProfile(normalized.spec!, 'planning');
		expect(planning).toMatchObject({
			activityType: 'planning',
			handler: 'actor',
			systemPrompt: expect.stringContaining('Plan engineering work.'),
			outputs: { modelMutations: ['note:create'] },
			branchPolicy: { kind: 'read-only', base: 'main' },
		});
		expect(planning?.tools.allowed).toEqual(expect.arrayContaining(['treeseed.content.query', 'treeseed.content.read', 'treeseed.status']));
		expect(selectAgentActivityProfile(normalized.spec!, 'acting')).toMatchObject({
			execution: { allowedPaths: ['src/**'], forbiddenPaths: ['test/**', 'tests/**'] },
		});
		expect(selectAgentActivityProfile({ ...normalized.spec!, activityProfiles: {} }, 'planning')).toBeNull();
		expect(selectAgentActivityProfile({
			...normalized.spec!,
			activityProfiles: {
				...normalized.spec!.activityProfiles,
				reporting: {
					enabled: true,
					handler: 'reporter',
					prompt: { system: 'Report workday evidence.' },
					branchPolicy: { kind: 'read-only', base: 'main' },
					tools: { allowed: ['treeseed.content.read'] },
					outputs: { messageTypes: [], modelMutations: ['workday_report:create'] },
				},
			},
		}, 'planning', 'reporting')).toMatchObject({
			activityType: 'reporting',
			handler: 'reporter',
			systemPrompt: expect.stringContaining('Report workday evidence.'),
		});
	});

	it('selects reviewing in either provenance mode without falling back or gaining checkpoint authority', () => {
		const normalized = normalizeAgentRuntimeSpec(profileAgent(), {
			registeredHandlers: ['actor'],
			messageTypes: [],
		});
		expect(normalized.spec).not.toBeNull();
		const reviewProfile = {
			...normalized.spec!.activityProfiles.planning!,
			activityType: 'reviewing' as const,
			authorityPresets: ['review-authority' as const],
			prompt: { system: 'Review the exact deliverable.' },
			tools: { allowed: ['treeseed.changed_paths', 'treeseed.verify'] },
			outputs: { messageTypes: [], modelMutations: ['review_finding:create'] },
		};
		const agent = {
			...normalized.spec!,
			activityProfiles: { ...normalized.spec!.activityProfiles, reviewing: reviewProfile },
		};
		for (const mode of ['planning', 'acting'] as const) {
			const selected = selectAgentActivityProfile(agent, mode, 'reviewing');
			expect(selected).toMatchObject({
				activityType: 'reviewing',
				authorityPresetIds: ['review-authority'],
				authoritySnapshot: { presetIds: ['review-authority'], branchPolicy: { kind: 'read-only' } },
			});
			expect(selected?.tools.allowed).toContain('treeseed.changed_paths');
			expect(selected?.tools.allowed).not.toContain('treeseed.checkpoint');
		}
		expect(selectAgentActivityProfile(agent, 'planning', 'acting')).toBeNull();
		expect(selectAgentActivityProfile(agent, 'acting', 'reporting')).toBeNull();
	});

	it('derives a specialized chat profile from the common discussion foundation', () => {
		const normalized = normalizeAgentRuntimeSpec(profileAgent({ chatProfile: {
			foundation: 'discussion-v1', responseStyle: 'implementation-focused', requiredCapabilities: ['agent-execution', 'repository-write'], maxTotalTokens: 24_000, maxCostAmount: 2,
		} }), { registeredHandlers: ['actor', 'writer'], messageTypes: ['discussion_response'] });
		const chat = selectAgentActivityProfile(normalized.spec!, 'planning', 'chat');
		expect(chat).toMatchObject({ activityType: 'chat', handler: 'writer', execution: { requiredCapabilities: ['agent-execution', 'repository-write'], maxTotalTokens: 24_000, maxCostAmount: 2 } });
		expect(chat?.systemPrompt).toContain('implementation-focused');
		expect(chat?.systemPrompt).toContain('allocation is a maximum, not a target');
		expect(chat?.systemPrompt).toContain('completed_early');
		expect(chat?.permissionProjection?.write?.models).toEqual(expect.arrayContaining(['proposal', 'question', 'note']));
		expect(chat?.permissionProjection?.write?.models).not.toContain('discussion_message');
		expect(chat?.tools.allowed).toContain('treeseed.discussion.respond');
	});

	it('derives the provider tool policy from the assigned activity rather than the root profile', () => {
		const normalized = normalizeAgentRuntimeSpec(profileAgent(), {
			registeredHandlers: ['actor'],
			messageTypes: [],
		});
		const agent = {
			...normalized.spec!,
			activityProfiles: {
				...normalized.spec!.activityProfiles,
				estimating: {
					enabled: true,
					handler: 'estimate',
					prompt: { system: 'Estimate the proposal.' },
					branchPolicy: { kind: 'read-only' as const, base: 'main' },
					tools: { allowed: ['treeseed.content.read'] },
					outputs: { messageTypes: [], modelMutations: ['estimate:create'] },
					permissions: { content: { proposal: { operations: ['read'] } }, commit: { allowed: false } },
				},
			},
		};
		const policy = resolveAssignmentAgentToolPolicy(agent, 'planning', 'estimating');
		expect(policy).toMatchObject({
			activityType: 'estimating',
			permissionProjection: { commit: { allowed: false } },
		});
		expect(policy?.tools.allowed).toEqual(expect.arrayContaining(['treeseed.content.read', 'treeseed.status', 'treeseed.discussion.respond']));
		expect(policy?.tools.allowed).not.toContain('treeseed.content.create');
	});

	it('rejects legacy top-level agent configuration', () => {
		const result = normalizeAgentRuntimeSpec({
			...profileAgent(),
			handler: 'act',
			handlerConfig: { domain: 'legacy' },
			systemPrompt: 'Legacy.',
		}, {
			registeredHandlers: ['actor'],
			messageTypes: [],
		});

		expect(result.spec).toBeNull();
		expect(result.diagnostics).toEqual(expect.arrayContaining([
			expect.objectContaining({ field: 'handler', severity: 'error' }),
			expect.objectContaining({ field: 'handlerConfig', severity: 'error' }),
			expect.objectContaining({ field: 'systemPrompt', severity: 'error' }),
		]));
	});

	it('does not resolve removed generic handler names', async () => {
		const tenantRoot = createTenantRoot();

		await expect(resolveAgentHandler('plan', { tenantRoot })).rejects.toThrow('No runtime handler is registered');
		await expect(resolveAgentHandler('research', { tenantRoot })).rejects.toThrow('No runtime handler is registered');
		await expect(resolveAgentHandler('act', { tenantRoot })).rejects.toThrow('No runtime handler is registered');
		await expect(resolveAgentHandler('review', { tenantRoot })).rejects.toThrow('No runtime handler is registered');
		await expect(resolveAgentHandler('report', { tenantRoot })).rejects.toThrow('No runtime handler is registered');
		await expect(resolveAgentHandler('actor', { tenantRoot })).resolves.toMatchObject({ kind: 'actor' });
	});

	it('ships top-level Market engineering agent content with unprefixed slugs', async () => {
		if (!hasIntegratedMarketAgentContent) {
			expect(existsSync(resolve(agentRoot, 'package.json')), 'package-only verification must still have an agent package root').toBe(true);
			return;
		}
		const slugs = readdirSync(resolve(marketRoot, 'src/content/agents'))
			.filter((entry) => entry.endsWith('.mdx'))
			.map((entry) => entry.replace(/\.mdx$/u, ''));
		expect(slugs).toEqual(expect.arrayContaining([
			'architect',
			'technical-writer',
			'tester',
			'engineer',
			'researcher',
			'reviewer',
			'releaser',
			'reporter',
		]));
	}, 15_000);

	it('emits structured estimates from estimate activity output', async () => {
		const output = await estimateHandler.emitOutputs({
			runId: 'run-1',
			projectId: 'project-1',
			mode: 'planning',
			repoRoot: marketRoot,
			agent: {
				slug: 'engineer',
				agentClass: 'engineer',
				outputs: { messageTypes: [], modelMutations: [] },
			},
			capacity: {
				assignmentId: 'assignment-1',
				assignment: {
					id: 'assignment-1',
					teamId: 'team-1',
					projectId: 'project-1',
					projectAgentClassId: 'engineer',
				},
				envelope: {
					teamId: 'team-1',
					projectId: 'project-1',
					mode: 'planning',
					reservedSeconds: 2,
				},
				decisionInput: {
					input: { decisionId: 'decision-1' },
				},
			},
			sdk: { createMessage: async () => ({}) },
		} as never, {
			snapshot: {
				runId: 'provider-run-1',
				status: 'completed',
				summary: 'Estimated work.',
				outputs: {
					structuredEstimate: {
						expectedSeconds: 3,
						maxSeconds: 5,
						confidence: 'high',
						riskLevel: 'medium',
						dependencies: [{
							id: 'architecture-spec',
							type: 'artifact',
							requiredBefore: 'start',
							deliverableType: 'architecture_spec',
							agentClass: 'architect',
						}],
						expectedOutputs: [{ outputType: 'implementation_report', required: true }],
					},
				},
			},
			contentArtifactRefs: [],
		});

		expect(output.status).toBe('completed');
		expect(output.metadata?.structuredEstimate).toMatchObject({
			schemaVersion: 2,
			teamId: 'team-1',
			projectId: 'project-1',
			decisionId: 'decision-1',
			agentClass: 'engineer',
			expectedSeconds: 3,
			maxSeconds: 5,
			workBreakdown: { independentReviewSeconds: 1, finalReviewSeconds: 1, reportingSeconds: 1, expectedRevisionCycles: 1 },
		});
		expect(output.metadata?.estimateValidation).toMatchObject({ ok: true });
	});
});
