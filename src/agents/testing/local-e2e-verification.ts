import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCodexProviderReadiness, type CodexProviderReadiness } from '../adapters/codex-readiness.ts';
import { TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS } from '../knowledge/pipeline.ts';
import { collectAgentArtifactApiState, collectAgentOperationApiState, recordAgentApprovalDecision } from '../../api/agent-artifacts.ts';
import {
	extractGeneratedArtifactsFromTaskOutputs,
	isResearchKnowledgeTaskKind,
	seedResearchKnowledgeWorkdayTasks,
	type GeneratedAgentArtifactSummary,
	type ResearchKnowledgeTaskKind,
} from '../../services/research-knowledge-workday.ts';
import { executeResearchKnowledgeTask } from '../../services/worker.ts';
import { writeWorkdayContentSnapshot, type WorkdayContentTaskSummary } from '../../services/workday-content.ts';

type JsonRecord = Record<string, unknown>;

export interface RunLocalEndToEndVerificationOptions {
	repoRoot?: string;
	now?: Date;
	projectId?: string;
	teamId?: string;
	environment?: 'local' | 'staging' | 'prod';
}

export interface LocalEndToEndVerificationSummary {
	ok: boolean;
	repoRoot: string;
	projectId: string;
	workDayId: string;
	seededTaskCount: number;
	taskCounts: {
		total: number;
		completed: number;
		waiting: number;
		byKind: Record<string, number>;
	};
	artifactCounts: Record<GeneratedAgentArtifactSummary['artifactKind'], number>;
	approvalCount: number;
	releaseApprovalCount: number;
	stagedPathCount: number;
	releaseResultCount: number;
	generatedTargetPaths: string[];
	report: {
		relativePath: string;
		includesGeneratedArtifactsSection: boolean;
		includesAllTargetPaths: boolean;
		includesOperationSections: boolean;
		includesReleaseResults: boolean;
	};
	api: {
		artifactCount: number;
		researchNoteCount: number;
		knowledgeDraftCount: number;
		optimizationReportCount: number;
		approvalCount: number;
		releaseApprovalCount: number;
		operationEventCount: number;
		releaseResultCount: number;
		reportCount: number;
		currentWorkdayReported: boolean;
		warnings: string[];
	};
	codexReadiness: CodexProviderReadiness;
	releaseAttempted: boolean;
	stagingAttempted: boolean;
}

function isoDate(date: Date) {
	return date.toISOString();
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function readString(record: JsonRecord, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return '';
}

function parseJsonRecord(value: unknown) {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
	if (typeof value !== 'string' || !value.trim()) return {};
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return {};
	}
}

function countBy<T extends string>(values: T[]) {
	return values.reduce((counts, value) => {
		counts[value] = (counts[value] ?? 0) + 1;
		return counts;
	}, {} as Record<T, number>);
}

function contextPackForQuery(request: JsonRecord) {
	const query = readString(request, 'query') || 'TreeSeed agent knowledge';
	const slug = query
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 48) || 'context';
	const title = query
		.split(/\s+/u)
		.slice(0, 5)
		.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
		.join(' ');
	const fileNodeId = ['file', `knowledge/${slug}`].join(':');
	return {
		seedIds: [`node:${slug}`],
		totalTokenEstimate: 64,
		includedNodeIds: [`node:${slug}`, fileNodeId],
		nodes: [
			{
				node: {
					id: `node:${slug}`,
					title,
					data: { relativePath: `knowledge/${slug}.md` },
				},
			},
			{
				node: {
					id: fileNodeId,
					title: `${title} Source`,
					data: { relativePath: `src/content/knowledge/${slug}.mdx` },
				},
			},
		],
		edges: [],
	};
}

class InMemoryE2eSdk {
	tasks: JsonRecord[] = [];
	taskOutputs: JsonRecord[] = [];
	taskEvents: JsonRecord[] = [];
	messages: JsonRecord[] = [];
	approvalRequests: JsonRecord[] = [];
	teamInboxItems: JsonRecord[] = [];
	reports: JsonRecord[] = [];
	workDays: JsonRecord[];
	private nextTaskNumber = 1;
	private nextOutputNumber = 1;

