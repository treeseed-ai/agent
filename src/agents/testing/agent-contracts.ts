import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { compileDeclarativeContextQuery } from '@treeseed/sdk/graph/context-query-contracts';
import { parse as parseYaml } from 'yaml';
import { AGENT_MESSAGE_TYPES } from '../contracts/messages.ts';
import { listRegisteredAgentHandlers, resolveAgentHandler } from '../registry.ts';
import { normalizeAgentRuntimeSpec } from '../spec-normalizer.ts';
import type { NormalizedAgentRuntimeSpec } from '../spec-types.ts';
import type { AgentSpecDiagnostic, RawAgentRuntimeSpec } from '../spec-types.ts';

const EXECUTION_PROVIDERS = new Set([
	'codex',
	'codex_subscription',
	'copilot',
	'jira',
	'jira_issue_queue',
	'human_issue_queue',
	'github_issues',
	'github_issue_queue',
	'issue_queue',
	'discord',
	'discord_thread',
	'workflow',
	'workflow_operation',
	'deterministic_workflow',
	'github_actions',
	'github_actions_workflow',
]);
const PROFILE_HANDLERS = new Set(['writer', 'actor', 'estimate', 'releaser', 'reporter']);

export interface AgentContractIssue {
	severity: 'error' | 'warning';
	slug: string;
	field: string;
	message: string;
}

export interface AgentContractCheckResult {
	ok: boolean;
	repoRoot: string;
	generatedAt: string;
	agents: Array<{
		slug: string;
		handler: string;
		projectAgentClassId: string;
		enabled: boolean;
		triggers: string[];
		outputMessageTypes: string[];
		permissions: string[];
		status: 'PASS' | 'WARN' | 'FAIL';
		issues: AgentContractIssue[];
	}>;
	issues: AgentContractIssue[];
	reportPath: string;
	jsonPath: string;
}

function permissionKey(permission: { model: string; operations: string[] }) {
	return `${permission.model}:${permission.operations.join(',')}`;
}

function hasPermission(agent: NormalizedAgentRuntimeSpec, model: string, operation: string) {
	return agent.permissions.some((permission) =>
		permission.model === model && permission.operations.includes(operation as never),
	);
}

function issue(agent: NormalizedAgentRuntimeSpec, field: string, message: string, severity: AgentContractIssue['severity'] = 'error'): AgentContractIssue {
	return { severity, slug: agent.slug, field, message };
}

function parseAgentSource(source: string) {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);
	if (!match) return { frontmatter: {}, body: source };
	const frontmatter = parseYaml(match[1] ?? '') as unknown;
	return {
		frontmatter: frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)
			? frontmatter as Record<string, unknown>
			: {},
		body: source.slice(match[0].length),
	};
}

async function discoverAgentContentRoots(repoRoot: string) {
	const candidates = [
		resolve(repoRoot, 'src/content/agents'),
		resolve(repoRoot, 'docs/src/content/agents'),
	];
	return candidates.filter((candidate) => existsSync(candidate));
}

async function listAgentSourceFiles(root: string) {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((entry) => entry.isFile() && /\.mdx?$/iu.test(entry.name))
		.map((entry) => join(root, entry.name))
		.sort((left, right) => left.localeCompare(right));
}

async function loadSourceAgentSpecs(repoRoot: string): Promise<{
	specs: NormalizedAgentRuntimeSpec[];
	diagnostics: AgentSpecDiagnostic[];
}> {
	const contentRoots = await discoverAgentContentRoots(repoRoot);
	const registeredHandlers = await listRegisteredAgentHandlers({ tenantRoot: repoRoot });
	const diagnostics: AgentSpecDiagnostic[] = [];
	const specs: NormalizedAgentRuntimeSpec[] = [];

	for (const contentRoot of contentRoots) {
		for (const sourcePath of await listAgentSourceFiles(contentRoot)) {
			const source = await readFile(sourcePath, 'utf8');
			const parsed = parseAgentSource(source);
			const rawSpec: RawAgentRuntimeSpec = {
				...parsed.frontmatter,
				body: parsed.body,
				id: relative(contentRoot, sourcePath).replace(/\\/gu, '/').replace(/\.mdx?$/iu, ''),
			};
			const result = normalizeAgentRuntimeSpec(rawSpec, {
				registeredHandlers: registeredHandlers as NormalizedAgentRuntimeSpec['handler'][],
				messageTypes: [...AGENT_MESSAGE_TYPES],
			});
			diagnostics.push(...result.diagnostics);
			if (result.spec) specs.push(result.spec);
		}
	}

	return { specs, diagnostics };
}

