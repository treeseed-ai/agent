import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type {
	PrioritySnapshot,
	ScaleDecision,
	WorkerPoolScaleResult,
} from '@treeseed/sdk';
import { stringify as stringifyYaml } from 'yaml';
import type { GeneratedAgentArtifactSummary } from './research-knowledge-workday.ts';

type JsonRecord = Record<string, unknown>;

export interface WorkdayContentTaskSummary {
	id: string;
	agentId?: string;
	type?: string;
	state?: string;
	priority?: number;
	idempotencyKey?: string;
	createdAt?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
	lastErrorCode?: string | null;
	lastErrorMessage?: string | null;
	lastEventKind?: string | null;
	outputCount?: number;
	changedFiles?: string[];
	generatedArtifacts?: GeneratedAgentArtifactSummary[];
}

export interface WorkdayContentReleaseRecord {
	id?: string;
	deploymentKind: string;
	status: string;
	releaseTag?: string | null;
	commitSha?: string | null;
	sourceRef?: string | null;
	startedAt?: string | null;
	finishedAt?: string | null;
	createdAt?: string | null;
}

export interface WorkdayContentSnapshotInput {
	repoRoot: string;
	projectId: string;
	teamId: string;
	environment: string;
	workDay: JsonRecord;
	summary: JsonRecord;
	prioritySnapshot: PrioritySnapshot | null;
	scaleDecision: ScaleDecision;
	scaleResult: WorkerPoolScaleResult;
	tasks: WorkdayContentTaskSummary[];
	changedFiles: string[];
	generatedArtifacts: GeneratedAgentArtifactSummary[];
	releases: WorkdayContentReleaseRecord[];
	operationEvents?: JsonRecord[];
	worktreeSnapshots?: JsonRecord[];
	stagingMerges?: JsonRecord[];
	mergeFailures?: JsonRecord[];
	repairTasks?: JsonRecord[];
	releaseApprovals?: JsonRecord[];
	releaseResults?: JsonRecord[];
	codexUsage?: JsonRecord[];
	generatedAt: string;
}

export interface WorkdayContentSnapshotResult {
	filePath: string;
	relativePath: string;
	slug: string;
	reportVersion: string;
	title: string;
	status: 'completed' | 'partial' | 'failed';
	docsAutomation: DocsAutomationWorkdaySummary;
}

export interface DocsAutomationWorkdaySummary {
	researchNoteCount: number;
	knowledgeDraftCount: number;
	optimizationReportCount: number;
	promotionRequestCount: number;
	pendingApprovalCount: number;
	docsMutationCount: number;
	verificationFailureCount: number;
	repairTaskCount: number;
	releaseApprovalCount: number;
	changedPathCount: number;
	sourceMapRefCount: number;
}

function stableHash(value: string) {
	return createHash('sha256').update(value).digest('hex');
}

function sanitizeSegment(value: string, fallback: string) {
	const normalized = value
		.trim()
		.replaceAll(/[\\/]+/g, '-')
		.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
		.replaceAll(/-+/g, '-')
		.replaceAll(/^-|-$/g, '');
	return normalized || fallback;
}

function compactTimestamp(value: string) {
	return value.replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/u, 'Z');
}

