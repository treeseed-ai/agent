import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const TREESEED_WORKDAY_TEST_PROJECT_SLUGS = ['market', 'admin', 'agent', 'api', 'cli', 'core', 'sdk', 'ui', 'treedx'] as const;
export const TREESEED_WORKDAY_TEST_AGENT_COUNT = 9;

const SECRET_KEY = /(?:api[_-]?key|token|secret|password|credential|authorization|cookie)/iu;
const DEFAULT_WORKDAY_TEST_AGENT_CYCLES = 6;

export interface WorkdayTestScenarioParameters {
	projects?: string[] | string | null;
	workdays?: number | string | null;
	durationSeconds?: number | string | null;
	maxAssignments?: number | string | null;
	planningOnly?: boolean;
	planOnly?: boolean;
	scenarioId?: string | null;
	providerId?: string | null;
	reportDir?: string | null;
}

export interface WorkdayTestProjectActual {
	projectId?: string | null;
	slug: string;
	workdayId?: string | null;
	agentCount?: number | null;
	planningRuns?: number | null;
	actingRuns?: number | null;
	assignments?: number | null;
	outputs?: number | null;
	status?: string | null;
	blockers?: string[];
}

export interface WorkdayTestActual {
	projects: WorkdayTestProjectActual[];
	providerReady?: boolean;
	auditEvents?: number;
	reportRefs?: Record<string, unknown>;
}

export function normalizeWorkdayTestParameters(input: WorkdayTestScenarioParameters = {}) {
	const projects = normalizeProjects(input.projects);
	const workdays = positiveInteger(input.workdays, 1);
	const durationSeconds = positiveInteger(input.durationSeconds, 900);
	const maxAssignments = positiveInteger(input.maxAssignments, projects.length * TREESEED_WORKDAY_TEST_AGENT_COUNT * DEFAULT_WORKDAY_TEST_AGENT_CYCLES);
	return {
		scenarioId: input.scenarioId || 'portfolio-local',
		providerId: input.providerId || 'local',
		projects,
		workdays,
		durationSeconds,
		maxAssignments,
		planningOnly: input.planningOnly === true,
		planOnly: input.planOnly === true,
		reportDir: input.reportDir || '.treeseed/test-reports',
	};
}

function normalizeProjects(value: WorkdayTestScenarioParameters['projects']) {
	if (!value || value === 'all') return [...TREESEED_WORKDAY_TEST_PROJECT_SLUGS];
	const entries = Array.isArray(value) ? value : String(value).split(',');
	const normalized = entries.map((entry) => String(entry).trim()).filter(Boolean);
	return normalized.length ? [...new Set(normalized)] : [...TREESEED_WORKDAY_TEST_PROJECT_SLUGS];
}

function positiveInteger(value: unknown, fallback: number) {
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

export function redactWorkdayTestValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactWorkdayTestValue);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
		key,
		SECRET_KEY.test(key) ? '<redacted>' : redactWorkdayTestValue(item),
	]));
}

