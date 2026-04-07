import { execFile } from 'node:child_process';
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { AgentExecutionAdapter, AgentMutationAdapter } from '../runtime-types.ts';
import { MemoryAgentDatabase } from '../d1-store.ts';
import { AgentKernel } from '../kernel/agent-kernel.ts';
import { resolveModelDefinition } from '../model-registry.ts';
import { AgentSdk } from '../sdk.ts';
import { runFromRecord } from '../stores/run-store.ts';
import { serializeFrontmatterDocument } from '../frontmatter.ts';
import type {
	SdkCreateMessageRequest,
	SdkMessageEntity,
	SdkRunEntity,
} from '../sdk-types';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

function nowIso() {
	return new Date().toISOString();
}

function resolveDocsRoot() {
	if (process.env.TREESEED_AGENT_FIXTURE_ROOT) {
		return path.resolve(process.env.TREESEED_AGENT_FIXTURE_ROOT);
	}

	const corePackageRoot = path.resolve(path.dirname(require.resolve('@treeseed/core')), '..');
	return path.resolve(corePackageRoot, 'fixture');
}

async function resolveWranglerBin() {
	if (process.env.TREESEED_AGENT_WRANGLER_BIN) {
		return path.resolve(process.env.TREESEED_AGENT_WRANGLER_BIN);
	}

	try {
		const wranglerPackageRoot = path.resolve(path.dirname(require.resolve('wrangler/package.json')));
		const packageJson = JSON.parse(await readFile(path.join(wranglerPackageRoot, 'package.json'), 'utf8'));
		const relativeBin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.wrangler;
		if (!relativeBin) {
			throw new Error('Unable to resolve wrangler binary path from package.json.');
		}
		return path.resolve(wranglerPackageRoot, relativeBin);
	} catch {
		const packageLocal = path.resolve(resolveDocsRoot(), 'node_modules', '.bin', 'wrangler');
		await access(packageLocal);
		return packageLocal;
	}
}

async function runCommand(command: string, args: string[], cwd: string) {
	await execFileAsync(command, args, {
		cwd,
		env: process.env,
		maxBuffer: 10 * 1024 * 1024,
	});
}

async function walkFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.join(root, entry.name);
			if (entry.isDirectory()) {
				return walkFiles(fullPath);
			}
			return [fullPath];
		}),
	);
	return nested.flat();
}

async function migrateDatabase(repoRoot: string, persistTo: string) {
	const wrangler = await resolveWranglerBin();
	for (const migration of [
		'0001_subscribers.sql',
		'0002_agent_runtime.sql',
		'0003_agent_run_trace.sql',
	]) {
		await runCommand(
			wrangler,
			[
				'd1',
				'execute',
				'karyon-docs-site-data',
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

async function initializeSandboxRepo(repoRoot: string) {
	await runCommand('git', ['init', '-b', 'main'], repoRoot);
	await runCommand('git', ['config', 'user.email', 'agents-e2e@example.test'], repoRoot);
	await runCommand('git', ['config', 'user.name', 'Agents E2E'], repoRoot);
	await runCommand('git', ['add', '.'], repoRoot);
	await runCommand('git', ['commit', '-m', 'test: baseline sandbox'], repoRoot);
}

function createObjectiveDocument(slug: string, date: string) {
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
			primaryContributor: 'planner-agent',
			relatedQuestions: [],
			relatedBooks: [],
		},
		`# Objective ${slug}\n`,
	);
}

function createQuestionDocument(slug: string, date: string, relatedObjectives: string[] = []) {
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
			primaryContributor: 'planner-agent',
			relatedObjectives,
			relatedBooks: [],
		},
		`# Question ${slug}\n`,
	);
}

function createKnowledgeDocument(slug: string, title: string) {
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
	runAgent(slug: string): Promise<unknown>;
	runCycle(): Promise<unknown>;
	readMessages(): Promise<SdkMessageEntity[]>;
	readRunLogs(): Promise<SdkRunEntity[]>;
	readContentLeases(): Promise<Record<string, unknown>[]>;
	readSandboxArtifacts(): Promise<Array<{ path: string; content: string }>>;
	claimMessage(messageTypes: string[], workerId?: string): Promise<SdkMessageEntity | null>;
	claimObjectiveLease(itemKey: string, workerId?: string): Promise<string | null>;
	cleanup(): Promise<void>;
}