async function validateAgent(agent: NormalizedAgentRuntimeSpec, knownHandlers: string[], repoRoot: string) {
	const issues: AgentContractIssue[] = [];
	if (!knownHandlers.includes(agent.handler)) {
		issues.push(issue(agent, 'handler', `Handler "${agent.handler}" is not registered.`));
	} else {
		await resolveAgentHandler(agent.handler, { tenantRoot: repoRoot }).catch((error) => {
			issues.push(issue(agent, 'handler', error instanceof Error ? error.message : String(error)));
		});
	}
	if (!PROFILE_HANDLERS.has(agent.handler)) {
		issues.push(issue(agent, 'handler', 'First-party agent specs must use writer, actor, estimate, releaser, or reporter.'));
	}
	if (!agent.projectAgentClassId?.trim()) {
		issues.push(issue(agent, 'projectAgentClassId', 'Agents must declare the project agent class used for capacity allocation.'));
	}
	if (!agent.projectAgentClassSlug?.trim()) {
		issues.push(issue(agent, 'projectAgentClassSlug', 'Agents must declare a project agent class slug.'));
	}
	const messageTriggers = agent.triggers.filter((trigger) => trigger.type === 'message');
	if (messageTriggers.length > 0) {
		for (const [index, trigger] of messageTriggers.entries()) {
			if (!trigger.messageTypes?.length) {
				issues.push(issue(agent, `triggers.message[${index}].messageTypes`, 'Message triggers must declare at least one message type.'));
			}
			for (const messageType of trigger.messageTypes ?? []) {
				if (!(AGENT_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
					issues.push(issue(agent, `triggers.message[${index}].messageTypes`, `Unknown trigger message type "${messageType}".`));
				}
			}
		}
	}
	for (const messageType of agent.outputs.messageTypes ?? []) {
		if (!(AGENT_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
			issues.push(issue(agent, 'outputs.messageTypes', `Unknown output message type "${messageType}".`));
		}
	}
	if (agent.execution.sandboxMode === 'workspace_write') {
		if (!agent.execution.allowedPaths?.length) {
			issues.push(issue(agent, 'execution.allowedPaths', 'Write-capable agents must declare allowed paths.'));
		}
		if (!agent.execution.forbiddenPaths?.length) {
			issues.push(issue(agent, 'execution.forbiddenPaths', 'Write-capable agents must declare forbidden paths.'));
		}
		if (agent.slug.includes('docs') && agent.execution.allowedPaths?.includes('**')) {
			issues.push(issue(agent, 'execution.allowedPaths', 'Docs automation agents should avoid broad "**" write paths.', 'warning'));
		}
	}
	if (agent.execution.provider && !EXECUTION_PROVIDERS.has(agent.execution.provider)) {
		issues.push(issue(agent, 'execution.provider', `Unsupported execution provider "${agent.execution.provider}".`));
	}
	if (agent.execution.providerProfile && !agent.execution.providerProfile.requiredCapabilities?.length) {
		issues.push(issue(agent, 'execution.providerProfile.requiredCapabilities', 'Provider profiles must declare required execution-provider capabilities when present.'));
	}
	for (const [index, query] of (agent.context?.queries ?? []).entries()) {
		if (!query.id?.trim()) {
			issues.push(issue(agent, `context.queries[${index}].id`, 'Context queries must declare an id.'));
		}
		if (!query.query?.trim()) {
			issues.push(issue(agent, `context.queries[${index}].query`, 'Context queries must declare a query.'));
		}
		if (typeof query.budget !== 'number' || query.budget <= 0) {
			issues.push(issue(agent, `context.queries[${index}].budget`, 'Context queries must declare a positive budget.'));
		}
		const compiled = compileDeclarativeContextQuery(query, { defaultLimit: 8, maxDepth: 3 });
		for (const error of compiled.errors) {
			issues.push(issue(agent, `context.queries[${index}]`, error));
		}
	}
	return issues;
}

function renderReport(result: Omit<AgentContractCheckResult, 'reportPath' | 'jsonPath'>) {
	const lines = [
		'# Agent Contract Test Report',
		'',
		`Generated: ${result.generatedAt}`,
		`Repository: ${result.repoRoot}`,
		`Status: ${result.ok ? 'PASS' : 'FAIL'}`,
		'',
	];
	for (const agent of result.agents) {
		lines.push(
			`## ${agent.slug}`,
			'',
			`Handler: ${agent.handler}`,
			`Project agent class: ${agent.projectAgentClassId}`,
			`Enabled: ${agent.enabled}`,
			`Triggers: ${agent.triggers.length ? agent.triggers.join(', ') : 'none'}`,
			`Declared outputs: ${agent.outputMessageTypes.length ? agent.outputMessageTypes.join(', ') : 'none'}`,
			`Permissions: ${agent.permissions.length ? agent.permissions.join('; ') : 'none'}`,
			`Status: ${agent.status}`,
		);
		if (agent.issues.length) {
			lines.push('Issues:');
			for (const entry of agent.issues) {
				lines.push(`- ${entry.severity.toUpperCase()} ${entry.field}: ${entry.message}`);
			}
		} else {
			lines.push('Issues: none');
		}
		lines.push('');
	}
	return `${lines.join('\n')}\n`;
}

export async function runAgentContractChecks(options: {
	repoRoot?: string;
	reportPath?: string;
	now?: Date;
} = {}): Promise<AgentContractCheckResult> {
	const repoRoot = resolve(options.repoRoot ?? process.cwd());
	const generatedAt = (options.now ?? new Date()).toISOString();
	const loaded = await loadSourceAgentSpecs(repoRoot);
	const knownHandlers = await listRegisteredAgentHandlers({ tenantRoot: repoRoot });
	const slugCounts = new Map<string, number>();
	for (const spec of loaded.specs) {
		slugCounts.set(spec.slug, (slugCounts.get(spec.slug) ?? 0) + 1);
	}
	const normalizationIssues: AgentContractIssue[] = loaded.diagnostics.map((diagnostic) => ({
		severity: diagnostic.severity,
		slug: diagnostic.slug ?? 'unknown',
		field: diagnostic.field,
		message: diagnostic.message,
	}));
	const agents = [];
	for (const spec of loaded.specs) {
		const issues = await validateAgent(spec, knownHandlers, repoRoot);
		if ((slugCounts.get(spec.slug) ?? 0) > 1) {
			issues.push(issue(spec, 'slug', `Duplicate agent slug "${spec.slug}".`));
		}
		issues.push(...normalizationIssues.filter((entry) => entry.slug === spec.slug));
		agents.push({
			slug: spec.slug,
			handler: spec.handler,
			projectAgentClassId: spec.projectAgentClassId,
			enabled: spec.enabled,
			triggers: spec.triggers.map((trigger) => trigger.type),
			outputMessageTypes: spec.outputs.messageTypes ?? [],
			permissions: spec.permissions.map(permissionKey),
			status: issues.some((entry) => entry.severity === 'error') ? 'FAIL' as const : issues.length ? 'WARN' as const : 'PASS' as const,
			issues,
		});
	}
	const issues = [
		...normalizationIssues.filter((entry) => !loaded.specs.some((spec) => spec.slug === entry.slug)),
		...agents.flatMap((agent) => agent.issues),
	];
	const resultWithoutPath = {
		ok: !issues.some((entry) => entry.severity === 'error'),
		repoRoot,
		generatedAt,
		agents,
		issues,
	};
	const reportPath = resolve(options.reportPath ?? resolve(repoRoot, '.treeseed/test-reports/agent-contracts.md'));
	const jsonPath = reportPath.replace(/\.md$/u, '.json');
	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(reportPath, renderReport(resultWithoutPath), 'utf8');
	await writeFile(jsonPath, `${JSON.stringify(resultWithoutPath, null, 2)}\n`, 'utf8');
	return {
		...resultWithoutPath,
		reportPath,
		jsonPath,
	};
}
