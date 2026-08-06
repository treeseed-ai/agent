import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { AgentSdk } from '@treeseed/sdk/sdk';
import { serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import { type SdkCreateMessageRequest, type SdkMessageEntity, type SdkRunEntity } from '@treeseed/sdk/types';
import type { AgentKernel } from "../../kernel/agents/agent-kernel.ts";
import { nowIso, resolveWranglerBin, runCommand } from './exec-file-async.ts';

export async function patchFixtureAgentSpecs(repoRoot: string) {
	const readTools = [
		'treedx.build_context',
		'treedx.read_repository_files',
		'treedx.search_workspace',
		'treedx.read_workspace_file',
		'treeseed.status',
	];
	const writeTools = [
		...readTools,
		'treedx.apply_workspace_changeset',
		'treedx.commit_workspace',
	];
	const engineeringTools = [
		...writeTools,
		'treeseed.dev_plan',
		'treeseed.changed_paths',
		'treeseed.verify',
	];
	const updates = new Map<string, { permissionLine?: string; tools: string[] }>([
		['architect.mdx', { permissionLine: '    operations: [pick, update, create]', tools: engineeringTools }],
		['engineer.mdx', { permissionLine: '    operations: [pick, update, create]', tools: engineeringTools }],
		['reporter.mdx', { tools: readTools }],
		['technical-writer.mdx', { tools: readTools }],
		['releaser.mdx', { permissionLine: '    operations: [pick, update, get, create]', tools: ['treedx.build_context', 'treedx.search_workspace', 'treedx.read_workspace_file', 'treeseed.status', 'treeseed.changed_paths', 'treeseed.verify'] }],
		['researcher.mdx', { permissionLine: '    operations: [pick, update, create]', tools: readTools }],
		['reviewer.mdx', { permissionLine: '    operations: [pick, update, get, create]', tools: ['treedx.build_context', 'treedx.search_workspace', 'treedx.read_workspace_file', 'treeseed.status', 'treeseed.changed_paths', 'treeseed.verify'] }],
	]);

	for (const [filename, update] of updates) {
		const filePath = path.join(repoRoot, 'src', 'content', 'agents', filename);
		const source = await readFile(filePath, 'utf8').catch(() => null);
		if (!source) {
			continue;
		}
		let next = update.permissionLine
			? source.replace(
				/(\n  - model: message\n)    operations: \[[^\]]+\]/,
				`$1${update.permissionLine}`,
			)
			: source;
		if (!/^tools:\n\s+allowed:/m.test(next)) {
			const toolsBlock = `tools:\n  allowed:\n${update.tools.map((tool) => `    - ${tool}`).join('\n')}\n`;
			next = next.replace(/^outputs:\n/m, `${toolsBlock}outputs:\n`);
		}
		if (next !== source) {
			await writeFile(filePath, next, 'utf8');
		}
	}
}

export async function transpileFixtureAgentHandlers(repoRoot: string) {
	const agentsRoot = path.join(repoRoot, 'src', 'agents');
	const agentFiles = (await readdir(agentsRoot, { withFileTypes: true }).catch(() => []))
		.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
		.map((entry) => entry.name);

	for (const filename of agentFiles) {
		const sourcePath = path.join(agentsRoot, filename);
		const outputPath = path.join(agentsRoot, filename.replace(/\.ts$/u, '.js'));
		const source = await readFile(sourcePath, 'utf8');
		const transformed = ts.transpileModule(source, {
			compilerOptions: {
				module: ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ES2022,
			},
		}).outputText.replace(/(['"`])(\.[^'"`\n]+)\.ts\1/g, '$1$2.js$1');
		await writeFile(outputPath, transformed, 'utf8');
	}
}

export async function migrateDatabase(repoRoot: string, persistTo: string) {
	const wrangler = await resolveWranglerBin();
	for (const migration of [
		'0001_subscribers.sql',
		'0002_agent_runtime.sql',
		'0003_agent_run_trace.sql',
		'0025_agent_runtime_state.sql',
	]) {
		await runCommand(
			wrangler,
			[
				'd1',
				'execute',
				'docs-site-data',
				'--local',
				'--persist-to',
				persistTo,
				'--file',
				path.join(repoRoot, 'migrations', migration),
			],
			repoRoot,
		);
	}
}

export async function initializeSandboxRepo(repoRoot: string) {
	await runCommand('git', ['init', '-b', 'main'], repoRoot);
	await runCommand('git', ['config', 'user.email', 'agents-e2e@example.test'], repoRoot);
	await runCommand('git', ['config', 'user.name', 'Agents E2E'], repoRoot);
	await runCommand('git', ['add', '.'], repoRoot);
	await runCommand('git', ['commit', '-m', 'test: baseline sandbox'], repoRoot);
}

export function createObjectiveDocument(slug: string, date: string) {
	return serializeFrontmatterDocument(
		{
			title: `Objective ${slug}`,
			description: `Objective ${slug} description`,
			date,
			status: 'planned',
			tags: ['agent', 'e2e'],
			summary: `Summary for ${slug}`,
			draft: false,
			timeHorizon: 'near-term',
			motivation: `Motivation for ${slug}`,
			primaryContributor: 'architect',
			relatedQuestions: [],
			relatedBooks: [],
		},
		`# Objective ${slug}\n`,
	);
}

export function createQuestionDocument(slug: string, date: string, relatedObjectives: string[] = []) {
	return serializeFrontmatterDocument(
		{
			title: `Question ${slug}`,
			description: `Question ${slug} description`,
			date,
			status: 'planned',
			tags: ['agent', 'e2e'],
			summary: `Summary for ${slug}`,
			draft: false,
			questionType: 'implementation',
			motivation: `Motivation for ${slug}`,
			primaryContributor: 'architect',
			relatedObjectives,
			relatedBooks: [],
		},
		`# Question ${slug}\n`,
	);
}

export function createKnowledgeDocument(slug: string, title: string) {
	return serializeFrontmatterDocument(
		{
			title,
			slug,
			updated: nowIso(),
			tags: ['agent', 'e2e'],
		},
		`# ${title}\n`,
	);
}

export interface AgentTestRuntime {
	rootDir: string;
	repoRoot: string;
	persistTo: string;
	sdk: AgentSdk;
	kernel: AgentKernel;
	seedObjectives(entries: Array<{ slug: string; date?: string }>): Promise<void>;
	seedQuestions(entries: Array<{ slug: string; date?: string; relatedObjectives?: string[] }>): Promise<void>;
	seedKnowledge(entries: Array<{ slug: string; title?: string }>): Promise<void>;
	seedMessages(entries: Array<Omit<SdkCreateMessageRequest, 'actor'>>): Promise<SdkMessageEntity[]>;
	clearModelContent(model: 'objective' | 'question' | 'knowledge'): Promise<void>;
	readMessages(): Promise<SdkMessageEntity[]>;
	readRunLogs(): Promise<SdkRunEntity[]>;
	readContentLeases(): Promise<Record<string, unknown>[]>;
	claimMessage(messageTypes: string[], workerId?: string): Promise<SdkMessageEntity | null>;
	claimObjectiveLease(itemKey: string, workerId?: string): Promise<string | null>;
	cleanup(): Promise<void>;
}
