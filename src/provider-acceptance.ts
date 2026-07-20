import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { CapacityProviderPrivateJwk } from '@treeseed/sdk/capacity-provider';
import { DeterministicToolExecutionProviderAdapter, type DeterministicExecutionStep } from './agents/testing/deterministic-tool-provider.ts';
import { resolveProviderConfig } from './provider/config.ts';
import { ProviderLocalCapacityStore } from './provider/local-capacity-store.ts';
import { runMultiTeamProviderManager, runMultiTeamProviderRunners } from './provider/multi-team-runtime.ts';
import { callAgentToolWithTelemetry } from './agents/tools/agent-tool-telemetry.ts';
import type { AgentToolRuntimeOptions } from './agents/tools/agent-tool-runtime.ts';
import type { ExecutionProviderInvocation } from './agents/runtime-types.ts';

export interface DeterministicCapacityAcceptanceInput {
	runId: string;
	cwd: string;
	env: NodeJS.ProcessEnv | Record<string, string | undefined>;
	apiUrl: string;
	teamId: string;
	projectId: string;
	providerId: string;
	membershipId: string;
	credentialId: string;
	membershipCredential: string;
	providerAccessToken: string;
	providerSessionId: string;
	providerSessionSequence: number;
	privateJwk: CapacityProviderPrivateJwk;
	assignmentId?: string | null;
	repositoryRoot?: string;
	executionProviderId: string;
	capabilities?: string[];
	activityProfile?: {
		kind: 'research-planning' | 'research-workflow' | 'engineering-workflow';
		subjectModel: 'objective' | 'question';
		subjectSlug: string;
	};
	competingConnection?: {
		teamId: string;
		projectId: string;
		providerId: string;
		membershipId: string;
		credentialId: string;
		membershipCredential: string;
		providerAccessToken: string;
		providerSessionId: string;
		providerSessionSequence: number;
		assignmentId: string;
	};
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const researchBodies = {
	primary: 'Primary evidence: allocation enforcement requires durable admission records.',
	secondary: 'Contrary evidence: unique durable keys alone are insufficient without transaction boundaries.',
};
const researchCitations = [
	{ sourceUrl: 'https://example.com/source-one', title: 'Capacity source one', publisher: 'Example Primary', retrievedAt: '2026-07-19T00:00:00.000Z', contentHash: `sha256:${createHash('sha256').update(researchBodies.primary).digest('hex')}`, claimIds: ['claim-1', 'claim-2'], confidence: 'high' },
	{ sourceUrl: 'https://iana.org/source-two', title: 'Capacity source two', publisher: 'IANA Secondary', retrievedAt: '2026-07-19T00:00:00.000Z', contentHash: `sha256:${createHash('sha256').update(researchBodies.secondary).digest('hex')}`, claimIds: ['claim-1', 'claim-2'], confidence: 'high' },
];

async function callAcceptanceTool(options: AgentToolRuntimeOptions, toolId: string, input: Record<string, unknown> = {}) {
	if (toolId !== 'research.search_sources' && toolId !== 'research.fetch_source') return callAgentToolWithTelemetry(options, toolId, input);
	const descriptor = options.descriptors.find((candidate) => candidate.id === toolId);
	if (!descriptor) return { ok: false, code: 'tool_not_authorized', message: `${toolId} was not authorized for this activity profile.` };
	const startedAt = new Date().toISOString();
	await options.onTelemetry?.({ assignmentId: options.assignmentId, projectId: String(record(descriptor.metadata).projectId ?? ''), toolId, executionTarget: descriptor.executionTarget, mutability: descriptor.mutability, status: 'started', startedAt, inputSummary: input });
	const payload = toolId === 'research.search_sources'
		? { results: researchCitations.map((citation, index) => ({ url: citation.sourceUrl, title: citation.title, publisher: citation.publisher, summary: index === 0 ? researchBodies.primary : researchBodies.secondary })) }
		: { source: researchCitations.find((citation) => citation.sourceUrl === input.url), content: input.url === researchCitations[0]!.sourceUrl ? researchBodies.primary : researchBodies.secondary };
	const completedAt = new Date().toISOString();
	await options.onTelemetry?.({ assignmentId: options.assignmentId, projectId: String(record(descriptor.metadata).projectId ?? ''), toolId, executionTarget: descriptor.executionTarget, mutability: descriptor.mutability, status: 'completed', startedAt, completedAt, durationMs: Date.parse(completedAt) - Date.parse(startedAt), inputSummary: input, outputSummary: payload });
	return { ok: true, payload };
}

function researchWorkflowSteps(input: ExecutionProviderInvocation, runId: string): DeterministicExecutionStep[] | null {
	const stage = String(record(input.decisionInput.input).researchStage ?? '').trim();
	if (!stage) return null;
	const relation = [{ field: 'relatedQuestions', targetModel: 'question', targetSlug: 'what-should-this-research-map-first' }];
	const create = (title: string, body: string, fields?: Record<string, unknown>) => ({ kind: 'tool' as const, toolId: 'treeseed.content.create', input: { model: 'note', title, body, ...(fields ? { fields } : {}), relations: relation } });
	const steps: DeterministicExecutionStep[] = [create(`Research ${stage} ${runId}`, `${stage} completed with durable research evidence.`)];
	if (stage === 'question-decomposition') steps.splice(0, steps.length, { kind: 'tool', toolId: 'treeseed.content.create', input: { model: 'question', title: `What should this research map first ${runId}`, body: 'Which capacity governance and settlement guarantees are supported by independent evidence?', relations: relation } });
	if (stage === 'governed-source-search') steps.unshift({ kind: 'tool', toolId: 'research.search_sources', input: { query: 'reliable capacity governance and settlement', maxResults: 5 } });
	if (stage === 'independent-source-fetch') steps.unshift(
		{ kind: 'tool', toolId: 'research.fetch_source', input: { url: researchCitations[0]!.sourceUrl } },
		{ kind: 'tool', toolId: 'research.fetch_source', input: { url: researchCitations[1]!.sourceUrl } },
	);
	if (stage === 'linked-evidence-notes') steps.splice(0, steps.length,
		create(`Research evidence one ${runId}`, researchBodies.primary, { citations: [researchCitations[0]] }),
		create(`Research evidence two ${runId}`, researchBodies.secondary, { citations: [researchCitations[1]] }),
	);
	if (stage === 'cited-knowledge-publication') steps.splice(0, steps.length, { kind: 'tool', toolId: 'treeseed.content.create', input: { model: 'knowledge', title: `Reliable capacity governance evidence ${runId}`, body: 'Durable admission is supported. Contrary evidence shows unique keys alone do not replace transaction boundaries.', fields: { citations: researchCitations }, relations: relation } });
	if (stage === 'workday-report') steps.splice(0, steps.length, create(`Research workday summary ${runId}`, 'The governed research workflow completed with cited evidence, independent review, revision, and publication.'));
	const outputs: Record<string, unknown> = {};
	if (stage === 'independent-source-fetch') outputs.citations = researchCitations;
	if (stage === 'claim-synthesis') outputs.signals = [{ code: 'research_claim', severity: 'warning', message: 'Unsupported fixture claim.', metadata: { id: 'claim-1', text: 'Durable admission and unique settlement keys are required.', material: true, status: 'unsupported', citationIds: [] } }];
	if (stage === 'citation-review-rejection') outputs.signals = [{ code: 'research_review_rejected', severity: 'warning', message: 'The material claim lacks attached citation evidence.' }];
	if (stage === 'revision') outputs.signals = [
		{ code: 'research_claim', severity: 'info', message: 'Claim revised with evidence.', metadata: { id: 'claim-1', text: 'Durable admission and transactional settlement are supported.', material: true, status: 'supported', citationIds: ['one', 'two'] } },
		{ code: 'research_claim', severity: 'warning', message: 'Contradictory evidence retained.', metadata: { id: 'claim-2', text: 'Unique durable keys alone are sufficient.', material: true, status: 'contradicted', citationIds: ['one', 'two'] } },
	];
	if (stage === 'citation-review-approval') outputs.signals = [{ code: 'research_review_approved', severity: 'info', message: 'The revised claim is independently supported.' }];
	steps.push({ kind: 'tool', toolId: 'treeseed.content.commit', input: { message: `Complete research ${stage} ${runId}` } });
	steps.push({ kind: 'output', outputs, verification: { status: 'passed', summary: `${stage} completed.` } });
	return steps;
}

function engineeringWorkflowSteps(input: ExecutionProviderInvocation, runId: string): DeterministicExecutionStep[] | null {
	const decision = record(input.decisionInput.input);
	const nested = record(decision.input);
	const payload = Object.keys(nested).length > 0 ? nested : decision;
	const artifactKind = String(payload.artifactKind ?? '').trim();
	const nodeId = String(decision.workGraphNodeId ?? payload.workGraphNodeId ?? '').trim();
	if (!artifactKind || !nodeId) return null;
	const stage = nodeId.split(':node:').pop()?.split(':').pop() ?? artifactKind;
	const revision = nodeId.includes(':revision:');
	const relation = [{ field: 'relatedDecisions', targetModel: 'decision', targetSlug: String(payload.decisionId ?? 'normalize-release-channel-inputs') }];
	const note = (title: string, body: string) => ({ kind: 'tool' as const, toolId: 'treeseed.content.create', input: { model: 'note', title: `${title} ${runId}`, body, relations: relation } });
	const steps: DeterministicExecutionStep[] = [];
	if (stage === 'test') steps.push({
		kind: 'write-file', path: 'template/tests/normalize-release-channel.test.ts',
		content: "import { normalizeReleaseChannel } from '../src/lib/normalize-release-channel';\nif (normalizeReleaseChannel(' BETA ') !== 'beta') throw new Error('release channel was not normalized');\n",
	});
	if (stage === 'implementation') steps.push({
		kind: 'write-file', path: 'template/src/lib/normalize-release-channel.ts',
		content: revision
			? "export const normalizeReleaseChannel = (value: string) => { const normalized = value.trim().toLowerCase(); if (!normalized) throw new Error('release channel is required'); return normalized; };\n"
			: "export const normalizeReleaseChannel = (value: string) => value.trim().toLowerCase();\n",
	});
	if (stage === 'documentation') steps.push({ kind: 'write-file', path: 'template/docs/release-channel.md', content: 'Release-channel values are trimmed, lowercased, and must not be empty.\n' });
	steps.push(note(`Engineering ${stage}${revision ? ' revision' : ''}`, `${artifactKind} completed with exact decision, work-graph, source-ref, and verification provenance.`));
	if (stage === 'test' || stage === 'implementation' || stage === 'documentation') {
		steps.push({ kind: 'tool', toolId: 'treeseed.checkpoint', input: { message: `engineering: complete ${stage}${revision ? ' revision' : ''}` } });
	}
	steps.push({ kind: 'tool', toolId: 'treeseed.content.commit', input: { message: `Record engineering ${stage} ${runId}` } });
	steps.push({
		kind: 'output',
		...(stage === 'review' ? { signals: revision
			? [{ code: 'review_approved', severity: 'info' as const, message: 'The revision satisfies the requested empty-input behavior.' }]
			: [{ code: 'revision_required', severity: 'warning' as const, message: 'Reject empty normalized release-channel input before approval.' }] } : {}),
		verification: { status: stage === 'test' ? 'failed' : 'passed', summary: `${artifactKind} completed.` },
	});
	return steps;
}

function engineeringPlanningSteps(input: ExecutionProviderInvocation, runId: string): DeterministicExecutionStep[] | null {
	const decision = record(input.decisionInput.input);
	const intent = record(decision.intent);
	const artifactKind = String(intent.artifactKind ?? decision.artifactKind ?? '').trim();
	if (input.agent.handler === 'estimate') return [{
		kind: 'output', outputs: { structuredEstimate: {
			id: `engineering-estimate-${runId}`, minCredits: 8, expectedCredits: 12, maxCredits: 16,
			confidence: 'high', riskLevel: 'medium', assumptions: ['The starter fixture remains independently buildable.'], blockers: [], dependencies: [],
			expectedOutputs: [{ outputType: 'implementation_change', required: true }],
			acceptanceCriteria: ['The regression, implementation, review revision, documentation, and release-readiness graph completes.'],
			completionEvidence: ['Exact-ref worktree, checkpoints, verification, review, artifacts, usage, and settlement are retained.'],
		} }, verification: { status: 'passed', summary: 'Structured engineering estimate completed.' },
	}];
	if (input.agent.handler === 'reporter') return [
		{ kind: 'tool', toolId: 'treeseed.content.create', input: { model: 'note', title: `Engineering workday summary ${runId}`, body: 'The test-first graph completed planning, exact-ref execution, review revision, documentation, release readiness, artifacts, usage, and settlement.', relations: [{ field: 'relatedDecisions', targetModel: 'decision', targetSlug: 'normalize-release-channel-inputs' }] } },
		{ kind: 'tool', toolId: 'treeseed.content.commit', input: { message: `Create engineering workday summary ${runId}` } },
		{ kind: 'output', verification: { status: 'passed', summary: 'Engineering workday report completed.' } },
	];
	if (artifactKind !== 'planning_proposal') return null;
	return [
		{ kind: 'tool', toolId: 'treeseed.content.create', input: { model: 'proposal', title: 'Normalize release channel inputs', body: 'Normalize release-channel inputs through a test-first exact-ref workflow with an explicit empty-input revision.', relations: [{ field: 'relatedObjectives', targetModel: 'objective', targetSlug: 'ship-the-first-guided-change' }] } },
		{ kind: 'tool', toolId: 'treeseed.content.commit', input: { message: `Create engineering proposal ${runId}` } },
		{ kind: 'output', verification: { status: 'passed', summary: 'Decision-linked engineering proposal completed.' } },
	];
}

export async function executeDeterministicCapacityAcceptance(input: DeterministicCapacityAcceptanceInput) {
	const root = await mkdtemp(resolve(tmpdir(), 'treeseed-capacity-acceptance-'));
	const dataDir = String(input.env.TREESEED_PROVIDER_HOST_DATA_DIR ?? resolve(input.cwd, '.treeseed/local-capacity-provider/data'));
	const connectionId = `acceptance-${input.runId}`;
	const identityPath = resolve(root, 'identity.json');
	const credentialPath = resolve(root, 'membership.credential');
	const competingCredentialPath = resolve(root, 'competing-membership.credential');
	const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
	await writeFile(identityPath, `${JSON.stringify(input.privateJwk)}\n`, { mode: 0o600 });
	await writeFile(credentialPath, `${input.membershipCredential}\n`, { mode: 0o600 });
	if (input.competingConnection) await writeFile(competingCredentialPath, `${input.competingConnection.membershipCredential}\n`, { mode: 0o600 });
	const competingConnectionId = `competition-${input.runId}`;
	const capabilities = [...new Set(input.capabilities ?? ['planning', 'agent_mode_run', 'repo_read', 'usage_report'])];
	const yamlCapabilities = `[${capabilities.join(', ')}]`;
	const connections = [
		'schemaVersion: 2',
		'identity:',
		`  privateKeyRef: file://${identityPath}`,
		`  displayName: Treeseed deterministic acceptance ${input.runId}`,
		'executionProviders:',
		`  - id: ${input.executionProviderId}`,
		'    adapter: deterministic_workflow',
		'    nativeLimits: { maxConcurrentRunners: 1, availableCredits: 10 }',
		`    capabilities: ${yamlCapabilities}`,
		'connections:',
		`  - id: ${connectionId}`,
		`    marketUrl: ${input.apiUrl}`,
		`    marketAudience: ${input.apiUrl}`,
		`    teamId: ${input.teamId}`,
		`    providerId: ${input.providerId}`,
		`    membershipId: ${input.membershipId}`,
		`    membershipCredentialRef: file://${credentialPath}`,
		`    membershipCredentialId: ${input.credentialId}`,
		'    offer:',
		'      weight: 1',
		'      maxConcurrentRunners: 1',
		`      capabilities: ${yamlCapabilities}`,
	];
	if (input.competingConnection) connections.push(
		`  - id: ${competingConnectionId}`,
		`    marketUrl: ${input.apiUrl}`,
		`    marketAudience: ${input.apiUrl}`,
		`    teamId: ${input.competingConnection.teamId}`,
		`    providerId: ${input.competingConnection.providerId}`,
		`    membershipId: ${input.competingConnection.membershipId}`,
		`    membershipCredentialRef: file://${competingCredentialPath}`,
		`    membershipCredentialId: ${input.competingConnection.credentialId}`,
		'    offer:',
		'      weight: 1',
		'      maxConcurrentRunners: 1',
		`      capabilities: ${yamlCapabilities}`,
	);
	await writeFile(manifestPath, connections.join('\n'), { mode: 0o600 });
	const config = resolveProviderConfig({ env: {
		...process.env,
		...input.env,
		HOME: root,
		TREESEED_PROVIDER_DATA_DIR: dataDir,
		TREESEED_CAPACITY_PROVIDER_MANIFEST: manifestPath,
		TREESEED_PROVIDER_ENVIRONMENT: 'local',
		TREESEED_PROVIDER_MAX_CONCURRENT_RUNNERS: '1',
	} });
	const localState = new ProviderLocalCapacityStore(dataDir);
	const sessionStateKey = `${connectionId}|${input.teamId}|${input.providerId}`;
	const competingSessionStateKey = input.competingConnection
		? `${competingConnectionId}|${input.competingConnection.teamId}|${input.competingConnection.providerId}`
		: null;
	const subject = input.activityProfile ?? {
		kind: 'research-planning' as const,
		subjectModel: 'objective' as const,
		subjectSlug: 'harden-documentation-automation-workday-loop',
	};
	const relationField = subject.subjectModel === 'question' ? 'relatedQuestions' : 'relatedObjectives';
	const createAdapter = (providerAccessToken: string) => new DeterministicToolExecutionProviderAdapter({
		repoRoot: input.repositoryRoot ?? input.cwd,
		apiBaseUrl: input.apiUrl,
		providerAccessToken,
		callTool: callAcceptanceTool,
		steps: (invocation) => engineeringWorkflowSteps(invocation, input.runId) ?? engineeringPlanningSteps(invocation, input.runId) ?? researchWorkflowSteps(invocation, input.runId) ?? [{
			kind: 'tool',
			toolId: 'treeseed.content.create',
			input: {
				model: 'note',
				title: input.activityProfile ? `Research starter planning ${input.runId}` : `Capacity service acceptance ${input.runId}`,
				body: input.activityProfile
					? 'A content-defined research starter agent completed a bounded planning contribution through the real service path.'
					: 'The deterministic provider manager, runner, AgentKernel, and TreeDX service path completed.',
				relations: [{ field: relationField, targetModel: subject.subjectModel, targetSlug: subject.subjectSlug }],
			},
		}, {
			kind: 'tool',
			toolId: 'treeseed.content.commit',
			input: {
				message: `Record capacity service acceptance ${input.runId}`,
			},
		}, {
			kind: 'output',
			verification: { status: 'passed', summary: 'Full local capacity service path completed.' },
		}],
	});
	try {
		await localState.saveSession(sessionStateKey, { id: input.providerSessionId, sequence: input.providerSessionSequence });
		if (input.competingConnection && competingSessionStateKey) {
			await localState.saveSession(competingSessionStateKey, {
				id: input.competingConnection.providerSessionId,
				sequence: input.competingConnection.providerSessionSequence,
			});
		}
		const manager = await runMultiTeamProviderManager(config).catch((error) => {
			throw new Error(`Deterministic acceptance provider manager failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		const dispatches = Array.isArray(manager.dispatches) ? manager.dispatches : [];
		const readyDispatches = dispatches.filter((entry) => entry.status === 'ready');
		if (input.competingConnection) {
			const successfulConnections = Array.isArray(manager.connections)
				? manager.connections.filter((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).ok === true)
				: [];
			const scheduler = manager.scheduler && typeof manager.scheduler === 'object'
				? manager.scheduler as { maxConcurrentSlots?: number; connections?: unknown[] }
				: {};
			const snapshot = await localState.snapshot();
			if (successfulConnections.length !== 2 || scheduler.connections?.length !== 2) {
				throw new Error(`Provider manager did not reconcile two independently runnable connections: ${JSON.stringify(manager.connections)}`);
			}
			if (scheduler.maxConcurrentSlots !== 1 || readyDispatches.length !== 1 || snapshot.claims.length !== 1) {
				throw new Error(`Provider-global final-slot enforcement failed: ${JSON.stringify({ scheduler, readyDispatches, claims: snapshot.claims })}`);
			}
		}
		const dispatch = dispatches.find((entry) => entry.status === 'ready' && (!input.assignmentId || entry.assignmentId === input.assignmentId));
		if (!dispatch?.assignmentId) {
			throw new Error(`Provider manager did not create the expected durable dispatch: ${JSON.stringify({
				dispatches: dispatches.map((entry) => ({ assignmentId: entry.assignmentId, connectionId: entry.connectionId, status: entry.status, error: entry.error ?? null })),
				connections: manager.connections,
			})}`);
		}
		const currentAccessToken = await localState.token(connectionId);
		if (!currentAccessToken || Date.parse(currentAccessToken.expiresAt) <= Date.now()) {
			throw new Error('Provider coordinator did not persist a current membership access token before deterministic runner dispatch.');
		}
		const adapter = createAdapter(currentAccessToken.accessToken);
		const runner = await runMultiTeamProviderRunners(config, { executionAdapter: adapter }).catch((error) => {
			throw new Error(`Deterministic acceptance provider runner failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		if (runner.dispatched !== 1) throw new Error(`Provider runner dispatched ${runner.dispatched} assignments instead of one.`);
		const failed = runner.results?.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).ok === false);
		if (failed) throw new Error(`Provider runner failed deterministic acceptance: ${JSON.stringify(failed)}`);
		const completed = runner.results?.some((entry) => {
			const result = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).result : null;
			const envelope = result && typeof result === 'object' ? result as Record<string, unknown> : {};
			const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : envelope;
			return payload.status === 'completed';
		});
		if (!completed) {
			const outcomes = (runner.results ?? []).map((entry) => {
				const result = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).result : null;
				const envelope = result && typeof result === 'object' ? result as Record<string, unknown> : {};
				const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : envelope;
				return {
					assignmentId: payload.id ?? payload.assignmentId ?? null,
					status: payload.status ?? null,
					lifecycleCode: payload.lifecycleCode ?? null,
					lifecycleReason: payload.lifecycleReason ?? null,
				};
			});
			throw new Error(`Provider runner did not complete deterministic acceptance: ${JSON.stringify(outcomes)}`);
		}
		const session = await localState.session(sessionStateKey);
		return {
			assignmentId: dispatch.assignmentId,
			providerSessionSequence: session?.sequence ?? input.providerSessionSequence,
			...(input.competingConnection ? {
				finalSlot: {
					twoRunnableConnections: true,
					providerGlobalLimit: 1,
					readyDispatches: readyDispatches.length,
					localClaimsAtCapacity: 1,
				},
			} : {}),
		};
	} finally {
		await localState.removeSession(sessionStateKey);
		if (competingSessionStateKey) await localState.removeSession(competingSessionStateKey);
		await localState.removeToken(connectionId);
		await localState.removeConnection(connectionId);
		if (input.competingConnection) {
			await localState.removeToken(competingConnectionId);
			await localState.removeConnection(competingConnectionId);
		}
		await rm(root, { recursive: true, force: true });
	}
}