export async function createAgentTestRuntime(options?: {
	execution?: AgentExecutionAdapter;
	mutations?: AgentMutationAdapter;
	executionMode?: 'stub' | 'copilot';
	databaseMode?: 'memory' | 'local-d1';
}) : Promise<AgentTestRuntime> {
	const rootDir = await mkdtemp(path.join(os.tmpdir(), 'karyon-agents-e2e-'));
	const repoRoot = path.join(rootDir, 'docs');
	const persistTo = path.join(rootDir, '.wrangler-state');
	const docsRoot = resolveDocsRoot();
	const previousContentRoot = process.env.TREESEED_AGENT_CONTENT_ROOT;
	const previousExecutionMode = process.env.TREESEED_AGENT_EXECUTION_PROVIDER;

	await cp(docsRoot, repoRoot, {
		recursive: true,
		filter(source) {
			const relativePath = path.relative(docsRoot, source);
			if (!relativePath) {
				return true;
			}
			return ![
				'.wrangler',
				'.agent-worktrees',
				'node_modules',
				'dist',
				'.astro',
				'coverage',
			].some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}${path.sep}`));
		},
	});

	process.env.TREESEED_AGENT_CONTENT_ROOT = path.join(repoRoot, 'src', 'content');
	process.env.TREESEED_AGENT_EXECUTION_PROVIDER = options?.executionMode ?? 'stub';

	await mkdir(persistTo, { recursive: true });
	await initializeSandboxRepo(repoRoot);
	const sdk =
		options?.databaseMode === 'local-d1'
			? (await migrateDatabase(repoRoot, persistTo), AgentSdk.createLocal({
				repoRoot,
				databaseName: 'karyon-docs-site-data',
				persistTo,
			}))
			: new AgentSdk({
				repoRoot,
				database: new MemoryAgentDatabase(),
			});
	const kernel = new AgentKernel(sdk, repoRoot, {
		execution: options?.execution,
		mutations: options?.mutations,
	});

	async function writeSeedFile(relativePath: string, source: string, message: string) {
		const filePath = path.join(repoRoot, relativePath);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, source, 'utf8');
		await runCommand('git', ['add', relativePath], repoRoot);
		await runCommand('git', ['commit', '-m', message], repoRoot);
	}

	return {
		rootDir,
		repoRoot,
		persistTo,
		sdk,
		kernel,
		async seedObjectives(entries) {
			for (const entry of entries) {
				await writeSeedFile(
					path.join('src', 'content', 'objectives', `${entry.slug}.mdx`),
					createObjectiveDocument(entry.slug, entry.date ?? '2099-01-01T00:00:00.000Z'),
					`test(seed): objective ${entry.slug}`,
				);
			}
		},
		async seedQuestions(entries) {
			for (const entry of entries) {
				await writeSeedFile(
					path.join('src', 'content', 'questions', `${entry.slug}.mdx`),
					createQuestionDocument(
						entry.slug,
						entry.date ?? '2099-01-01T00:00:00.000Z',
						entry.relatedObjectives ?? [],
					),
					`test(seed): question ${entry.slug}`,
				);
			}
		},
		async seedKnowledge(entries) {
			for (const entry of entries) {
				await writeSeedFile(
					path.join('src', 'content', 'knowledge', `${entry.slug}.md`),
					createKnowledgeDocument(entry.slug, entry.title ?? `Knowledge ${entry.slug}`),
					`test(seed): knowledge ${entry.slug}`,
				);
			}
		},
		async seedMessages(entries) {
			const messages = [];
			for (const entry of entries) {
				const created = await sdk.createMessage({
					...entry,
					actor: 'agents-e2e',
				});
				messages.push(created.payload);
			}
			return messages;
		},
		async clearModelContent(model) {
			const definition = resolveModelDefinition(model);
			if (!definition.contentDir) {
				throw new Error(`Model ${model} is not content-backed.`);
			}
			const relativeContentDir = path.relative(repoRoot, definition.contentDir);
			await rm(definition.contentDir, { recursive: true, force: true });
			await mkdir(definition.contentDir, { recursive: true });
			await runCommand('git', ['add', '-A', relativeContentDir], repoRoot);
			await runCommand('git', ['commit', '-m', `test(seed): clear ${model}`], repoRoot);
		},
		runAgent(slug: string) {
			return kernel.runAgent(slug);
		},
		runCycle() {
			return kernel.runCycle();
		},
		async readMessages() {
			const response = await sdk.search({
				model: 'message',
				sort: [{ field: 'created_at', direction: 'asc' }],
				limit: 100,
			});
			return response.payload as SdkMessageEntity[];
		},
		async readRunLogs() {
			const database = sdk.database as {
				db?: { prepare: (query: string) => { all: <T>() => Promise<{ results: T[] }> } };
				inspectRuns?: () => Record<string, unknown>[];
			};
			if (database.inspectRuns) {
				return database.inspectRuns().map((row) => runFromRecord(row));
			}
			const rows = database.db
				? await database.db.prepare(`
					SELECT
						record_key AS run_id,
						lookup_key AS agent_slug,
						status,
						json_extract(payload_json, '$.triggerSource') AS trigger_source,
						json_extract(payload_json, '$.handlerKind') AS handler_kind,
						json_extract(payload_json, '$.triggerKind') AS trigger_kind,
						json_extract(payload_json, '$.selectedItemKey') AS selected_item_key,
						json_extract(payload_json, '$.selectedMessageId') AS selected_message_id,
						json_extract(payload_json, '$.claimedMessageId') AS claimed_message_id,
						json_extract(payload_json, '$.branchName') AS branch_name,
						secondary_key AS commit_sha,
						json_extract(payload_json, '$.prUrl') AS pr_url,
						json_extract(payload_json, '$.summary') AS summary,
						json_extract(payload_json, '$.error') AS error,
						json_extract(payload_json, '$.errorCategory') AS error_category,
						json_extract(payload_json, '$.changedPaths') AS changed_paths,
						created_at AS started_at,
						json_extract(payload_json, '$.finishedAt') AS finished_at
					FROM runtime_records
					WHERE record_type = 'agent_run'
					ORDER BY created_at ASC
				`).all<Record<string, unknown>>()
				: { results: [] };
			return rows.results.map((row) => runFromRecord(row));
		},
		async readContentLeases() {
			const database = sdk.database as {
				db?: { prepare: (query: string) => { all: <T>() => Promise<{ results: T[] }> } };
				inspectLeases?: () => Record<string, unknown>[];
			};
			if (database.inspectLeases) {
				return database.inspectLeases();
			}
			if (!database.db) {
				return [];
			}
			const rows = await database.db.prepare('SELECT * FROM lease_state ORDER BY item_key ASC').all<Record<string, unknown>>();
			return rows.results;
		},
		async readSandboxArtifacts() {
			const worktreeRoot = path.join(repoRoot, '.agent-worktrees');
			const files = (await walkFiles(worktreeRoot)).filter((entry) => entry.includes(`${path.sep}.agent-artifacts${path.sep}`));
			return Promise.all(
				files.map(async (filePath) => ({
					path: filePath,
					content: await readFile(filePath, 'utf8'),
				})),
			);
		},
		async claimMessage(messageTypes, workerId = 'agents-e2e-claimer') {
			const claimed = await sdk.claimMessage({
				workerId,
				messageTypes,
				leaseSeconds: 300,
			});
			return claimed.payload;
		},
		async claimObjectiveLease(itemKey, workerId = 'agents-e2e-lease-holder') {
			return sdk.database.tryClaimContentLease({
				model: 'objective',
				itemKey,
				claimedBy: workerId,
				leaseSeconds: 300,
			});
		},
		async cleanup() {
			if (previousContentRoot === undefined) {
				delete process.env.TREESEED_AGENT_CONTENT_ROOT;
			} else {
				process.env.TREESEED_AGENT_CONTENT_ROOT = previousContentRoot;
			}
			if (previousExecutionMode === undefined) {
				delete process.env.TREESEED_AGENT_EXECUTION_PROVIDER;
			} else {
				process.env.TREESEED_AGENT_EXECUTION_PROVIDER = previousExecutionMode;
			}
			await rm(rootDir, { recursive: true, force: true });
		},
	};
}