	constructor(readonly workDay: JsonRecord, readonly nowIso: string) {
		this.workDays = [workDay];
	}

	scopeForAgent() {
		return this;
	}

	async searchTasks(request: { workDayId?: string; state?: string | string[]; limit?: number } = {}) {
		const states = Array.isArray(request.state) ? new Set(request.state) : request.state ? new Set([request.state]) : null;
		const payload = this.tasks
			.filter((task) => !request.workDayId || readString(task, 'workDayId', 'work_day_id') === request.workDayId)
			.filter((task) => !states || states.has(readString(task, 'state')))
			.slice(0, request.limit ?? this.tasks.length);
		return { payload };
	}

	async createTask(request: JsonRecord) {
		const task = {
			id: `task-${this.nextTaskNumber++}`,
			workDayId: String(request.workDayId ?? ''),
			agentId: String(request.agentId ?? ''),
			type: String(request.type ?? ''),
			state: typeof request.state === 'string' ? request.state : 'pending',
			priority: Number(request.priority ?? 0),
			idempotencyKey: String(request.idempotencyKey ?? ''),
			payloadJson: JSON.stringify(asRecord(request.payload)),
			graphVersion: typeof request.graphVersion === 'string' ? request.graphVersion : null,
			createdAt: this.nowIso,
			updatedAt: this.nowIso,
		};
		this.tasks.push(task);
		return { payload: task };
	}

	async recordTaskCredits() {
		return { payload: {} };
	}

	async recordTaskProgress(request: JsonRecord) {
		const task = this.tasks.find((entry) => entry.id === request.id);
		if (task) {
			task.state = typeof request.state === 'string' ? request.state : task.state;
			task.updatedAt = this.nowIso;
		}
		if (request.appendEvent) {
			this.taskEvents.push({
				id: `event-${this.taskEvents.length + 1}`,
				taskId: request.id,
				kind: readString(asRecord(request.appendEvent), 'kind') || 'progress',
				data: asRecord(asRecord(request.appendEvent).data),
				createdAt: this.nowIso,
			});
		}
		return { payload: task ?? {} };
	}

	async appendTaskEvent(request: JsonRecord) {
		const event = {
			id: `event-${this.taskEvents.length + 1}`,
			taskId: String(request.taskId ?? ''),
			kind: String(request.kind ?? 'task_event'),
			data: asRecord(request.data),
			dataJson: JSON.stringify(asRecord(request.data)),
			actor: String(request.actor ?? 'local-e2e'),
			createdAt: this.nowIso,
		};
		this.taskEvents.push(event);
		return { payload: event };
	}

	async createMessage(request: JsonRecord) {
		const message = {
			id: `message-${this.messages.length + 1}`,
			...request,
			createdAt: this.nowIso,
		};
		this.messages.push(message);
		return { payload: message };
	}

	async createApprovalRequest(request: JsonRecord) {
		const existing = this.approvalRequests.find((entry) => readString(entry, 'id') === readString(request, 'id'));
		if (existing) {
			if (readString(existing, 'state') !== 'pending') return { payload: existing };
			Object.assign(existing, {
				...request,
				state: readString(request, 'state') || readString(existing, 'state') || 'pending',
				createdAt: readString(existing, 'createdAt') || this.nowIso,
				updatedAt: this.nowIso,
			});
			return { payload: existing };
		}
		const approval = {
			...request,
			id: readString(request, 'id') || `approval-${this.approvalRequests.length + 1}`,
			state: readString(request, 'state') || 'pending',
			createdAt: this.nowIso,
			updatedAt: this.nowIso,
		};
		this.approvalRequests.push(approval);
		return { payload: approval };
	}

	async listApprovalRequests(request: { projectId?: string; teamId?: string; state?: string | string[]; limit?: number } = {}) {
		const states = Array.isArray(request.state) ? new Set(request.state) : request.state ? new Set([request.state]) : null;
		const payload = this.approvalRequests
			.filter((approval) => !request.projectId || readString(approval, 'projectId') === request.projectId)
			.filter((approval) => !request.teamId || readString(approval, 'teamId') === request.teamId)
			.filter((approval) => !states || states.has(readString(approval, 'state')))
			.slice(0, request.limit ?? this.approvalRequests.length);
		return { payload };
	}

