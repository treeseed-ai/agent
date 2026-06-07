import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import ts from 'typescript';
import type { AgentSdk } from '@treeseed/sdk/sdk';
import {
	MemoryAgentDatabase,
} from '@treeseed/sdk/d1-store';
import { resolveModelDefinition } from '@treeseed/sdk/models';
import { serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import {
	type SdkCreateMessageRequest,
	type SdkMessageEntity,
	type SdkRunEntity,
} from '@treeseed/sdk/types';
import { runFromRecord } from '@treeseed/sdk/stores/run-store';
import type { AgentExecutionAdapter, AgentMutationAdapter } from '../runtime-types.ts';
import type { AgentKernel } from '../kernel/agent-kernel.ts';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

function nowIso() {
	return new Date().toISOString();
}

function resolveDocsRoot() {
	if (process.env.TREESEED_AGENT_FIXTURE_ROOT) {
		return path.resolve(process.env.TREESEED_AGENT_FIXTURE_ROOT);
	}

	const cwd = process.cwd();
	const workspaceSdkPackageRoot = path.resolve(cwd, '../sdk');
	const installedSdkPackageRoot = path.resolve(path.dirname(require.resolve('@treeseed/sdk/platform/tenant-config')), '../..');
	const candidates: string[] = [];
	let current = cwd;
	while (true) {
		candidates.push(
			path.resolve(current, '.fixtures', 'treeseed-fixtures', 'sites', 'working-site'),
			path.resolve(current, 'fixture'),
			path.resolve(current, 'fixtures', 'sites', 'working-site'),
		);
		const parent = path.resolve(current, '..');
		if (parent === current) {
			break;
		}
		current = parent;
	}
	candidates.push(
		path.resolve(workspaceSdkPackageRoot, '.fixtures', 'treeseed-fixtures', 'sites', 'working-site'),
		path.resolve(workspaceSdkPackageRoot, 'fixture'),
		path.resolve(installedSdkPackageRoot, '.fixtures', 'treeseed-fixtures', 'sites', 'working-site'),
		path.resolve(installedSdkPackageRoot, 'fixture'),
	);

	for (const candidate of candidates) {
		if (existsSync(path.join(candidate, 'src', 'manifest.yaml'))) {
			return candidate;
		}
	}

	throw new Error(
		`Unable to resolve an agent smoke fixture root. Checked: ${candidates.join(', ')}`,
	);
}

function resolveSharedNodeModules(startDir: string) {
	const requiredPackages = ['@treeseed/sdk'];
	const checked: string[] = [];
	let current = startDir;

	while (true) {
		const candidate = path.join(current, 'node_modules');
		checked.push(candidate);
		if (
			existsSync(candidate)
			&& requiredPackages.every((packageName) =>
				existsSync(path.join(candidate, ...packageName.split('/'))))
		) {
			return candidate;
		}

		const parent = path.resolve(current, '..');
		if (parent === current) {
			break;
		}
		current = parent;
	}

	throw new Error(
		`Unable to resolve a shared node_modules directory containing ${requiredPackages.join(', ')}. Checked: ${checked.join(', ')}`,
	);
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

async function linkWorkspaceNodeModules(sharedNodeModules: string, repoRoot: string, localAgentPackageRoot: string) {
	const targetRoot = path.join(repoRoot, 'node_modules');
	await mkdir(targetRoot, { recursive: true });

	const entries = await readdir(sharedNodeModules, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.name === '@treeseed') {
			const scopedSource = path.join(sharedNodeModules, entry.name);
			const scopedTarget = path.join(targetRoot, entry.name);
			await mkdir(scopedTarget, { recursive: true });
			const scopedEntries = await readdir(scopedSource, { withFileTypes: true }).catch(() => []);
			for (const scopedEntry of scopedEntries) {
				const sourcePath = path.join(scopedSource, scopedEntry.name);
				const targetPath = path.join(scopedTarget, scopedEntry.name);
				if (scopedEntry.name === 'agent') {
					continue;
				}
				await symlink(sourcePath, targetPath, scopedEntry.isDirectory() ? 'dir' : 'file').catch(() => undefined);
			}
			continue;
		}

		const sourcePath = path.join(sharedNodeModules, entry.name);
		const targetPath = path.join(targetRoot, entry.name);
		await symlink(sourcePath, targetPath, entry.isDirectory() ? 'dir' : 'file').catch(() => undefined);
	}

	const installedAgentRoot = path.join(targetRoot, '@treeseed', 'agent');
	await rm(installedAgentRoot, { recursive: true, force: true });
	await mkdir(installedAgentRoot, { recursive: true });
	await cp(path.join(localAgentPackageRoot, 'dist'), path.join(installedAgentRoot, 'dist'), { recursive: true });
	await writeFile(
		path.join(installedAgentRoot, 'package.json'),
		JSON.stringify({
			name: '@treeseed/agent',
			type: 'module',
			exports: {
				'.': './dist/index.js',
				'./runtime-types': './dist/agents/runtime-types.js',
				'./contracts/messages': './dist/agents/contracts/messages.js',
				'./contracts/run': './dist/agents/contracts/run.js',
			},
		}, null, 2),
		'utf8',
	);
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

async function patchFixtureAgentSpecs(repoRoot: string) {
	const updates = new Map<string, string>([
		['architecture-agent.mdx', '    operations: [pick, update, create]'],
		['engineer-agent.mdx', '    operations: [pick, update, create]'],
		['releaser-agent.mdx', '    operations: [pick, update, get, create]'],
		['researcher-agent.mdx', '    operations: [pick, update, create]'],
		['reviewer-agent.mdx', '    operations: [pick, update, get, create]'],
	]);

	for (const [filename, permissionLine] of updates) {
		const filePath = path.join(repoRoot, 'src', 'content', 'agents', filename);
		const source = await readFile(filePath, 'utf8').catch(() => null);
		if (!source) {
			continue;
		}
		const next = source.replace(
			/(\n  - model: message\n)    operations: \[[^\]]+\]/,
			`$1${permissionLine}`,
		);
		if (next !== source) {
			await writeFile(filePath, next, 'utf8');
		}
	}
}

async function transpileFixtureAgentHandlers(repoRoot: string) {
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

async function migrateDatabase(repoRoot: string, persistTo: string) {
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
	const rootDir = await mkdtemp(path.join(os.tmpdir(), 'agents-e2e-'));
	const repoRoot = path.join(rootDir, 'docs');
	const persistTo = path.join(rootDir, '.wrangler-state');
	const docsRoot = resolveDocsRoot();
	const previousContentRoot = process.env.TREESEED_AGENT_CONTENT_ROOT;
	const previousExecutionMode = process.env.TREESEED_AGENT_EXECUTION_PROVIDER;
	const previousTenantRoot = process.env.TREESEED_TENANT_ROOT;
	const previousCwd = process.cwd();
	const sharedNodeModules = resolveSharedNodeModules(previousCwd);

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
	if (existsSync(sharedNodeModules)) {
		await linkWorkspaceNodeModules(sharedNodeModules, repoRoot, previousCwd);
	}
	await transpileFixtureAgentHandlers(repoRoot);
	await patchFixtureAgentSpecs(repoRoot);

	process.env.TREESEED_AGENT_CONTENT_ROOT = path.join(repoRoot, 'src', 'content');
	process.env.TREESEED_AGENT_EXECUTION_PROVIDER = options?.executionMode ?? 'stub';
	process.env.TREESEED_TENANT_ROOT = repoRoot;
	process.chdir(repoRoot);

	await mkdir(persistTo, { recursive: true });
	await initializeSandboxRepo(repoRoot);
	const [{ AgentKernel }, { AgentSdk }] = await Promise.all([
		import('../kernel/agent-kernel.ts'),
		import('@treeseed/sdk/sdk'),
	]);
	const sdk =
		options?.databaseMode === 'local-d1'
			? (await migrateDatabase(repoRoot, persistTo), AgentSdk.createLocal({
				repoRoot,
				databaseName: 'docs-site-data',
				persistTo,
			}))
			: new AgentSdk({
				repoRoot,
				database: new MemoryAgentDatabase(),
				contentRepository: { adapter: 'local' },
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
			if (previousTenantRoot === undefined) {
				delete process.env.TREESEED_TENANT_ROOT;
			} else {
				process.env.TREESEED_TENANT_ROOT = previousTenantRoot;
			}
			process.chdir(previousCwd);
			await rm(rootDir, { recursive: true, force: true });
		},
	};
}
