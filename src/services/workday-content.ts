import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type {
	PrioritySnapshot,
	ScaleDecision,
	WorkerPoolScaleResult,
} from '@treeseed/sdk';
import { stringify as stringifyYaml } from 'yaml';

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
	releases: WorkdayContentReleaseRecord[];
	generatedAt: string;
}

export interface WorkdayContentSnapshotResult {
	filePath: string;
	relativePath: string;
	slug: string;
	reportVersion: string;
	title: string;
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

function buildMarkdownBody(input: WorkdayContentSnapshotInput) {
	const summaryText = bodySummary(input.summary);
	return [
		summaryText,
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
	const datePart = (startedAt || generatedAt).slice(0, 10);
	const slugBase = `${datePart}/${sanitizeSegment(workDayId, 'workday')}`;
	const identityHash = stableHash(JSON.stringify({
		workDayId,
		generatedAt,
		summary: input.summary,
		changedFiles: input.changedFiles,
		releases: input.releases,
	})).slice(0, 8);
	const reportVersion = `${compactTimestamp(generatedAt)}-${identityHash}`;
	const title = `Workday ${workDayId} Report ${generatedAt.slice(0, 10)}`;
	const slug = `workdays/${slugBase}/${reportVersion}`;
	const frontmatter = {
		title,
		slug,
		workDayId,
		reportVersion,
		reportKind: 'workday_summary',
		projectId: input.projectId,
		teamId: input.teamId,
		environment: input.environment,
		status: 'live',
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
		releases: input.releases,
		scaleDecision: input.scaleDecision,
		scaleResult: input.scaleResult,
		metadata: {
			source: 'manager',
			projectId: input.projectId,
		},
	};
	const markdownBody = buildMarkdownBody(input);

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
	};
}