function toIsoDate(value: unknown) {
	if (typeof value !== 'string' || !value.trim()) {
		return null;
	}
	const parsed = new Date(value);
	return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function bodySummary(summary: JsonRecord) {
	return typeof summary.summary === 'string' && summary.summary.trim()
		? summary.summary.trim()
		: `Completed ${Number(summary.completedTasks ?? 0)} tasks, with ${Number(summary.failedTasks ?? 0)} failures and ${Number(summary.remainingTaskCredits ?? 0)} remaining task credits.`;
}

function readStringArray(value: unknown) {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function artifactKind(artifact: GeneratedAgentArtifactSummary) {
	return String(artifact.artifactKind ?? '');
}

function sourceMapRefCountFromValue(value: unknown): number {
	if (!value || typeof value !== 'object') return 0;
	const record = value as JsonRecord;
	const refs = [
		record.sourceMapRefs,
		record.source_map,
		record.sourceMap,
	];
	return refs.reduce<number>((total, candidate) => total + (Array.isArray(candidate) ? candidate.length : 0), 0);
}

export function summarizeDocsAutomationWorkday(input: Pick<WorkdayContentSnapshotInput,
	'summary'
	| 'tasks'
	| 'changedFiles'
	| 'generatedArtifacts'
	| 'stagingMerges'
	| 'mergeFailures'
	| 'repairTasks'
	| 'releaseApprovals'
>) {
	const artifacts = input.generatedArtifacts;
	const docsMutations = artifacts.filter((artifact) => artifactKind(artifact) === 'docs_mutation_result');
	const promotionRequests = artifacts.filter((artifact) => artifactKind(artifact) === 'promotion_request');
	const releaseApprovals = input.releaseApprovals ?? [];
	const repairTasks = input.repairTasks ?? [];
	const mergeFailures = input.mergeFailures ?? [];
	const verificationFailures = docsMutations.filter((artifact) =>
		String(artifact.verificationStatus ?? '').toLowerCase() === 'failed'
	).length + mergeFailures.length + repairTasks.length;
	const pendingApprovalCount = promotionRequests.length + releaseApprovals.filter((approval) =>
		['pending', 'waiting_for_approval', 'human_approval_pending'].includes(String(approval.state ?? 'pending'))
	).length;
	return {
		researchNoteCount: artifacts.filter((artifact) => artifactKind(artifact) === 'research_note').length,
		knowledgeDraftCount: artifacts.filter((artifact) => artifactKind(artifact) === 'knowledge_draft').length,
		optimizationReportCount: artifacts.filter((artifact) => artifactKind(artifact) === 'optimization_report').length,
		promotionRequestCount: promotionRequests.length,
		pendingApprovalCount,
		docsMutationCount: docsMutations.length,
		verificationFailureCount: verificationFailures,
		repairTaskCount: repairTasks.length,
		releaseApprovalCount: releaseApprovals.length,
		changedPathCount: input.changedFiles.length,
		sourceMapRefCount: artifacts.reduce((total, artifact) => total + sourceMapRefCountFromValue(artifact), 0),
	} satisfies DocsAutomationWorkdaySummary;
}

function reportStatus(input: WorkdayContentSnapshotInput, docsAutomation: DocsAutomationWorkdaySummary): 'completed' | 'partial' | 'failed' {
	if (Number(input.summary.failedTasks ?? 0) > 0 || docsAutomation.verificationFailureCount > 0) return 'failed';
	if (Number(input.summary.queuedTasks ?? 0) > 0 || Number(input.summary.activeTasks ?? 0) > 0 || docsAutomation.pendingApprovalCount > 0) return 'partial';
	return 'completed';
}

function renderTasks(tasks: WorkdayContentTaskSummary[]) {
	if (tasks.length === 0) {
		return '- No tasks were recorded.\n';
	}
	return tasks.map((task) => {
		const suffix = [
			task.state ? `state: ${task.state}` : null,
			task.agentId ? `agent: ${task.agentId}` : null,
			Number.isFinite(task.priority) ? `priority: ${task.priority}` : null,
			task.lastEventKind ? `last event: ${task.lastEventKind}` : null,
			task.outputCount ? `outputs: ${task.outputCount}` : null,
		].filter(Boolean).join(', ');
		return `- \`${task.id}\` ${task.type ?? 'task'}${suffix ? ` (${suffix})` : ''}`;
	}).join('\n') + '\n';
}

function renderChangedFiles(changedFiles: string[]) {
	if (changedFiles.length === 0) {
		return '- No changed files were reported by task outputs.\n';
	}
	return changedFiles.map((filePath) => `- \`${filePath}\``).join('\n') + '\n';
}

function renderGeneratedArtifacts(artifacts: GeneratedAgentArtifactSummary[]) {
	if (artifacts.length === 0) {
		return '- No generated research or knowledge artifacts were recorded.\n';
	}
	return artifacts.map((artifact) => {
		const label = artifact.title || artifact.id;
		const details = [
			artifact.artifactKind,
			artifact.targetPath,
			artifact.recommendation ? `recommendation: ${artifact.recommendation}` : null,
			Number.isFinite(artifact.totalScore) ? `score: ${artifact.totalScore}` : null,
		].filter(Boolean).join(', ');
		return `- \`${label}\`${details ? ` (${details})` : ''}`;
	}).join('\n') + '\n';
}

function renderArtifactsByKind(artifacts: GeneratedAgentArtifactSummary[], kinds: string[], empty: string) {
	const filtered = artifacts.filter((artifact) => kinds.includes(artifactKind(artifact)));
	if (filtered.length === 0) {
		return `- ${empty}\n`;
	}
	return filtered.map((artifact) => {
		const label = artifact.title || artifact.id;
		const paths = [
			artifact.targetPath,
			...(readStringArray(artifact.changedPaths)),
		].filter(Boolean).join(', ');
		const details = [
			artifact.artifactKind,
			paths ? `paths: ${paths}` : null,
			artifact.recommendation ? `recommendation: ${artifact.recommendation}` : null,
			Number.isFinite(artifact.totalScore) ? `score: ${artifact.totalScore}` : null,
			artifact.verificationStatus ? `verification: ${artifact.verificationStatus}` : null,
			artifact.repairTaskId ? `repair: ${artifact.repairTaskId}` : null,
		].filter(Boolean).join(', ');
		return `- \`${label}\`${details ? ` (${details})` : ''}`;
	}).join('\n') + '\n';
}

function renderApprovalArtifacts(input: WorkdayContentSnapshotInput) {
	const approvalArtifacts = input.generatedArtifacts.filter((artifact) => ['promotion_request', 'release_request'].includes(artifactKind(artifact)));
	const lifecycleApprovals = input.releaseApprovals ?? [];
	if (approvalArtifacts.length === 0 && lifecycleApprovals.length === 0) {
		return '- No governance approval requests or decisions were recorded.\n';
	}
	const artifactRows = approvalArtifacts.map((artifact) => {
		const details = [
			artifact.approvalKind,
			artifact.targetPath,
			artifact.recommendation ? `recommendation: ${artifact.recommendation}` : null,
			artifact.taskId ? `task: ${artifact.taskId}` : null,
		].filter(Boolean).join(', ');
		return `- \`${artifact.id}\`${details ? ` (${details})` : ''}`;
	});
	const lifecycleRows = lifecycleApprovals.map((approval) => {
		const label = String(approval.id ?? approval.approvalId ?? 'approval');
		const details = [
			approval.decision ? `decision: ${approval.decision}` : null,
			approval.taskId ? `task: ${approval.taskId}` : null,
			approval.workDayId ? `workday: ${approval.workDayId}` : null,
		].filter(Boolean).join(', ');
		return `- \`${label}\`${details ? ` (${details})` : ''}`;
	});
	return [...artifactRows, ...lifecycleRows].join('\n') + '\n';
}

function renderOpenQuestions(input: WorkdayContentSnapshotInput) {
	const repairRows = (input.repairTasks ?? []).map((task) => {
		const label = String(task.kind ?? task.id ?? 'repair_task');
		const target = typeof task.targetPath === 'string' ? ` for \`${task.targetPath}\`` : '';
		return `- Repair task \`${label}\`${target} needs follow-up.`;
	});
	const pendingApprovalRows = input.generatedArtifacts
		.filter((artifact) => artifactKind(artifact) === 'promotion_request')
		.map((artifact) => `- Promotion request \`${artifact.id}\` is waiting for a governance decision.`);
	const draftRows = input.generatedArtifacts
		.filter((artifact) => artifactKind(artifact) === 'knowledge_draft')
		.map((artifact) => `- Draft \`${artifact.title || artifact.id}\` should remain traceable to its source map during review.`);
	const rows = [...repairRows, ...pendingApprovalRows, ...draftRows];
	return rows.length ? `${rows.join('\n')}\n` : '- No open documentation questions were recorded.\n';
}

function renderNextRecommendations(input: WorkdayContentSnapshotInput) {
	const recommendations: string[] = [];
	if ((input.repairTasks ?? []).length > 0) recommendations.push('Resolve repair tasks before attempting release.');
	if (input.generatedArtifacts.some((artifact) => artifactKind(artifact) === 'promotion_request')) recommendations.push('Review pending promotion requests in the Market Project Agents view.');
	if (input.generatedArtifacts.some((artifact) => artifactKind(artifact) === 'research_note')) recommendations.push('Use source-mapped research notes to generate or improve canonical knowledge drafts.');
	if (input.generatedArtifacts.some((artifact) => artifactKind(artifact) === 'docs_mutation_result')) recommendations.push('Inspect mutation verification and changed paths before release approval.');
	return recommendations.length
		? recommendations.map((recommendation) => `- ${recommendation}`).join('\n') + '\n'
		: '- Continue the next documentation automation workday from the current backlog.\n';
}

function renderReleases(releases: WorkdayContentReleaseRecord[]) {
	if (releases.length === 0) {
		return '- No releases or deployments were recorded during this workday.\n';
	}
	return releases.map((release) => {
		const label = release.releaseTag || release.commitSha || release.id || release.deploymentKind;
		const details = [release.deploymentKind, release.status, release.sourceRef].filter(Boolean).join(', ');
		return `- \`${label}\`${details ? ` (${details})` : ''}`;
	}).join('\n') + '\n';
}

function renderPriorityItems(snapshot: PrioritySnapshot | null) {
	if (!snapshot?.items?.length) {
		return '- No priority snapshot items were captured.\n';
	}
	return snapshot.items.map((item) => {
		const details = [
			item.model,
			Number.isFinite(item.priority) ? `priority: ${item.priority}` : null,
			Number.isFinite(item.estimatedCredits) ? `credits: ${item.estimatedCredits}` : null,
		].filter(Boolean).join(', ');
		return `- \`${item.id}\`${item.title ? ` ${item.title}` : ''}${details ? ` (${details})` : ''}`;
	}).join('\n') + '\n';
}

function renderOperationEvents(events: JsonRecord[]) {
	if (events.length === 0) {
		return '- No operation events were recorded.\n';
	}
	return events.map((event) => {
		const details = [
			event.status ? `status: ${event.status}` : null,
			event.agentRole ? `role: ${event.agentRole}` : null,
			event.taskId ? `task: ${event.taskId}` : null,
		].filter(Boolean).join(', ');
		return `- \`${String(event.operation ?? 'operation')}\`${details ? ` (${details})` : ''}`;
	}).join('\n') + '\n';
}

function renderSnapshots(snapshots: JsonRecord[]) {
	if (snapshots.length === 0) {
		return '- No worktree snapshots were recorded.\n';
	}
	return snapshots.map((snapshot) => {
		const label = String(snapshot.summary ?? snapshot.kind ?? snapshot.ref ?? 'snapshot');
		const changed = Array.isArray(snapshot.changedPaths) ? snapshot.changedPaths.length : 0;
		return `- \`${label}\` (${changed} changed path(s)${snapshot.taskId ? `, task: ${snapshot.taskId}` : ''})`;
	}).join('\n') + '\n';
}

function renderStagingAndRelease(input: WorkdayContentSnapshotInput) {
	const rows = [
		`- Staging merges: ${input.stagingMerges?.length ?? 0}`,
		`- Merge failures: ${input.mergeFailures?.length ?? 0}`,
		`- Release approvals: ${input.releaseApprovals?.length ?? 0}`,
		`- Release results: ${input.releaseResults?.length ?? 0}`,
		`- Codex usage records: ${input.codexUsage?.length ?? 0}`,
	];
	return `${rows.join('\n')}\n`;
}

function renderRepairTasks(repairTasks: JsonRecord[]) {
	if (repairTasks.length === 0) {
		return '- No repair tasks were created.\n';
	}
	return repairTasks.map((task) => {
		const label = String(task.kind ?? task.id ?? 'repair_task');
		const target = typeof task.targetPath === 'string' ? ` (${task.targetPath})` : '';
		return `- \`${label}\`${target}`;
	}).join('\n') + '\n';
}

function buildMarkdownBody(input: WorkdayContentSnapshotInput, docsAutomation: DocsAutomationWorkdaySummary) {
	const summaryText = bodySummary(input.summary);
	return [
		'# Summary',
		'',
		summaryText,
		'',
		'## What agents analyzed',
		'',
		renderArtifactsByKind(input.generatedArtifacts, ['codebase_inventory', 'research_note'], 'No codebase inventory or research notes were recorded.').trimEnd(),
		'',
		'## Knowledge created',
		'',
		renderArtifactsByKind(input.generatedArtifacts, ['research_note', 'knowledge_draft', 'optimization_report'], 'No generated knowledge artifacts were recorded.').trimEnd(),
		'',
		'## Drafts pending review',
		'',
		renderArtifactsByKind(input.generatedArtifacts, ['knowledge_draft', 'promotion_request'], 'No drafts or promotion requests are pending review.').trimEnd(),
		'',
		'## Approved changes',
		'',
		renderArtifactsByKind(input.generatedArtifacts, ['docs_mutation_result', 'release_request'], 'No approved documentation mutations or release requests were recorded.').trimEnd(),
		'',
		'## Verification outcomes',
		'',
		`- Docs mutations: ${docsAutomation.docsMutationCount}`,
		`- Verification failures: ${docsAutomation.verificationFailureCount}`,
		`- Repair tasks: ${docsAutomation.repairTaskCount}`,
		`- Changed paths: ${input.changedFiles.length}`,
		'',
		renderStagingAndRelease(input).trimEnd(),
		'',
		'## Governance decisions',
		'',
		renderApprovalArtifacts(input).trimEnd(),
		'',
		'## Open questions',
		'',
		renderOpenQuestions(input).trimEnd(),
		'',
		'## Next workday recommendations',
		'',
		renderNextRecommendations(input).trimEnd(),
		'',
		'## Budget',
		'',
		`- Daily task-credit budget: ${Number(input.summary.dailyTaskCreditBudget ?? 0)}`,
		`- Used task credits: ${Number(input.summary.usedTaskCredits ?? 0)}`,
		`- Remaining task credits: ${Number(input.summary.remainingTaskCredits ?? 0)}`,
		`- Credit ledger entries: ${Number(input.summary.creditLedgerEntries ?? 0)}`,
		'',
		'## Priority Plan',
		'',
		renderPriorityItems(input.prioritySnapshot).trimEnd(),
		'',
		'## Tasks',
		'',
		renderTasks(input.tasks).trimEnd(),
		'',
		'## Changed Files',
		'',
		renderChangedFiles(input.changedFiles).trimEnd(),
		'',
		'## Generated Artifacts',
		'',
		renderGeneratedArtifacts(input.generatedArtifacts).trimEnd(),
		'',
		'## Operation Events',
		'',
		renderOperationEvents(input.operationEvents ?? []).trimEnd(),
		'',
		'## Worktree Snapshots',
		'',
		renderSnapshots(input.worktreeSnapshots ?? []).trimEnd(),
		'',
		'## Staging And Release',
		'',
		renderStagingAndRelease(input).trimEnd(),
		'',
		'## Repair Tasks',
		'',
		renderRepairTasks(input.repairTasks ?? []).trimEnd(),
		'',
		'## Releases',
		'',
		renderReleases(input.releases).trimEnd(),
		'',
		'## Final Status',
		'',
		`- Workday state: ${String(input.workDay.state ?? 'completed')}`,
		`- Desired workers: ${Number(input.scaleDecision.desiredWorkers ?? 0)}`,
		`- Queue depth at report: ${Number(input.scaleDecision.observedQueueDepth ?? 0)}`,
		`- Active leases at report: ${Number(input.scaleDecision.observedActiveLeases ?? 0)}`,
		`- Scale provider: ${input.scaleResult.provider}`,
		'',
	].join('\n');
}

export function writeWorkdayContentSnapshot(input: WorkdayContentSnapshotInput): WorkdayContentSnapshotResult {
	const outputRoot = resolve(input.repoRoot, 'src/content/workdays');
	mkdirSync(outputRoot, { recursive: true });

	const workDayId = String(input.workDay.id ?? 'workday');
	const startedAt = toIsoDate(input.workDay.startedAt ?? input.workDay.started_at) ?? input.generatedAt;
	const endedAt = toIsoDate(input.workDay.endedAt ?? input.workDay.ended_at);
	const generatedAt = toIsoDate(input.generatedAt) ?? new Date().toISOString();
	const docsAutomation = summarizeDocsAutomationWorkday(input);
	const status = reportStatus(input, docsAutomation);
	const datePart = (startedAt || generatedAt).slice(0, 10);
	const slugBase = `${datePart}/${sanitizeSegment(workDayId, 'workday')}`;
	const identityHash = stableHash(JSON.stringify({
		workDayId,
		generatedAt,
		summary: input.summary,
		changedFiles: input.changedFiles,
		generatedArtifacts: input.generatedArtifacts,
		releases: input.releases,
		operationEvents: input.operationEvents ?? [],
		worktreeSnapshots: input.worktreeSnapshots ?? [],
		stagingMerges: input.stagingMerges ?? [],
		mergeFailures: input.mergeFailures ?? [],
		repairTasks: input.repairTasks ?? [],
		releaseApprovals: input.releaseApprovals ?? [],
		releaseResults: input.releaseResults ?? [],
		codexUsage: input.codexUsage ?? [],
	})).slice(0, 8);
	const reportVersion = `${compactTimestamp(generatedAt)}-${identityHash}`;
	const title = `TreeSeed Documentation Automation Workday - ${generatedAt.slice(0, 10)}`;
	const slug = `workdays/${slugBase}/${reportVersion}`;
	const frontmatter = {
		id: `workday:${workDayId}`,
		title,
		slug,
		work_day_id: workDayId,
		generated_by: 'treeseed-agent',
		updated: generatedAt.slice(0, 10),
		workDayId,
		reportVersion,
		reportKind: 'workday_summary',
		projectId: input.projectId,
		teamId: input.teamId,
		environment: input.environment,
		status,
		visibility: 'team',
		workdayState: String(input.workDay.state ?? 'completed'),
		startedAt,
		endedAt,
		generatedAt,
		createdAt: generatedAt,
		summary: bodySummary(input.summary),
		dailyTaskCreditBudget: Number(input.summary.dailyTaskCreditBudget ?? 0),
		usedTaskCredits: Number(input.summary.usedTaskCredits ?? 0),
		remainingTaskCredits: Number(input.summary.remainingTaskCredits ?? 0),
		creditLedgerEntries: Number(input.summary.creditLedgerEntries ?? 0),
		prioritySnapshotId: input.prioritySnapshot?.id ?? null,
		priorityItemCount: input.prioritySnapshot?.items.length ?? 0,
		priorityItems: input.prioritySnapshot?.items ?? [],
		totalTasks: Number(input.summary.totalTasks ?? input.tasks.length),
		completedTasks: Number(input.summary.completedTasks ?? 0),
		failedTasks: Number(input.summary.failedTasks ?? 0),
		queuedTasks: Number(input.summary.queuedTasks ?? 0),
		activeTasks: Number(input.summary.activeTasks ?? 0),
		taskItems: input.tasks,
		changedFiles: input.changedFiles,
		generatedArtifacts: input.generatedArtifacts,
		releases: input.releases,
		operationEvents: input.operationEvents ?? [],
		worktreeSnapshots: input.worktreeSnapshots ?? [],
		stagingMerges: input.stagingMerges ?? [],
		mergeFailures: input.mergeFailures ?? [],
		repairTasks: input.repairTasks ?? [],
		releaseApprovals: input.releaseApprovals ?? [],
		releaseResults: input.releaseResults ?? [],
		codexUsage: input.codexUsage ?? [],
		docsAutomation,
		linkedTasks: input.tasks.map((task) => ({
			id: task.id,
			type: task.type,
			state: task.state,
			generatedArtifacts: task.generatedArtifacts?.map((artifact) => artifact.id) ?? [],
		})),
		linkedArtifacts: input.generatedArtifacts.map((artifact) => ({
			id: artifact.id,
			kind: artifact.artifactKind,
			taskId: artifact.taskId ?? null,
			targetPath: artifact.targetPath ?? null,
		})),
		linkedApprovals: [
			...input.generatedArtifacts
				.filter((artifact) => ['promotion_request', 'release_request'].includes(artifactKind(artifact)))
				.map((artifact) => ({ id: artifact.id, kind: artifact.approvalKind ?? artifact.artifactKind, taskId: artifact.taskId ?? null })),
			...(input.releaseApprovals ?? []).map((approval) => ({
				id: String(approval.id ?? approval.approvalId ?? 'approval'),
				kind: String(approval.approvalKind ?? 'release_staged_knowledge'),
				taskId: typeof approval.taskId === 'string' ? approval.taskId : null,
			})),
		],
		linkedMutations: input.generatedArtifacts
			.filter((artifact) => artifactKind(artifact) === 'docs_mutation_result')
			.map((artifact) => ({
				id: artifact.id,
				taskId: artifact.taskId ?? null,
				targetPath: artifact.targetPath ?? null,
				changedPaths: artifact.changedPaths ?? [],
				verificationStatus: artifact.verificationStatus ?? null,
				repairTaskId: artifact.repairTaskId ?? null,
			})),
		scaleDecision: input.scaleDecision,
		scaleResult: input.scaleResult,
		metadata: {
			source: 'manager',
			projectId: input.projectId,
		},
	};
	const markdownBody = buildMarkdownBody(input, docsAutomation);

	let fileName = `${datePart}-${sanitizeSegment(workDayId, 'workday')}--${reportVersion}.mdx`;
	let filePath = resolve(outputRoot, fileName);
	let duplicateCounter = 1;
	while (existsSync(filePath)) {
		fileName = `${datePart}-${sanitizeSegment(workDayId, 'workday')}--${reportVersion}-${duplicateCounter}.mdx`;
		filePath = resolve(outputRoot, fileName);
		duplicateCounter += 1;
	}

	const document = `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${markdownBody}`;
	writeFileSync(filePath, document, 'utf8');

	return {
		filePath,
		relativePath: relative(input.repoRoot, filePath).replaceAll('\\', '/'),
		slug,
		reportVersion,
		title,
		status,
		docsAutomation,
	};
}
