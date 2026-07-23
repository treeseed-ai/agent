import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentSdk } from '@treeseed/sdk/sdk';
import { MemoryAgentDatabase } from '@treeseed/sdk/d1-store';
import { resolveModelDefinition } from '@treeseed/sdk/models';
import { type SdkMessageEntity } from '@treeseed/sdk/types';
import { runFromRecord } from '@treeseed/sdk/stores/run-store';
import type { ExecutionProviderAdapter, AgentMutationAdapter } from "../../runtime-types.ts";
import type { AgentKernel } from "../../kernel/agent-kernel.ts";
import { AgentTestRuntime, createKnowledgeDocument, createObjectiveDocument, createQuestionDocument, initializeSandboxRepo, migrateDatabase, patchFixtureAgentSpecs, transpileFixtureAgentHandlers } from './patch-fixture-agent-specs.ts';
import { createFixtureTreeDxFetch, linkWorkspaceNodeModules, resolveDocsRoot, resolveSharedNodeModules, runCommand } from './exec-file-async.ts';

export async function createAgentTestRuntime(options?: {
	execution?: ExecutionProviderAdapter;
	mutations?: AgentMutationAdapter;
	executionMode?: 'codex' | 'copilot';
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
	process.env.TREESEED_AGENT_EXECUTION_PROVIDER = options?.executionMode ?? 'codex';
	process.env.TREESEED_TENANT_ROOT = repoRoot;
	process.chdir(repoRoot);

	await mkdir(persistTo, { recursive: true });
	await initializeSandboxRepo(repoRoot);
	const treeDxFetch = await createFixtureTreeDxFetch(repoRoot);
	const [{ AgentKernel }, { AgentSdk }] = await Promise.all([
		import('../../kernel/agent-kernel.ts'),
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
				treeDx: {
					baseUrl: 'https://treedx.fixture.test',
					token: 'fixture-treedx-token',
					repoId: 'fixture-repo',
					ref: 'refs/heads/main',
					fetchImpl: treeDxFetch,
				},
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
				return [];
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