	async decideApprovalRequest(id: string, request: JsonRecord) {
		const approval = this.approvalRequests.find((entry) => readString(entry, 'id') === id);
		if (!approval) return { payload: null };
		approval.state = readString(request, 'state') || readString(approval, 'state') || 'pending';
		approval.decision = request.decision ?? {
			optionId: request.optionId ?? null,
			note: request.note ?? null,
		};
		approval.decidedByType = request.decidedByType ?? null;
		approval.decidedById = request.decidedById ?? null;
		approval.decidedAt = this.nowIso;
		approval.updatedAt = this.nowIso;
		return { payload: approval };
	}

	async upsertTeamInboxItem(request: JsonRecord) {
		const id = readString(request, 'id') || `inbox-${this.teamInboxItems.length + 1}`;
		const itemKey = readString(request, 'itemKey', 'item_key');
		const existing = this.teamInboxItems.find((entry) => readString(entry, 'id') === id || (itemKey && readString(entry, 'itemKey', 'item_key') === itemKey));
		if (existing) {
			Object.assign(existing, {
				...request,
				id: readString(existing, 'id') || id,
				createdAt: readString(existing, 'createdAt') || this.nowIso,
				updatedAt: this.nowIso,
			});
			return { payload: existing };
		}
		const item = {
			...request,
			id,
			createdAt: this.nowIso,
			updatedAt: this.nowIso,
		};
		this.teamInboxItems.push(item);
		return { payload: item };
	}

	async buildContextPack(request: JsonRecord) {
		return contextPackForQuery(request);
	}

	async search(request: { model: string; filters?: Array<JsonRecord>; limit?: number }) {
		let payload: JsonRecord[] = [];
		if (request.model === 'task_output') {
			payload = this.taskOutputs;
		} else if (request.model === 'task_event') {
			payload = this.taskEvents;
		} else if (request.model === 'work_day') {
			payload = this.workDays;
		} else if (request.model === 'report') {
			payload = this.reports;
		}
		for (const filter of request.filters ?? []) {
			const field = readString(filter, 'field');
			const op = readString(filter, 'op');
			const value = filter.value;
			if (field === 'task_id' && op === 'in' && Array.isArray(value)) {
				const allowed = new Set(value.map(String));
				payload = payload.filter((entry) => allowed.has(readString(entry, 'taskId', 'task_id')));
			}
			if ((field === 'taskId' || field === 'task_id') && op === 'eq') {
				payload = payload.filter((entry) => readString(entry, 'taskId', 'task_id') === String(value));
			}
			if (field === 'project_id' && op === 'eq') {
				payload = payload.filter((entry) => readString(entry, 'projectId', 'project_id') === String(value));
			}
		}
		return { payload: payload.slice(0, request.limit ?? payload.length) };
	}

	completeTask(task: JsonRecord, output: JsonRecord) {
		task.state = 'completed';
		task.completedAt = this.nowIso;
		task.updatedAt = this.nowIso;
		this.taskOutputs.push({
			id: `output-${this.nextOutputNumber++}`,
			taskId: String(task.id ?? ''),
			outputJson: JSON.stringify(output),
			createdAt: this.nowIso,
		});
	}

	createReport(body: JsonRecord, renderedRef: string) {
		const report = {
			id: `report-${this.reports.length + 1}`,
			workDayId: readString(this.workDay, 'id'),
			kind: 'workday_summary',
			bodyJson: JSON.stringify(body),
			renderedRef,
			createdAt: this.nowIso,
		};
		this.reports.push(report);
		return report;
	}
}

function collectRelativeFiles(root: string, current = root): string[] {
	if (!statSync(current, { throwIfNoEntry: false })?.isDirectory()) {
		return [];
	}
	return readdirSync(current).flatMap((entry) => {
		const absolute = join(current, entry);
		const stat = statSync(absolute);
		if (stat.isDirectory()) {
			return collectRelativeFiles(root, absolute);
		}
		return absolute.slice(root.length + 1).replaceAll('\\', '/');
	});
}