export function scoreWorkdayTest(input: {
	expectedProjects: string[];
	actual: WorkdayTestActual;
	planningOnly?: boolean;
}) {
	const projects = input.actual.projects ?? [];
	const bySlug = new Map(projects.map((project) => [project.slug, project]));
	const expected = input.expectedProjects;
	const exercised = expected.filter((slug) => bySlug.has(slug));
	const agentReady = expected.filter((slug) => Number(bySlug.get(slug)?.agentCount ?? 0) >= TREESEED_WORKDAY_TEST_AGENT_COUNT);
	const expectedPlanningRunsForProject = (project: WorkdayTestActualProject | undefined) => Math.min(
		TREESEED_WORKDAY_TEST_AGENT_COUNT,
		Number(project?.agentCount ?? TREESEED_WORKDAY_TEST_AGENT_COUNT),
		Math.max(1, Number(project?.assignments ?? TREESEED_WORKDAY_TEST_AGENT_COUNT)),
	);
	const planningReady = expected.filter((slug) => {
		const project = bySlug.get(slug);
		return Number(project?.planningRuns ?? 0) >= expectedPlanningRunsForProject(project);
	});
	const actingReady = input.planningOnly ? expected : expected.filter((slug) => Number(bySlug.get(slug)?.actingRuns ?? 0) > 0 || Number(bySlug.get(slug)?.outputs ?? 0) > 0);
	const blockers = projects.flatMap((project) => (project.blockers ?? []).map((blocker) => `${project.slug}: ${blocker}`));
	if (input.actual.providerReady !== true) blockers.push('local provider readiness was not proven');
	if (Number(input.actual.auditEvents ?? 0) <= 0) blockers.push('audit event trail is empty');
	const checks = [
		ratio('projectCoverage', exercised.length, expected.length),
		ratio('agentCoverage', agentReady.length, expected.length),
		ratio('planningCoverage', planningReady.length, expected.length),
		ratio('actingCoverage', actingReady.length, expected.length),
		ratio('auditCompleteness', Number(input.actual.auditEvents ?? 0) > 0 ? 1 : 0, 1),
		ratio('providerHealth', input.actual.providerReady === true ? 1 : 0, 1),
	];
	const score = Math.round(checks.reduce((sum, check) => sum + check.score, 0) / checks.length);
	return {
		score,
		status: blockers.length === 0 && score >= 90 ? 'completed' : score >= 60 ? 'degraded' : 'failed',
		checks,
		blockers,
	};
}

function ratio(name: string, actual: number, expected: number) {
	const safeExpected = Math.max(1, expected);
	return {
		name,
		actual,
		expected: safeExpected,
		score: Math.round(Math.max(0, Math.min(1, actual / safeExpected)) * 100),
	};
}

export function renderWorkdayTestMarkdown(input: {
	runId: string;
	parameters: ReturnType<typeof normalizeWorkdayTestParameters>;
	metrics: ReturnType<typeof scoreWorkdayTest>;
	actual: WorkdayTestActual;
}) {
	const lines = [
		`# Workday Test ${input.runId}`,
		'',
		`Status: ${input.metrics.status}`,
		`Score: ${input.metrics.score}`,
		`Scenario: ${input.parameters.scenarioId}`,
		`Provider: ${input.parameters.providerId}`,
		'',
		'## Coverage',
		'',
		...input.metrics.checks.map((check) => `- ${check.name}: ${check.actual}/${check.expected} (${check.score})`),
		'',
		'## Projects',
		'',
		...input.actual.projects.map((project) => `- ${project.slug}: ${project.status ?? 'unknown'}; agents=${project.agentCount ?? 0}; planning=${project.planningRuns ?? 0}; acting=${project.actingRuns ?? 0}; assignments=${project.assignments ?? 0}`),
		'',
		'## Blockers',
		'',
		...(input.metrics.blockers.length ? input.metrics.blockers.map((blocker) => `- ${blocker}`) : ['- none']),
		'',
		'## Audit',
		'',
		`Audit events: ${input.actual.auditEvents ?? 0}`,
	];
	return `${lines.join('\n')}\n`;
}

export async function writeWorkdayTestReports(input: {
	runId: string;
	reportDir: string;
	parameters: ReturnType<typeof normalizeWorkdayTestParameters>;
	metrics: ReturnType<typeof scoreWorkdayTest>;
	actual: WorkdayTestActual;
	expected: Record<string, unknown>;
}) {
	const jsonPath = resolve(input.reportDir, `workday-test-${input.runId}.json`);
	const markdownPath = resolve(input.reportDir, `workday-test-${input.runId}.md`);
	await mkdir(dirname(jsonPath), { recursive: true });
	await writeFile(jsonPath, `${JSON.stringify(redactWorkdayTestValue({
		runId: input.runId,
		parameters: input.parameters,
		metrics: input.metrics,
		expected: input.expected,
		actual: input.actual,
	}), null, 2)}\n`, 'utf8');
	await writeFile(markdownPath, renderWorkdayTestMarkdown(input), 'utf8');
	return { jsonPath, markdownPath };
}