class LocalE2eWorktrees {
	constructor(private readonly root: string, private readonly nowIso: string) {}

	plannedWorktreePath(featureBranch: string) {
		return join(this.root, '.agent-worktrees', featureBranch.replace(/[^A-Za-z0-9._/-]+/gu, '-'));
	}

	async createOrResumeWorktree(featureBranch: string) {
		const worktreeRoot = this.plannedWorktreePath(featureBranch);
		mkdirSync(worktreeRoot, { recursive: true });
		return {
			branchName: featureBranch,
			worktreeRoot,
			created: true,
		};
	}

	async inspectChangedPaths(worktreeRoot: string) {
		return collectRelativeFiles(worktreeRoot).filter((filePath) => filePath.startsWith('src/content/knowledge/'));
	}

	assertChangedPathsAllowed(input: { changedPaths: string[]; allowedPaths: string[]; forbiddenPaths: string[] }) {
		const violations = input.changedPaths.filter((changedPath) => {
			if (input.forbiddenPaths.includes(changedPath)) return true;
			return input.allowedPaths.length > 0 && !input.allowedPaths.includes(changedPath);
		});
		if (violations.length > 0) {
			throw new Error(`Changed paths outside approved scope: ${violations.join(', ')}`);
		}
	}

	async saveSnapshot(input: { taskId: string; kind: string; summary: string; changedPaths: string[] }) {
		return {
			kind: input.kind,
			ref: join(this.root, '.treeseed', 'tmp', `${input.taskId}-${input.kind}.json`),
			summary: input.summary,
			changedPaths: input.changedPaths,
			createdAt: this.nowIso,
		};
	}

	async stageAndCommit() {
		return `feature-${this.nowIso}`;
	}

	async mergeToStaging(input: { taskId: string; featureBranch: string; stagingBranch: string }) {
		return {
			status: 'completed',
			mergedToStaging: true,
			commitSha: `staging-${input.taskId}`,
			featureBranch: input.featureBranch,
			stagingBranch: input.stagingBranch,
		};
	}
}

function taskSummaries(sdk: InMemoryE2eSdk): WorkdayContentTaskSummary[] {
	return sdk.tasks.map((task) => ({
		id: readString(task, 'id'),
		agentId: readString(task, 'agentId') || undefined,
		type: readString(task, 'type') || undefined,
		state: readString(task, 'state') || undefined,
		priority: Number(task.priority ?? 0),
		idempotencyKey: readString(task, 'idempotencyKey') || undefined,
		createdAt: readString(task, 'createdAt') || null,
		completedAt: readString(task, 'completedAt') || null,
		outputCount: sdk.taskOutputs.filter((output) => readString(output, 'taskId') === readString(task, 'id')).length,
	}));
}

function artifactCounts(artifacts: GeneratedAgentArtifactSummary[]) {
	const uniqueKeys = new Set<string>();
	const uniqueArtifacts = artifacts.filter((artifact) => {
		const key = `${artifact.artifactKind}:${artifact.id}`;
		if (uniqueKeys.has(key)) return false;
		uniqueKeys.add(key);
		return true;
	});
	return {
		codebase_inventory: uniqueArtifacts.filter((artifact) => artifact.artifactKind === 'codebase_inventory').length,
		research_note: uniqueArtifacts.filter((artifact) => artifact.artifactKind === 'research_note').length,
		knowledge_draft: uniqueArtifacts.filter((artifact) => artifact.artifactKind === 'knowledge_draft').length,
		optimization_report: uniqueArtifacts.filter((artifact) => artifact.artifactKind === 'optimization_report').length,
		docs_mutation_result: uniqueArtifacts.filter((artifact) => artifact.artifactKind === 'docs_mutation_result').length,
		promotion_request: uniqueArtifacts.filter((artifact) => artifact.artifactKind === 'promotion_request').length,
		release_request: uniqueArtifacts.filter((artifact) => artifact.artifactKind === 'release_request').length,
	};
}

export async function runLocalEndToEndVerification(
	options: RunLocalEndToEndVerificationOptions = {},
): Promise<LocalEndToEndVerificationSummary> {
	const now = options.now ?? new Date();
	const nowIso = isoDate(now);
	const projectId = options.projectId ?? 'treeseed-market';
	const teamId = options.teamId ?? 'team-local-e2e';
	const environment = options.environment ?? 'local';
	const repoRoot = options.repoRoot ?? mkdtempSync(join(tmpdir(), 'treeseed-agent-local-e2e-'));
	const workDay = {
		id: 'workday-local-e2e',
		projectId,
		state: 'active',
		startedAt: nowIso,
		updatedAt: nowIso,
		graphVersion: 'graph-local-e2e',
	};
	const sdk = new InMemoryE2eSdk(workDay, nowIso);

	const seeded = await seedResearchKnowledgeWorkdayTasks({
		sdk: sdk as never,
		workDay,
		projectId,
		graphVersion: 'graph-local-e2e',
		questions: TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS,
		actor: 'local-e2e',
	});

	for (;;) {
		const task = sdk.tasks.find((entry) => {
			const type = readString(entry, 'type');
			const state = readString(entry, 'state');
			return isResearchKnowledgeTaskKind(type)
				&& ['research_question', 'generate_knowledge_draft', 'optimize_knowledge_draft'].includes(type)
				&& type !== 'promote_knowledge_draft_request'
				&& state !== 'completed';
		});
		if (!task) break;
		const output = await executeResearchKnowledgeTask({
			sdk: sdk as never,
			task,
			taskKind: readString(task, 'type') as ResearchKnowledgeTaskKind,
			workerId: 'local-e2e-worker',
			queueAttempt: 1,
			enqueueFollowups: false,
		});
		sdk.completeTask(task, {
			workerId: 'local-e2e-worker',
			queueAttempt: 1,
			...output,
		});
	}

	let artifactState = await collectAgentArtifactApiState({
		sdk: sdk as never,
		projectId,
	});
	for (const approval of artifactState.approvals.filter((entry) => entry.approvalKind === 'promote_knowledge_draft')) {
		await recordAgentApprovalDecision({
			sdk: sdk as never,
			projectId,
			approvalId: approval.id,
			decision: 'approve_as_book_content',
			reason: 'Local E2E promotion approval.',
			actor: 'local-e2e-human',
			actorType: 'user',
			repoRoot,
			environment,
		});
	}

	const worktrees = new LocalE2eWorktrees(repoRoot, nowIso);
	for (;;) {
		const task = sdk.tasks.find((entry) => {
			const type = readString(entry, 'type');
			const state = readString(entry, 'state');
			return type === 'promote_knowledge_to_staging' && state !== 'completed';
		});
		if (!task) break;
		const output = await executeResearchKnowledgeTask({
			sdk: sdk as never,
			task,
			taskKind: 'promote_knowledge_to_staging',
			workerId: 'local-e2e-worker',
			queueAttempt: 1,
			enqueueFollowups: false,
			promotionDependencies: {
				worktrees: worktrees as never,
				verify: async () => ({
					ok: true,
					summary: 'Local E2E verification passed.',
					commandsRun: [],
					errors: [],
				}),
			},
		});
		sdk.completeTask(task, {
			workerId: 'local-e2e-worker',
			queueAttempt: 1,
			...output,
		});
	}

	artifactState = await collectAgentArtifactApiState({
		sdk: sdk as never,
		projectId,
	});
	const releaseOperations = {
		runOperation: async (input: {
			request: JsonRecord;
			sdk?: { appendTaskEvent?: (request: JsonRecord) => Promise<unknown> };
		}) => {
			const result = {
				operation: 'release',
				status: 'completed',
				summary: 'Mocked local E2E release completed.',
				changedPaths: Array.isArray(input.request.changedPaths) ? input.request.changedPaths : [],
				stagedPaths: [],
				commandsRun: ['release'],
				artifacts: [{ kind: 'release_tag', ref: 'v0.0.0-local-e2e' }],
				metadata: {
					mocked: true,
					releaseTag: 'v0.0.0-local-e2e',
				},
			};
			await input.sdk?.appendTaskEvent?.({
				taskId: String(input.request.taskId ?? ''),
				kind: 'operation_event',
				data: {
					operation: 'release',
					mode: 'mutating',
					agentRole: 'releaser',
					permissionGrantId: input.request.permissionGrantId ?? null,
					result,
					createdAt: nowIso,
				},
				actor: 'releaser-agent',
			});
			return result;
		},
	};
	for (const approval of artifactState.approvals.filter((entry) => entry.approvalKind === 'release_staged_knowledge')) {
		await recordAgentApprovalDecision({
			sdk: sdk as never,
			projectId,
			approvalId: approval.id,
			decision: 'approve_release',
			reason: 'Local E2E release approval.',
			actor: 'local-e2e-human',
			actorType: 'user',
			repoRoot,
			environment,
			operations: releaseOperations as never,
		});
	}

	const outputValues = sdk.taskOutputs.map((output) => parseJsonRecord(output.outputJson));
	const generatedArtifacts = extractGeneratedArtifactsFromTaskOutputs(outputValues);
	const operationState = await collectAgentOperationApiState({
		sdk: sdk as never,
		projectId,
	});
	const reportSnapshot = writeWorkdayContentSnapshot({
		repoRoot,
		projectId,
		teamId,
		environment,
		workDay,
		summary: {
			summary: 'Local end-to-end verification generated TreeSeed knowledge artifacts.',
			totalTasks: sdk.tasks.length,
			completedTasks: sdk.tasks.filter((task) => readString(task, 'state') === 'completed').length,
			failedTasks: 0,
			queuedTasks: 0,
			activeTasks: 0,
			dailyTaskCreditBudget: 100,
			usedTaskCredits: seeded.length,
			remainingTaskCredits: Math.max(0, 100 - seeded.length),
			creditLedgerEntries: seeded.length,
		},
		prioritySnapshot: null,
		scaleDecision: {
			id: 'scale-local-e2e',
			projectId,
			environment,
			poolName: 'local-e2e',
			workDayId: readString(workDay, 'id'),
			desiredWorkers: 0,
			observedQueueDepth: 0,
			observedActiveLeases: 0,
			reason: 'local_e2e_verification',
			metadata: {},
			createdAt: nowIso,
		},
		scaleResult: {
			applied: false,
			provider: 'noop',
			desiredWorkers: 0,
			metadata: {},
		},
		tasks: taskSummaries(sdk),
		changedFiles: [],
		generatedArtifacts,
		releases: [],
			operationEvents: operationState.events.map((entry) => ({ ...entry })),
		worktreeSnapshots: operationState.lifecycle.worktreeSnapshots,
		stagingMerges: operationState.lifecycle.stagingMerges,
		mergeFailures: operationState.lifecycle.mergeFailures,
		repairTasks: operationState.lifecycle.repairTasks,
			releaseApprovals: operationState.lifecycle.releaseApprovals.map((entry) => ({ ...entry })),
		releaseResults: operationState.lifecycle.releaseResults,
		codexUsage: operationState.lifecycle.codexUsage,
		generatedAt: nowIso,
	});
	const reportDocument = readFileSync(reportSnapshot.filePath, 'utf8');
	sdk.createReport({
		generatedArtifacts,
		operationEvents: operationState.events.map((entry) => ({ ...entry })),
		worktreeSnapshots: operationState.lifecycle.worktreeSnapshots,
		stagingMerges: operationState.lifecycle.stagingMerges,
		mergeFailures: operationState.lifecycle.mergeFailures,
		repairTasks: operationState.lifecycle.repairTasks,
		releaseApprovals: operationState.lifecycle.releaseApprovals.map((entry) => ({ ...entry })),
		releaseResults: operationState.lifecycle.releaseResults,
		codexUsage: operationState.lifecycle.codexUsage,
		releaseAttempted: operationState.lifecycle.releaseResults.length > 0,
		stagingAttempted: operationState.lifecycle.stagingMerges.length > 0,
		contentSnapshot: {
			relativePath: reportSnapshot.relativePath,
			slug: reportSnapshot.slug,
			reportVersion: reportSnapshot.reportVersion,
			title: reportSnapshot.title,
		},
	}, reportSnapshot.relativePath);
	const apiState = await collectAgentArtifactApiState({
		sdk: sdk as never,
		projectId,
	});
	const targetPaths = TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.map((question) => question.targetPath);
	const generatedTargetPaths = [...new Set(apiState.artifacts
		.map((artifact) => artifact.targetPath)
		.filter((targetPath): targetPath is string => typeof targetPath === 'string' && targetPath.length > 0))];
	const reportIncludesAllTargetPaths = targetPaths.every((targetPath) => reportDocument.includes(targetPath));
	const byKind = countBy(sdk.tasks.map((task) => readString(task, 'type')));
	const counts = artifactCounts(apiState.artifacts);
	const releaseApprovalCount = apiState.approvals.filter((approval) => approval.approvalKind === 'release_staged_knowledge').length;
	const stagedPathCount = new Set(operationState.lifecycle.stagingMerges.flatMap((merge) => Array.isArray(merge.changedPaths) ? merge.changedPaths.map(String) : [])).size;
	const releaseResultCount = operationState.lifecycle.releaseResults.length;
	const releaseAttempted = releaseResultCount > 0;
	const stagingAttempted = operationState.lifecycle.stagingMerges.length > 0;
	const codexReadiness = checkCodexProviderReadiness({
		env: {
			...process.env,
			TREESEED_EXECUTION_PROVIDER: '',
			TREESEED_AGENT_EXECUTION_PROVIDER: '',
		},
	});

	return {
		ok: seeded.length === TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length
			&& counts.research_note >= TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length
			&& counts.knowledge_draft >= TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length
			&& counts.optimization_report >= TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length
			&& counts.promotion_request >= TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length
			&& counts.release_request >= TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length
			&& stagedPathCount >= TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length
			&& releaseApprovalCount >= TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length
			&& releaseResultCount >= TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length
			&& apiState.currentWorkday !== null
			&& apiState.reports.length > 0
			&& reportIncludesAllTargetPaths,
		repoRoot,
		projectId,
		workDayId: readString(workDay, 'id'),
		seededTaskCount: seeded.length,
		taskCounts: {
			total: sdk.tasks.length,
			completed: sdk.tasks.filter((task) => readString(task, 'state') === 'completed').length,
			waiting: sdk.tasks.filter((task) => readString(task, 'state') === 'waiting').length,
			byKind,
		},
		artifactCounts: counts,
		approvalCount: apiState.approvals.length,
		releaseApprovalCount,
		stagedPathCount,
		releaseResultCount,
		generatedTargetPaths,
		report: {
			relativePath: reportSnapshot.relativePath,
			includesGeneratedArtifactsSection: reportDocument.includes('## Generated Artifacts'),
			includesAllTargetPaths: reportIncludesAllTargetPaths,
			includesOperationSections: [
				'## Operation Events',
				'## Worktree Snapshots',
				'## Staging And Release',
				'## Repair Tasks',
			].every((section) => reportDocument.includes(section)),
			includesReleaseResults: reportDocument.includes('Release results:') && reportDocument.includes('Mocked local E2E release completed.'),
		},
		api: {
			artifactCount: apiState.artifacts.length,
			researchNoteCount: apiState.researchNotes.length,
			knowledgeDraftCount: apiState.knowledgeDrafts.length,
			optimizationReportCount: apiState.optimizationReports.length,
			approvalCount: apiState.approvals.length,
			releaseApprovalCount,
			operationEventCount: operationState.events.length,
			releaseResultCount,
			reportCount: apiState.reports.length,
			currentWorkdayReported: apiState.currentWorkday !== null,
			warnings: [...apiState.warnings, ...operationState.warnings],
		},
		codexReadiness,
		releaseAttempted,
		stagingAttempted,
	};
}
