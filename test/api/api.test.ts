import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseTemplateCatalogResponse } from '@treeseed/sdk';
import type { D1DatabaseLike, D1PreparedStatementLike } from '@treeseed/sdk/types/cloudflare';
import { createTreeseedApiApp } from '../../src/api/app.ts';
import { D1AuthProvider } from '../../src/api/auth/d1-provider.ts';
import { resolveApiConfig } from '../../src/api/config.ts';
import {
	AgentApprovalDecisionError,
	recordAgentApprovalDecision,
} from '../../src/api/agent-artifacts.ts';
import { isDirectEntrypoint } from '../../src/entrypoint.ts';

const packageRoot = process.cwd();
const authMigrationPathCandidates = [
	resolve(packageRoot, 'test/fixtures/0007_site_web_sessions.sql'),
	resolve(packageRoot, '../sdk/drizzle/d1/0000_treeseed_d1.sql'),
	resolve(packageRoot, '../../packages/sdk/drizzle/d1/0000_treeseed_d1.sql'),
];
const authMigrationPath = authMigrationPathCandidates.find((candidate) => existsSync(candidate));
const sqliteModule = await import('node:sqlite').catch(() => null);
const DatabaseSyncCtor = sqliteModule?.DatabaseSync ?? null;
const apiRuntimeDescribe = DatabaseSyncCtor ? describe : describe.skip;

if (!authMigrationPath) {
	throw new Error(
		`Unable to resolve auth migration fixture. Checked: ${authMigrationPathCandidates.join(', ')}`,
	);
}

class TestPreparedStatement implements D1PreparedStatementLike {
	private bindings: unknown[] = [];

	constructor(
		private readonly db: {
			prepare: (query: string) => {
				run: (...values: unknown[]) => unknown;
				get: (...values: unknown[]) => unknown;
				all: (...values: unknown[]) => unknown[];
			};
		},
		private readonly query: string,
	) {}

	bind(...values: unknown[]) {
		this.bindings = values;
		return this;
	}

	async run() {
		this.db.prepare(this.query).run(...this.bindings);
		return {};
	}

	async first<T = Record<string, unknown>>() {
		return (this.db.prepare(this.query).get(...this.bindings) as T | undefined) ?? null;
	}

	async all<T = Record<string, unknown>>() {
		return {
			results: this.db.prepare(this.query).all(...this.bindings) as T[],
		};
	}

	async raw<T = unknown[]>() {
		const rows = this.db.prepare(this.query).all(...this.bindings) as Array<Record<string, unknown>>;
		return rows.map((row) => Object.values(row)) as T[];
	}
}

class TestD1Database implements D1DatabaseLike {
	private readonly db = new DatabaseSyncCtor(':memory:');

	constructor() {
		this.db.exec(readFileSync(authMigrationPath, 'utf8'));
	}

	prepare(query: string) {
		return new TestPreparedStatement(this.db, query);
	}

	async exec(query: string) {
		this.db.exec(query);
		return {};
	}
}

function createTestConfig() {
	return {
		repoRoot: packageRoot,
		authSecret: 'test-secret',
		cloudflareAccountId: 'cf-test-account',
		cloudflareApiToken: 'cf-test-token',
		d1DatabaseId: 'd1-test-db',
		webServiceId: 'web',
		webServiceSecret: 'web-test-secret',
		webAssertionSecret: 'web-assertion-test-secret',
	};
}

function createTestApp(options: Parameters<typeof createTreeseedApiApp>[0] = {}) {
	const db = new TestD1Database();
	const config = {
		...createTestConfig(),
		...(options.config ?? {}),
	};
	const selectedAuthProvider = config.providers?.auth ?? 'test-d1';
	return createTreeseedApiApp({
		...options,
		config: {
			...config,
			providers: {
				...(config.providers ?? {}),
				auth: selectedAuthProvider,
				agents: config.providers?.agents ?? {
					execution: 'stub',
					queue: 'memory',
					notification: 'stub',
					repository: 'stub',
					verification: 'stub',
				},
			},
		},
		runtimeProviders: {
			...options.runtimeProviders,
			auth: {
				...(options.runtimeProviders?.auth ?? {}),
				[selectedAuthProvider]: ({ config: runtimeConfig }) => new D1AuthProvider(runtimeConfig, { db }),
			},
		},
	});
}

async function json(response: Response) {
	return response.json() as Promise<any>;
}

async function authorizeApp(scopes: string[]) {
	const app = createTestApp();

	const started = await json(await app.request('/auth/device/start', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ scopes }),
	}));
	await app.request('/auth/device/approve', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			userCode: started.userCode,
			principalId: 'test-user',
			displayName: 'Test User',
			scopes,
		}),
	});
	const tokenPayload = await json(await app.request('/auth/device/poll', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ deviceCode: started.deviceCode }),
	}));

	return {
		app,
		token: tokenPayload.accessToken as string,
	};
}

apiRuntimeDescribe('@treeseed/agent api runtime', () => {
	it('exposes the agent runtime exports', () => {
		const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as Record<string, any>;
		expect(packageJson.name).toBe('@treeseed/agent');
		expect(packageJson.exports).toMatchObject({
			'.': { default: './dist/index.js' },
			'./api': { default: './dist/api/index.js' },
			'./api/app': { default: './dist/api/app.js' },
			'./services/worker': { default: './dist/services/worker.js' },
			'./services/workday-start': { default: './dist/services/workday-start.js' },
			'./services/workday-report': { default: './dist/services/workday-report.js' },
		});

		let importMatches = '';
		try {
			importMatches = execFileSync(
				'rg',
				['-n', '@treeseed/api', 'src', 'README.md', 'package.json'],
				{ cwd: process.cwd(), encoding: 'utf8' },
			).trim();
		} catch {
			importMatches = '';
		}
		expect(importMatches).toBe('');
	});

	it('recognizes run-ts bundled entrypoints as direct entrypoints', () => {
		const previousEntry = process.argv[1];
		try {
			process.argv[1] = resolve(packageRoot, 'src/api/server.ts');
			const bundledUrl = pathToFileURL(resolve(packageRoot, 'src/api/.ts-run-test.mjs')).href;
			expect(isDirectEntrypoint(bundledUrl, 'server.ts')).toBe(true);
			expect(isDirectEntrypoint(bundledUrl, 'worker.ts')).toBe(false);
		} finally {
			process.argv[1] = previousEntry;
		}
	});

	it('derives Railway-aware config without contaminating local defaults', () => {
		const config = resolveApiConfig({
			PORT: '4312',
			RAILWAY_PUBLIC_DOMAIN: 'treeseed.up.railway.app',
			TREESEED_API_AUTH_SECRET: 'secret',
		});

		expect(config.port).toBe(4312);
		expect(config.baseUrl).toBe('https://treeseed.up.railway.app');
		expect(config.issuer).toBe('https://treeseed.up.railway.app');
		expect(config.providers.auth).toBe('d1');
	});

	it('accepts canonical web service env names for hosted API credentials', () => {
		const config = resolveApiConfig({
			TREESEED_WEB_SERVICE_ID: 'web-hosted',
			TREESEED_WEB_SERVICE_SECRET: 'hosted-service-secret',
			TREESEED_WEB_ASSERTION_SECRET: 'hosted-assertion-secret',
		});

		expect(config.webServiceId).toBe('web-hosted');
		expect(config.webServiceSecret).toBe('hosted-service-secret');
		expect(config.webAssertionSecret).toBe('hosted-assertion-secret');
	});

	it('uses the web URL for local device approval links', async () => {
		const config = resolveApiConfig({
			HOST: '127.0.0.1',
			PORT: '3000',
			TREESEED_SITE_URL: 'http://127.0.0.1:4321',
		});

		expect(config.baseUrl).toBe('http://127.0.0.1:3000');
		expect(config.authApprovalBaseUrl).toBe('http://127.0.0.1:4321');

		const app = createTestApp({
			config: {
				baseUrl: 'http://127.0.0.1:3000',
				authApprovalBaseUrl: 'http://127.0.0.1:4321',
			},
		});
		const response = await app.request('/auth/device/approve?user_code=ABCD-EFGH');

		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('http://127.0.0.1:4321/auth/device/approve?user_code=ABCD-EFGH');
	});

	it('uses the configured web URL for production device approval links', () => {
		const config = resolveApiConfig({
			TREESEED_API_BASE_URL: 'https://api.treeseed.ai',
			TREESEED_SITE_URL: 'https://treeseed.ai',
		});

		expect(config.baseUrl).toBe('https://api.treeseed.ai');
		expect(config.authApprovalBaseUrl).toBe('https://treeseed.ai');
	});

	it('keeps device approval links on the web page route when the configured approval base has a path', async () => {
		const app = createTestApp({
			config: {
				baseUrl: 'https://treeseed.ai/v1',
			},
		});
		const started = await json(await app.request('/auth/device/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ clientName: 'treeseed-cli', scopes: ['auth:me'] }),
		}));

		expect(started.verificationUri).toBe('https://treeseed.ai/auth/device/approve');
		expect(started.verificationUriComplete).toBe(`https://treeseed.ai/auth/device/approve?user_code=${encodeURIComponent(started.userCode)}`);
	});

	it('rejects loopback approval links for remote APIs', () => {
		expect(() => resolveApiConfig({
			TREESEED_API_BASE_URL: 'https://api-treeseed-market-staging-ca844c56.treeseed.ai',
			TREESEED_SITE_URL: 'http://127.0.0.1:4321',
		})).toThrow(/Refusing loopback device approval URL/u);
	});

	it('serves health, templates, and the agent health surface', async () => {
		const app = createTestApp();

		const healthResponse = await app.request('/healthz');
		expect(healthResponse.status).toBe(200);
		expect(await json(healthResponse)).toMatchObject({ ok: true, status: 'ok' });

		const templatesResponse = await app.request('/templates');
		expect(templatesResponse.status).toBe(200);
		const templatesPayload = await json(templatesResponse);
		expect(parseTemplateCatalogResponse(templatesPayload).items.length).toBeGreaterThan(0);

		const agentHealthResponse = await app.request('/agent/healthz');
		expect(agentHealthResponse.status).toBe(200);
		expect(await json(agentHealthResponse)).toMatchObject({ ok: true });
	});

	it('exposes generated agent artifacts and ignores malformed task outputs', async () => {
		const sdk = {
			searchTasks: vi.fn(async () => ({
				payload: [
					{
						id: 'task-research-1',
						workDayId: 'workday-1',
						type: 'research_question',
						state: 'completed',
						createdAt: '2026-05-13T00:00:00.000Z',
						updatedAt: '2026-05-13T00:01:00.000Z',
						payloadJson: '{}',
					},
					{
						id: 'task-scan-1',
						workDayId: 'workday-1',
						type: 'scan_codebase_documentation_surface',
						state: 'completed',
						createdAt: '2026-05-13T00:00:30.000Z',
						updatedAt: '2026-05-13T00:00:45.000Z',
						payloadJson: '{}',
					},
					{
						id: 'task-optimize-1',
						workDayId: 'workday-1',
						type: 'optimize_knowledge_draft',
						state: 'completed',
						createdAt: '2026-05-13T00:02:00.000Z',
						updatedAt: '2026-05-13T00:03:00.000Z',
						payloadJson: '{}',
					},
					{
						id: 'task-promote-to-staging-1',
						workDayId: 'workday-1',
						type: 'promote_knowledge_to_staging',
						state: 'completed',
						createdAt: '2026-05-13T00:04:00.000Z',
						updatedAt: '2026-05-13T00:05:00.000Z',
						payloadJson: '{}',
					},
				],
			})),
			search: vi.fn(async (request) => {
				if (request.model === 'task_output') {
					return {
						payload: [
							{
								id: 'output-scan-1',
								taskId: 'task-scan-1',
								outputJson: JSON.stringify({
									taskId: 'task-scan-1',
									artifactKind: 'codebase_inventory',
									codebaseInventory: {
										id: 'codebase_inventory:2026-05-13',
										kind: 'codebase_inventory',
										title: 'TreeSeed Codebase Documentation Surface Inventory',
										generatedAt: '2026-05-13T00:00:45.000Z',
										graphVersion: 'graph-1',
										repoRef: 'local',
										scanTargets: [],
										ignoredPatterns: [],
										packages: [],
										modules: [{
											path: 'packages/agent/src/services',
											importantFiles: ['packages/agent/src/services/worker.ts'],
										}],
										knowledgeGaps: [],
										warnings: [],
									},
									generatedArtifacts: [],
								}),
							},
							{
								id: 'output-research-1',
								taskId: 'task-research-1',
								outputJson: JSON.stringify({
									taskId: 'task-research-1',
									researchNote: {
										id: 'research:runtime-v1',
										kind: 'research_note',
										questionId: 'question:runtime',
										state: 'draft',
										contextQueries: [],
										contextPackSummary: 'Runtime context.',
										sourceRefs: [{ ref: 'packages/agent/src/services/worker.ts', kind: 'path', title: 'Worker' }],
										sourceMap: [{
											claim: 'Worker runtime evidence.',
											sourceFiles: ['packages/agent/src/services/worker.ts'],
											sourceSymbolsOrSections: ['Worker'],
											evidenceStrength: 'direct',
											uncertainty: 'Fixture evidence.',
											lastObservedRef: 'graph-1',
										}],
										observedFacts: [],
										inferences: [],
										uncertainties: [],
										recommendedKnowledgeArtifacts: [],
										recommendedImplementationProposal: null,
										createdAt: '2026-05-13T00:00:00.000Z',
									},
									generatedArtifacts: [],
								}),
							},
							{
								id: 'output-optimize-1',
								taskId: 'task-optimize-1',
								outputJson: JSON.stringify({
									taskId: 'task-optimize-1',
									knowledgeDraft: {
										id: 'knowledge:runtime',
										kind: 'knowledge_draft',
										title: 'Runtime',
										book: 'architecture',
										section: 'runtime',
										targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
										state: 'draft',
										sourceQuestionId: 'question:runtime',
										sourceResearchIds: ['research:runtime-v1'],
										frontmatter: {},
										body: '# Runtime',
										reviewState: 'pending_review',
										createdAt: '2026-05-13T00:02:00.000Z',
										updatedAt: '2026-05-13T00:02:00.000Z',
									},
									optimizationReport: {
										id: 'optimization:runtime',
										kind: 'knowledge_optimization_report',
										draftId: 'knowledge:runtime',
										score: {
											factual_grounding: 4,
											book_fit: 4,
											structure: 5,
											future_agent_usefulness: 4,
											human_reviewability: 4,
											link_quality: 4,
											uncertainty_visibility: 4,
										},
										totalScore: 29,
										recommendation: 'promote',
										remainingIssues: [],
										criticalIssues: [],
										createdAt: '2026-05-13T00:03:00.000Z',
									},
								}),
							},
							{
								id: 'output-promotion-1',
								taskId: 'task-promote-to-staging-1',
								outputJson: JSON.stringify({
									taskId: 'task-promote-to-staging-1',
									artifactKind: 'docs_mutation_result',
									promotionToStaging: {
										status: 'staged',
										summary: 'Knowledge draft was staged.',
										taskId: 'task-promote-to-staging-1',
										draftId: 'knowledge:runtime',
										targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
										featureBranch: 'agent/knowledge-promotion/task-promote-to-staging-1',
										stagingBranch: 'staging',
										changedPaths: ['src/content/knowledge/architecture/runtime/runtime.mdx'],
										verification: { ok: true, summary: 'ok', commandsRun: ['npm run test:unit'], errors: [] },
										snapshots: [],
										operationResults: [],
										mergedToStaging: true,
									},
									docsMutationResult: {
										status: 'staged',
										taskId: 'task-promote-to-staging-1',
										draftId: 'knowledge:runtime',
										targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
										changedPaths: ['src/content/knowledge/architecture/runtime/runtime.mdx'],
										verification: { ok: true, summary: 'ok', commandsRun: ['npm run test:unit'], errors: [] },
										mergedToStaging: true,
									},
									generatedArtifacts: [],
								}),
							},
							{
								id: 'output-bad',
								taskId: 'task-research-1',
								outputJson: '{bad json',
							},
						],
					};
				}
				if (request.model === 'work_day') {
					return { payload: [{ id: 'workday-1', projectId: 'treeseed-api-test', state: 'active', updatedAt: '2026-05-13T00:04:00.000Z' }] };
				}
				if (request.model === 'report') {
					return { payload: [{ id: 'report-1', workDayId: 'workday-1', kind: 'workday_summary', bodyJson: '{"generatedArtifacts":[]}', createdAt: '2026-05-13T00:05:00.000Z' }] };
				}
				return { payload: [] };
			}),
			appendTaskEvent: vi.fn(),
		};
		const app = createTestApp({
			sdk: sdk as any,
			config: {
				projectId: 'treeseed-api-test',
				projectApiKey: 'project-secret',
			},
		});
		const headers = { authorization: 'Bearer project-secret' };

		const artifacts = await json(await app.request('/v1/agent-artifacts', { headers }));
		expect(artifacts.payload.items).toEqual(expect.arrayContaining([
			expect.objectContaining({ artifactKind: 'codebase_inventory', id: 'codebase_inventory:2026-05-13', taskId: 'task-scan-1' }),
			expect.objectContaining({ artifactKind: 'research_note', id: 'research:runtime-v1', taskId: 'task-research-1' }),
			expect.objectContaining({ artifactKind: 'knowledge_draft', id: 'knowledge:runtime', targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx' }),
			expect.objectContaining({ artifactKind: 'optimization_report', id: 'optimization:runtime', totalScore: 29 }),
			expect.objectContaining({ artifactKind: 'docs_mutation_result', id: 'task-promote-to-staging-1', mergedToStaging: true }),
		]));
		expect(artifacts.payload.warnings).toEqual(expect.arrayContaining([
			expect.stringContaining('Skipped malformed JSON'),
		]));

		const notes = await json(await app.request('/v1/research-notes', { headers }));
		expect(notes.payload.items[0].researchNote.id).toBe('research:runtime-v1');

		const drafts = await json(await app.request('/v1/knowledge-drafts', { headers }));
		expect(drafts.payload.items[0].knowledgeDraft.id).toBe('knowledge:runtime');

		const reports = await json(await app.request('/v1/optimization-reports', { headers }));
		expect(reports.payload.items[0].optimizationReport.id).toBe('optimization:runtime');

		const currentWorkday = await json(await app.request('/v1/workdays/current', { headers }));
		expect(currentWorkday.payload).toMatchObject({ id: 'workday-1', state: 'active' });

		const workdayReports = await json(await app.request('/v1/workdays/reports', { headers }));
		expect(workdayReports.payload.items[0]).toMatchObject({ id: 'report-1', body: { generatedArtifacts: [] } });
	});

	it('lists promotion approvals and records approval decisions without release side effects', async () => {
		const sdk = {
			searchTasks: vi.fn(async () => ({
				payload: [{
					id: 'task-promote-1',
					workDayId: 'workday-1',
					type: 'promote_knowledge_draft_request',
					state: 'pending',
					createdAt: '2026-05-13T00:00:00.000Z',
					updatedAt: '2026-05-13T00:00:00.000Z',
					payloadJson: JSON.stringify({
						promotionRequest: {
							id: 'promotion:knowledge-runtime',
							draftId: 'knowledge:runtime',
							targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
							recommendation: 'promote',
							totalScore: 29,
							sourceQuestionId: 'question:runtime',
							sourceResearchIds: ['research:runtime-v1'],
							optimizationReportId: 'optimization:runtime',
						},
					}),
				}],
			})),
			search: vi.fn(async () => ({ payload: [] })),
			appendTaskEvent: vi.fn(async () => ({ payload: { id: 'event-1' } })),
			listApprovalRequests: vi.fn(async () => ({
				payload: [{
					id: 'promotion:knowledge-persisted',
					teamId: 'team-1',
					projectId: 'treeseed-api-test',
					workDayId: 'workday-1',
					taskId: 'task-promote-persisted',
					kind: 'promote_knowledge_draft',
					state: 'pending',
					severity: 'medium',
					title: 'Promote persisted runtime knowledge',
					summary: 'Persisted approval waiting for human review.',
					options: [{ id: 'approve_as_book_content', label: 'Approve content' }],
					recommendation: { recommendation: 'promote', totalScore: 30 },
					policySnapshot: { approvalPolicy: 'manual' },
					metadata: {
						approvalKind: 'promote_knowledge_draft',
						draftId: 'knowledge:persisted-runtime',
						targetPath: 'src/content/knowledge/architecture/runtime/persisted.mdx',
						sourceMapRefs: [{ claim: 'Runtime claim', sourceFiles: ['packages/agent/src/services/worker.ts'] }],
						artifactRefs: [{ artifactKind: 'knowledge_draft', id: 'knowledge:persisted-runtime' }],
						verificationPlan: { commands: [], sourceMapRequired: true },
						promotionRequest: {
							id: 'promotion:knowledge-persisted',
							draftId: 'knowledge:persisted-runtime',
							targetPath: 'src/content/knowledge/architecture/runtime/persisted.mdx',
							recommendation: 'promote',
						},
					},
					decision: null,
					createdAt: '2026-05-13T00:00:00.000Z',
					updatedAt: '2026-05-13T00:00:00.000Z',
				}],
			})),
			decideApprovalRequest: vi.fn(async (id: string, request: any) => ({
				payload: {
					id,
					teamId: 'team-1',
					projectId: 'treeseed-api-test',
					workDayId: 'workday-1',
					taskId: 'task-promote-1',
					kind: 'promote_knowledge_draft',
					state: request.state,
					severity: 'medium',
					title: 'Promote runtime knowledge',
					summary: 'Decision recorded.',
					options: [],
					recommendation: {},
					policySnapshot: {},
					metadata: {},
					decision: request.decision,
					createdAt: '2026-05-13T00:00:00.000Z',
					updatedAt: '2026-05-13T00:01:00.000Z',
				},
			})),
			upsertTeamInboxItem: vi.fn(async (request) => ({ payload: request })),
		};
		const app = createTestApp({
			sdk: sdk as any,
			config: {
				projectId: 'treeseed-api-test',
				projectApiKey: 'project-secret',
			},
		});
		const headers = { authorization: 'Bearer project-secret' };

		const approvals = await json(await app.request('/v1/approvals', { headers }));
		expect(approvals.payload.items).toEqual(expect.arrayContaining([expect.objectContaining({
			id: 'promotion:knowledge-persisted',
			state: 'pending',
			severity: 'medium',
			sourceMapRefs: [expect.objectContaining({ claim: 'Runtime claim' })],
			policySnapshot: { approvalPolicy: 'manual' },
		}), expect.objectContaining({
			id: 'promotion:knowledge-runtime',
			taskId: 'task-promote-1',
			draftId: 'knowledge:runtime',
		})]));

		const persistedDetail = await json(await app.request('/v1/approvals/promotion%3Aknowledge-persisted', { headers }));
		expect(persistedDetail.payload.approval).toMatchObject({
			id: 'promotion:knowledge-persisted',
			draftId: 'knowledge:persisted-runtime',
			state: 'pending',
			verificationPlan: { commands: [], sourceMapRequired: true },
		});

		for (const allowedDecision of ['approve', 'request_changes', 'defer', 'reject']) {
			const decision = await app.request('/v1/approvals/promotion%3Aknowledge-runtime/decision', {
				method: 'POST',
				headers: {
					...headers,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ decision: allowedDecision, reason: 'Needs source review.' }),
			});

			expect(decision.status).toBe(200);
			const canonicalDecision = allowedDecision === 'approve'
				? 'approve_as_book_content'
				: allowedDecision === 'request_changes'
					? 'request_more_research'
					: allowedDecision;
			expect(sdk.appendTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
				taskId: 'task-promote-1',
				kind: 'approval_decision_recorded',
				data: expect.objectContaining({
					decision: canonicalDecision,
					releaseAttempted: false,
					stagingAttempted: false,
				}),
			}));
		}
		expect(sdk.decideApprovalRequest).toHaveBeenCalledWith('promotion:knowledge-runtime', expect.objectContaining({
			state: 'approved',
			optionId: 'approve_as_book_content',
		}));
		expect(sdk.decideApprovalRequest).toHaveBeenCalledWith('promotion:knowledge-runtime', expect.objectContaining({
			state: 'changes_requested',
			optionId: 'request_more_research',
		}));
		expect(sdk.decideApprovalRequest).toHaveBeenCalledWith('promotion:knowledge-runtime', expect.objectContaining({
			state: 'deferred',
			optionId: 'defer',
		}));
		expect(sdk.upsertTeamInboxItem).toHaveBeenCalledWith(expect.objectContaining({
			id: 'approval:promotion:knowledge-runtime',
			state: 'action_required',
		}));

		const beforeInvalidCount = sdk.appendTaskEvent.mock.calls.length;
		const invalidDecision = await app.request('/v1/approvals/promotion%3Aknowledge-runtime/decision', {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ decision: 'publish_release' }),
		});
		expect(invalidDecision.status).toBe(400);
		expect(sdk.appendTaskEvent).toHaveBeenCalledTimes(beforeInvalidCount);

		const unknownApproval = await app.request('/v1/approvals/unknown/decision', {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ decision: 'reject' }),
		});
		expect(unknownApproval.status).toBe(404);
	});

	it('lists operation grants/events and performs policy-only operation dry-runs', async () => {
		const operationGrant = {
			id: 'grant-stage-docs',
			state: 'active',
			operations: ['stage'],
			modes: ['dry_run'],
			agentRoles: ['reviewer'],
			taskKinds: ['implementation'],
			projectIds: ['treeseed-api-test'],
			environments: ['local'],
			allowedPaths: ['docs/**'],
			forbiddenPaths: ['secrets/**'],
		};
		const sdk = {
			searchTasks: vi.fn(async () => ({
				payload: [{
					id: 'task-ops-1',
					workDayId: 'workday-1',
					type: 'implementation',
					state: 'completed',
					payloadJson: JSON.stringify({ operationGrants: [operationGrant] }),
				}],
			})),
			search: vi.fn(async (request) => {
				if (request.model === 'task_output') {
					return {
						payload: [{
							id: 'output-ops-1',
							taskId: 'task-ops-1',
							outputJson: JSON.stringify({
								operationResults: [{
									operation: 'save',
									status: 'completed',
									summary: 'Saved verified snapshot.',
									changedPaths: ['docs/guide.md'],
									stagedPaths: [],
								}],
								snapshots: [{
									kind: 'verified_snapshot',
									ref: 'snapshot:task-ops-1',
									changedPaths: ['docs/guide.md'],
								}],
								mergedToStaging: true,
								mergeCommitSha: 'abc123',
								changedPaths: ['docs/guide.md'],
								releaseResult: {
									status: 'completed',
									releaseTag: 'v1.0.1',
								},
								codexResult: {
									provider: 'codex',
									threadId: 'thread-1',
									status: 'completed',
									usage: { wallMs: 20 },
								},
							}),
						}],
					};
				}
				if (request.model === 'task_event') {
					return {
						payload: [{
							id: 'event-ops-1',
							taskId: 'task-ops-1',
							kind: 'operation_event',
							seq: 1,
							createdAt: '2026-05-13T00:00:00.000Z',
							dataJson: JSON.stringify({
								operation: 'stage',
								mode: 'dry_run',
								agentRole: 'reviewer',
								permissionGrantId: 'grant-stage-docs',
								result: {
									operation: 'stage',
									status: 'completed',
									summary: 'Policy allowed staging.',
									changedPaths: ['docs/guide.md'],
									stagedPaths: ['docs/guide.md'],
								},
							}),
						}],
					};
				}
				if (request.model === 'work_day') {
					return { payload: [{ id: 'workday-1', projectId: 'treeseed-api-test', state: 'active' }] };
				}
				if (request.model === 'report') {
					return { payload: [] };
				}
				return { payload: [] };
			}),
			appendTaskEvent: vi.fn(),
		};
		const app = createTestApp({
			sdk: sdk as any,
			config: {
				projectId: 'treeseed-api-test',
				projectApiKey: 'project-secret',
			},
		});
		const headers = { authorization: 'Bearer project-secret' };

		const grants = await json(await app.request('/v1/operations/grants', { headers }));
		expect(grants.payload.items).toEqual([expect.objectContaining({
			id: 'grant-stage-docs',
			operations: ['stage'],
			allowedPaths: ['docs/**'],
		})]);

		const events = await json(await app.request('/v1/operations/events', { headers }));
		expect(events.payload.items).toEqual(expect.arrayContaining([
			expect.objectContaining({
				operation: 'save',
				status: 'completed',
				source: 'task_output',
			}),
			expect.objectContaining({
				operation: 'stage',
				status: 'completed',
				source: 'task_event',
			}),
		]));
		expect(events.payload.lifecycle).toMatchObject({
			worktreeSnapshots: [expect.objectContaining({ kind: 'verified_snapshot' })],
			stagingMerges: [expect.objectContaining({ mergedToStaging: true, commitSha: 'abc123' })],
			releaseResults: [expect.objectContaining({ releaseTag: 'v1.0.1' })],
			codexUsage: [expect.objectContaining({ provider: 'codex', threadId: 'thread-1' })],
		});

		const dryRun = await json(await app.request('/v1/operations/stage/dry-run', {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				request: {
					mode: 'dry_run',
					taskId: 'task-ops-1',
					taskKind: 'implementation',
					agentRole: 'reviewer',
					changedPaths: ['docs/guide.md'],
				},
			}),
		}));
		expect(dryRun.payload).toMatchObject({
			dryRun: true,
			decision: { allowed: true },
			result: { status: 'completed', stagedPaths: ['docs/guide.md'] },
		});

		const denied = await json(await app.request('/v1/operations/stage/dry-run', {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				request: {
					mode: 'dry_run',
					taskId: 'task-ops-1',
					taskKind: 'implementation',
					agentRole: 'reviewer',
					changedPaths: ['secrets/token.txt'],
				},
			}),
		}));
		expect(denied.payload).toMatchObject({
			dryRun: true,
			decision: {
				allowed: false,
				code: 'operation_path_forbidden',
			},
			result: { status: 'failed' },
		});
	});

	it('enqueues approved knowledge promotion tasks and gates release decisions with a second approval', async () => {
		const knowledgeDraft = {
			id: 'knowledge:runtime',
			kind: 'knowledge_draft',
			title: 'Runtime',
			book: 'architecture',
			section: 'runtime',
			targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
			state: 'draft',
			sourceQuestionId: 'question:runtime',
			sourceResearchIds: ['research:runtime-v1'],
			frontmatter: {
				type: 'architecture',
				title: 'Runtime',
				summary: 'Runtime knowledge.',
				status: 'pending_review',
				generated_by: 'treeseed-agent',
				agent_role: 'knowledge_generator',
				source_question: 'question:runtime',
				source_research: ['research:runtime-v1'],
				review_state: 'pending_review',
				book_target: 'architecture',
				section_target: 'runtime',
				confidence: 'medium',
				source_map: [{
					claim: 'Runtime knowledge is grounded in worker code.',
					sourceFiles: ['packages/agent/src/services/worker.ts'],
					sourceSymbolsOrSections: ['runWorkerCycle'],
					evidenceStrength: 'direct',
					uncertainty: '',
					lastObservedRef: 'graph-1',
				}],
				updated: '2026-05-13',
				related: { objectives: [], questions: ['question:runtime'], proposals: [], decisions: [] },
			},
			body: [
				'# Runtime',
				'',
				'## What this explains',
				'Runtime knowledge.',
				'',
				'## Current implementation',
				'Grounded in worker code.',
				'',
				'## Main flow',
				'The worker runs tasks.',
				'',
				'## Important files',
				'- packages/agent/src/services/worker.ts',
				'',
				'## Source map',
				'- Runtime knowledge is grounded in worker code. (packages/agent/src/services/worker.ts)',
				'',
				'## Governance and safety boundaries',
				'Pending review.',
				'',
				'## Open questions',
				'- None recorded.',
				'',
				'## Verification notes',
				'Review source map before promotion.',
			].join('\n'),
			reviewState: 'pending_review',
			createdAt: '2026-05-13T00:00:00.000Z',
			updatedAt: '2026-05-13T00:00:00.000Z',
		};
		const researchNote = {
			id: 'research:runtime-v1',
			kind: 'research_note',
			questionId: 'question:runtime',
			state: 'draft',
			contextQueries: [],
			contextPackSummary: 'Runtime context.',
			sourceRefs: [{ ref: 'packages/agent/src/services/worker.ts', kind: 'path', title: 'Worker' }],
			sourceMap: [{
				claim: 'Runtime knowledge is grounded in worker code.',
				sourceFiles: ['packages/agent/src/services/worker.ts'],
				sourceSymbolsOrSections: ['runWorkerCycle'],
				evidenceStrength: 'direct',
				uncertainty: '',
				lastObservedRef: 'graph-1',
			}],
			observedFacts: ['The worker runs knowledge tasks.'],
			inferences: [],
			uncertainties: [],
			recommendedKnowledgeArtifacts: [],
			recommendedImplementationProposal: null,
			createdAt: '2026-05-13T00:00:00.000Z',
		};
		const optimizationReport = {
			id: 'optimization:runtime',
			kind: 'knowledge_optimization_report',
			draftId: knowledgeDraft.id,
			score: {
				factual_grounding: 5,
				book_fit: 4,
				structure: 5,
				future_agent_usefulness: 4,
				human_reviewability: 4,
				link_quality: 3,
				uncertainty_visibility: 3,
			},
			totalScore: 28,
			recommendation: 'promote',
			remainingIssues: [],
			criticalIssues: [],
			createdAt: '2026-05-13T00:00:00.000Z',
		};
		const sdk = {
			searchTasks: vi.fn(async () => ({
				payload: [
					{
						id: 'task-research-1',
						workDayId: 'workday-1',
						type: 'research_question',
						state: 'completed',
						payloadJson: '{}',
					},
					{
						id: 'task-draft-1',
						workDayId: 'workday-1',
						type: 'generate_knowledge_draft',
						state: 'completed',
						payloadJson: '{}',
					},
					{
						id: 'task-promote-1',
						workDayId: 'workday-1',
						type: 'promote_knowledge_draft_request',
						state: 'waiting',
						payloadJson: JSON.stringify({
							promotionRequest: {
								id: 'promotion:knowledge-runtime',
								approvalKind: 'promote_knowledge_draft',
								draftId: 'knowledge:runtime',
								targetPath: knowledgeDraft.targetPath,
								recommendation: 'promote',
								sourceResearchIds: ['research:runtime-v1'],
								optimizationReportId: 'optimization:runtime',
							},
						}),
					},
					{
						id: 'task-release-1',
						workDayId: 'workday-1',
						type: 'release_staged_knowledge_request',
						state: 'waiting',
						payloadJson: JSON.stringify({
							releaseRequest: {
								id: 'release:knowledge:runtime',
								approvalKind: 'release_staged_knowledge',
								draftId: 'knowledge:runtime',
								targetPath: knowledgeDraft.targetPath,
								recommendation: 'approve_release',
								changedPaths: [knowledgeDraft.targetPath],
								releaseInput: { bump: 'patch' },
							},
						}),
					},
				],
			})),
			search: vi.fn(async (request) => {
				if (request.model === 'task_output') {
					return {
						payload: [
							{
								id: 'output-research-1',
								taskId: 'task-research-1',
								outputJson: JSON.stringify({ researchNote }),
							},
							{
								id: 'output-draft-1',
								taskId: 'task-draft-1',
								outputJson: JSON.stringify({ knowledgeDraft }),
							},
							{
								id: 'output-optimize-1',
								taskId: 'task-promote-1',
								outputJson: JSON.stringify({ optimizationReport }),
							},
						],
					};
				}
				if (request.model === 'work_day') {
					return { payload: [{ id: 'workday-1', state: 'active' }] };
				}
				return { payload: [] };
			}),
			appendTaskEvent: vi.fn(async () => ({ payload: { id: 'event-1' } })),
			createTask: vi.fn(async (request) => ({
				payload: {
					id: request.type === 'generate_knowledge_draft' ? 'task-revise-draft-1' : 'task-promote-to-staging-1',
					type: request.type,
					workDayId: request.workDayId,
					payloadJson: JSON.stringify(request.payload),
				},
			})),
			decideApprovalRequest: vi.fn(async (id: string, request: any) => ({
				payload: {
					id,
					teamId: 'team-1',
					projectId: 'project-1',
					workDayId: 'workday-1',
					taskId: 'task-promote-1',
					kind: 'promote_knowledge_draft',
					state: request.state,
					severity: 'medium',
					title: 'Promote runtime knowledge',
					summary: 'Decision recorded.',
					options: [],
					recommendation: {},
					policySnapshot: {},
					metadata: {},
					decision: request.decision,
					createdAt: '2026-05-13T00:00:00.000Z',
					updatedAt: '2026-05-13T00:01:00.000Z',
				},
			})),
			upsertTeamInboxItem: vi.fn(async (request: any) => ({ payload: request })),
		};
		const operations = {
			runOperation: vi.fn(async () => ({
				operation: 'release',
				status: 'completed',
				summary: 'released',
				changedPaths: [knowledgeDraft.targetPath],
				stagedPaths: [],
				commandsRun: ['release'],
				artifacts: [],
				metadata: { workflowResult: { payload: { releaseTag: 'v1.0.1' } } },
			})),
		};

		const promotion = await recordAgentApprovalDecision({
			sdk: sdk as any,
			projectId: 'project-1',
			approvalId: 'promotion:knowledge-runtime',
			decision: 'approve_as_book_content',
			reason: 'Looks good.',
			actor: 'user-1',
			actorType: 'user',
			repoRoot: '/repo',
			operations: operations as any,
		});
		expect(promotion?.createdTask).toEqual(expect.objectContaining({
			id: 'task-promote-to-staging-1',
			type: 'promote_knowledge_to_staging',
		}));
		expect(sdk.createTask).toHaveBeenCalledWith(expect.objectContaining({
			type: 'promote_knowledge_to_staging',
			payload: expect.objectContaining({
				knowledgeDraft,
				allowedPaths: [knowledgeDraft.targetPath],
				forbiddenPaths: expect.arrayContaining(['**/node_modules/**', 'src/lib/**', 'packages/sdk/drizzle/**']),
				verificationCommands: [],
				approval: expect.objectContaining({ id: 'promotion:knowledge-runtime', state: 'approved' }),
				policySnapshot: expect.any(Object),
			}),
		}));

		sdk.createTask.mockClear();
		const requestedChanges = await recordAgentApprovalDecision({
			sdk: sdk as any,
			projectId: 'project-1',
			approvalId: 'promotion:knowledge-runtime',
			decision: 'request_changes',
			reason: 'Clarify the worker source map.',
			actor: 'user-1',
			actorType: 'user',
			repoRoot: '/repo',
			operations: operations as any,
		});
		expect(requestedChanges?.state).toBe('changes_requested');
		expect(requestedChanges?.createdTask).toEqual(expect.objectContaining({
			id: 'task-revise-draft-1',
			type: 'generate_knowledge_draft',
		}));
		expect(sdk.createTask).toHaveBeenCalledWith(expect.objectContaining({
			type: 'generate_knowledge_draft',
			idempotencyKey: 'workday-1:generate_knowledge_draft_revision:promotion:knowledge-runtime',
			payload: expect.objectContaining({
				researchNote,
				previousKnowledgeDraft: knowledgeDraft,
				optimizationReport,
				revisionOfDraftId: knowledgeDraft.id,
			}),
		}));
		expect(sdk.decideApprovalRequest).toHaveBeenCalledWith('promotion:knowledge-runtime', expect.objectContaining({
			state: 'changes_requested',
			optionId: 'request_more_research',
		}));

		const release = await recordAgentApprovalDecision({
			sdk: sdk as any,
			projectId: 'project-1',
			approvalId: 'release:knowledge:runtime',
			decision: 'approve_release',
			actor: 'user-1',
			actorType: 'user',
			repoRoot: '/repo',
			operations: operations as any,
		});
		expect(release?.releaseAttempted).toBe(true);
		expect(operations.runOperation).toHaveBeenCalledWith(expect.objectContaining({
			request: expect.objectContaining({
				operation: 'release',
				input: { bump: 'patch' },
				approval: expect.objectContaining({ state: 'approved' }),
			}),
		}));

		await expect(recordAgentApprovalDecision({
			sdk: sdk as any,
			projectId: 'project-1',
			approvalId: 'release:knowledge:runtime',
			decision: 'approve_release',
			actor: 'service-1',
			actorType: 'service',
			repoRoot: '/repo',
			operations: operations as any,
		})).rejects.toMatchObject({
			status: 403,
		} satisfies Partial<AgentApprovalDecisionError>);
	});

	it('reports Codex readiness through the project runtime API without starting a thread', async () => {
		vi.stubEnv('TREESEED_EXECUTION_PROVIDER', 'codex_subscription');
		const app = createTestApp({
			config: {
				projectApiKey: 'project-secret',
			},
		});

		const response = await app.request('/v1/providers/codex/readiness', {
			headers: { authorization: 'Bearer project-secret' },
		});

		expect(response.status).toBe(200);
		expect(await json(response)).toMatchObject({
			ok: true,
			payload: {
				subscriptionPlan: expect.any(String),
				sdkInstalled: expect.any(Boolean),
				warnings: expect.any(Array),
				blockingIssues: expect.any(Array),
			},
		});
	});

	it('mounts internal project routes behind a prefix and accepts project API keys', async () => {
		const app = createTestApp({
			internalPrefix: '/internal/core',
			config: {
				projectId: 'project-api-test',
				projectApiKey: 'project-secret',
				projectApiPermissions: ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
			},
		});

		const publicResponse = await app.request('/sdk/startWorkDay', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				input: {
					projectId: 'project-api-test',
					capacityBudget: 3,
					actor: 'project-key',
				},
			}),
		});
		expect(publicResponse.status).toBe(404);

		const internalResponse = await app.request('/internal/core/sdk/startWorkDay', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer project-secret',
			},
			body: JSON.stringify({
				input: {
					projectId: 'project-api-test',
					capacityBudget: 3,
					actor: 'project-key',
				},
			}),
		});
		expect(internalResponse.status).toBe(200);
		expect(await json(internalResponse)).toMatchObject({
			ok: true,
			model: 'work_day',
			operation: 'create',
			payload: {
				projectId: 'project-api-test',
			},
		});

		const internalAgentHealth = await app.request('/internal/core/agent/healthz');
		expect(internalAgentHealth.status).toBe(200);

		const publicAgentHealth = await app.request('/agent/healthz');
		expect(publicAgentHealth.status).toBe(404);
	});

	it('runs the device-code lifecycle and injects bearer principals', async () => {
		const app = createTestApp();

		const started = await json(await app.request('/auth/device/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				clientName: 'test-cli',
				scopes: ['auth:me', 'sdk', 'operations', 'agent'],
			}),
		}));

		const pending = await app.request('/auth/device/poll', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ deviceCode: started.deviceCode }),
		});
		expect(pending.status).toBe(200);
		expect(await json(pending)).toMatchObject({ ok: true, status: 'pending' });

		const approved = await app.request('/auth/device/approve', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				userCode: started.userCode,
				principalId: 'user-123',
				displayName: 'CLI User',
				scopes: ['auth:me', 'sdk', 'operations', 'agent'],
			}),
		});
		expect(approved.status).toBe(200);

		const polled = await json(await app.request('/auth/device/poll', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ deviceCode: started.deviceCode }),
		}));
		expect(polled).toMatchObject({
			ok: true,
			status: 'approved',
			tokenType: 'Bearer',
		});

		const me = await app.request('/auth/me', {
			headers: {
				authorization: `Bearer ${polled.accessToken}`,
			},
		});
		expect(me.status).toBe(200);
		expect(await json(me)).toMatchObject({
			ok: true,
			payload: {
				id: 'user-123',
				displayName: 'CLI User',
				roles: ['member'],
			},
		});

		const refreshed = await app.request('/auth/token/refresh', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ refreshToken: polled.refreshToken }),
		});
		expect(refreshed.status).toBe(200);
		expect(await json(refreshed)).toMatchObject({ ok: true, tokenType: 'Bearer' });
	});

	it('syncs browser identities, issues PATs, and exchanges trusted web users', async () => {
		const app = createTestApp({
			config: {
				bootstrapAdminAllowlist: ['owner@example.com'],
			},
		});

		const synced = await app.request('/internal/auth/web/sync-user', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({
				provider: 'github',
				providerSubject: 'github-user-1',
				email: 'owner@example.com',
				emailVerified: true,
				displayName: 'Owner User',
				profile: { login: 'owner' },
			}),
		});
		expect(synced.status).toBe(200);
		const syncedPayload = await json(synced);
		expect(syncedPayload.payload.principal.roles).toEqual(expect.arrayContaining(['member', 'platform_admin']));

		const exchanged = await app.request('/internal/auth/web/exchange', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({
				userId: syncedPayload.payload.principal.id,
				sessionId: 'session-1',
				identityId: syncedPayload.payload.identityId,
				authTime: '2026-04-12T00:00:00.000Z',
				expiresAt: '2099-04-12T00:05:00.000Z',
				nonce: 'nonce-1',
			}),
		});
		expect(exchanged.status).toBe(200);
		const exchangePayload = await json(exchanged);
		expect(exchangePayload.principal.id).toBe(syncedPayload.payload.principal.id);

		const patResponse = await app.request('/auth/pat', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${exchangePayload.accessToken}`,
			},
			body: JSON.stringify({ name: 'CLI Token', scopes: ['auth:me', 'sdk'] }),
		});
		expect(patResponse.status).toBe(200);
		const patPayload = await json(patResponse);
		expect(patPayload.payload.token).toMatch(/^pat_/);

		const patList = await app.request('/auth/pat', {
			headers: {
				authorization: `Bearer ${patPayload.payload.token}`,
			},
		});
		expect(patList.status).toBe(200);
		expect((await json(patList)).payload[0].name).toBe('CLI Token');
	});

	it('delegates sdk operations using canonical operation names', async () => {
		const { app, token } = await authorizeApp(['sdk', 'auth:me']);

		const response = await app.request('/sdk/startWorkDay', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				repoRoot: packageRoot,
				input: {
					projectId: 'treeseed-api-test',
					capacityBudget: 5,
					actor: 'api-test',
				},
			}),
		});

		expect(response.status).toBe(200);
		const payload = await json(response);
		expect(payload.ok).toBe(true);
		expect(payload.operation).toBe('create');
		expect(payload.model).toBe('work_day');
		expect(payload.payload.projectId).toBe('treeseed-api-test');
	});

	it('exposes graph-dispatch sdk operations that do not require the full workspace fixture', async () => {
		const { app, token } = await authorizeApp(['sdk', 'auth:me']);

		const parseResponse = await app.request('/sdk/parseGraphDsl', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				repoRoot: packageRoot,
				input: {
					source: 'ctx "market architecture" for plan in /knowledge via related,references depth 1 budget 400 as brief',
				},
			}),
		});
		expect(parseResponse.status).toBe(200);
		const parsePayload = await json(parseResponse);
		expect(parsePayload.query).toMatchObject({ stage: 'plan', view: 'brief' });
	});

	it('delegates workflow operations through the shared sdk workflow runtime', async () => {
		const app = createTestApp({
			config: createTestConfig(),
			workflowExecutor: async (operation) => ({
				ok: true,
				operation,
				payload: {
					mode: 'stubbed-test',
				},
			}),
		});
		const started = await json(await app.request('/auth/device/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ scopes: ['operations', 'auth:me'] }),
		}));
		await app.request('/auth/device/approve', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				userCode: started.userCode,
				principalId: 'ops-user',
				scopes: ['operations', 'auth:me'],
			}),
		});
		const tokenPayload = await json(await app.request('/auth/device/poll', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ deviceCode: started.deviceCode }),
		}));

		const response = await app.request('/operations/status', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${tokenPayload.accessToken}`,
			},
			body: JSON.stringify({
				cwd: packageRoot,
			}),
		});

		expect(response.status).toBe(200);
		const payload = await json(response);
		expect(payload.operation).toBe('status');
		expect(payload.ok).toBe(true);
		expect(payload.payload).toMatchObject({ mode: 'stubbed-test' });
	});

	it('queues remote-job workflow operations and reports warm worker capacity', async () => {
		vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'cf-test-account');
		vi.stubEnv('TREESEED_QUEUE_ID', 'queue-123');
		vi.stubEnv('TREESEED_QUEUE_PUSH_TOKEN', 'queue-secret');
		vi.stubEnv('TREESEED_WORKER_POOL_SCALER', 'railway');
		vi.stubEnv('TREESEED_RAILWAY_WORKER_SERVICE_ID', 'svc-worker');
		vi.stubEnv('TREESEED_RAILWAY_ENVIRONMENT_ID', 'env-test');
		vi.stubEnv('RAILWAY_API_TOKEN', 'railway-token');
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith('/messages')) {
				return new Response(JSON.stringify({ success: true, result: {} }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response(JSON.stringify({
				data: {
					serviceInstanceUpdate: {
						id: 'svc-inst-1',
					},
				},
			}), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		vi.stubGlobal('fetch', fetchMock);
		const sdk = {
			createTask: vi.fn(async () => ({
				payload: {
					id: 'task-remote-1',
					type: 'workflow_dispatch',
					state: 'pending',
				},
			})),
			get: vi.fn(async () => ({
				payload: {
					id: 'task-remote-1',
					workDayId: '',
					agentId: 'workflow-dispatch',
					type: 'workflow_dispatch',
					idempotencyKey: 'workflow:verify:test',
					attemptCount: 0,
					graphVersion: null,
				},
			})),
			searchTasks: vi.fn(async (request) => ({
				payload: Array.isArray(request.state) && request.state.includes('queued')
					? [{
						id: 'task-remote-1',
						state: 'queued',
						payloadJson: JSON.stringify({ estimatedCredits: 1 }),
					}]
					: [],
			})),
			getLatestScaleDecision: vi.fn(async () => ({
				payload: {
					id: 'scale-prev',
					projectId: 'treeseed-market',
					environment: 'local',
					poolName: 'treeseed-market-local',
					workDayId: null,
					desiredWorkers: 1,
					observedQueueDepth: 0,
					observedActiveLeases: 0,
					reason: 'reconcile',
					metadata: {},
					createdAt: '2026-04-15T12:59:00.000Z',
				},
			})),
			recordScaleDecision: vi.fn(async (request) => ({ payload: { id: 'scale-1', ...request, createdAt: '2026-04-15T13:00:00.000Z' } })),
			recordTaskProgress: vi.fn(async () => ({ payload: { id: 'task-remote-1', state: 'queued' } })),
		};
		try {
			const app = createTestApp({
				sdk: sdk as any,
				workflowExecutor: async () => {
					throw new Error('remote job should not execute inline');
				},
			});
			const started = await json(await app.request('/auth/device/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scopes: ['operations', 'auth:me'] }),
			}));
			await app.request('/auth/device/approve', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userCode: started.userCode,
					principalId: 'ops-user',
					scopes: ['operations', 'auth:me'],
				}),
			});
			const tokenPayload = await json(await app.request('/auth/device/poll', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deviceCode: started.deviceCode }),
			}));

			const response = await app.request('/operations/save', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${tokenPayload.accessToken}`,
				},
				body: JSON.stringify({
					input: { message: 'checkpoint' },
				}),
			});

			expect(response.status).toBe(202);
			expect(await json(response)).toMatchObject({
				ok: true,
				mode: 'task',
				operation: 'save',
				workerState: 'warm',
				capacity: {
					desiredWorkers: 1,
					scaleApplied: true,
					reason: 'interactive_enqueue',
				},
				payload: {
					id: 'task-remote-1',
					type: 'workflow_dispatch',
				},
			});
			expect(sdk.createTask).toHaveBeenCalledWith(expect.objectContaining({
				type: 'workflow_dispatch',
				agentId: 'workflow-dispatch',
				payload: expect.objectContaining({
					executionKind: 'workflow_dispatch',
					namespace: 'workflow',
					operation: 'save',
					input: { message: 'checkpoint' },
				}),
			}));
			expect(sdk.recordTaskProgress).toHaveBeenCalledWith(expect.objectContaining({
				id: 'task-remote-1',
				state: 'queued',
			}));
			expect(sdk.recordScaleDecision).toHaveBeenCalledWith(expect.objectContaining({
				desiredWorkers: 1,
				reason: 'interactive_enqueue',
			}));
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(fetchMock.mock.calls.some(([input]) => String(input).includes('backboard.railway.com/graphql'))).toBe(true);
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
	});

	it('queues remote-job workflow operations and reports cold-starting worker capacity', async () => {
		vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'cf-test-account');
		vi.stubEnv('TREESEED_QUEUE_ID', 'queue-123');
		vi.stubEnv('TREESEED_QUEUE_PUSH_TOKEN', 'queue-secret');
		vi.stubEnv('TREESEED_WORKER_POOL_SCALER', 'railway');
		vi.stubEnv('TREESEED_RAILWAY_WORKER_SERVICE_ID', 'svc-worker');
		vi.stubEnv('TREESEED_RAILWAY_ENVIRONMENT_ID', 'env-test');
		vi.stubEnv('RAILWAY_API_TOKEN', 'railway-token');
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith('/messages')) {
				return new Response(JSON.stringify({ success: true, result: {} }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response(JSON.stringify({
				data: {
					serviceInstanceUpdate: {
						id: 'svc-inst-1',
					},
				},
			}), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		vi.stubGlobal('fetch', fetchMock);
		const sdk = {
			createTask: vi.fn(async () => ({
				payload: {
					id: 'task-remote-cold',
					type: 'workflow_dispatch',
					state: 'pending',
				},
			})),
			get: vi.fn(async () => ({
				payload: {
					id: 'task-remote-cold',
					workDayId: '',
					agentId: 'workflow-dispatch',
					type: 'workflow_dispatch',
					idempotencyKey: 'workflow:verify:cold',
					attemptCount: 0,
					graphVersion: null,
				},
			})),
			searchTasks: vi.fn(async (request) => ({
				payload: Array.isArray(request.state) && request.state.includes('queued')
					? [{
						id: 'task-remote-cold',
						state: 'queued',
						payloadJson: JSON.stringify({ estimatedCredits: 1 }),
					}]
					: [],
			})),
			getLatestScaleDecision: vi.fn(async () => ({
				payload: {
					id: 'scale-prev',
					projectId: 'treeseed-market',
					environment: 'local',
					poolName: 'treeseed-market-local',
					workDayId: null,
					desiredWorkers: 0,
					observedQueueDepth: 0,
					observedActiveLeases: 0,
					reason: 'cooldown_hold',
					metadata: {},
					createdAt: '2026-04-15T12:59:50.000Z',
				},
			})),
			recordScaleDecision: vi.fn(async (request) => ({ payload: { id: 'scale-2', ...request, createdAt: '2026-04-15T13:00:00.000Z' } })),
			recordTaskProgress: vi.fn(async () => ({ payload: { id: 'task-remote-cold', state: 'queued' } })),
		};
		try {
			const app = createTestApp({
				sdk: sdk as any,
				workflowExecutor: async () => {
					throw new Error('remote job should not execute inline');
				},
			});
			const started = await json(await app.request('/auth/device/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scopes: ['operations', 'auth:me'] }),
			}));
			await app.request('/auth/device/approve', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userCode: started.userCode,
					principalId: 'ops-user',
					scopes: ['operations', 'auth:me'],
				}),
			});
			const tokenPayload = await json(await app.request('/auth/device/poll', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deviceCode: started.deviceCode }),
			}));

			const response = await app.request('/operations/save', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${tokenPayload.accessToken}`,
				},
				body: JSON.stringify({
					input: { message: 'cold-start' },
				}),
			});

			expect(response.status).toBe(202);
			expect(await json(response)).toMatchObject({
				ok: true,
				mode: 'task',
				operation: 'save',
				workerState: 'cold_starting',
				capacity: {
					desiredWorkers: 1,
					scaleApplied: true,
					reason: 'interactive_cold_start',
				},
				payload: {
					id: 'task-remote-cold',
				},
			});
			expect(sdk.recordScaleDecision).toHaveBeenCalledWith(expect.objectContaining({
				desiredWorkers: 1,
				reason: 'interactive_cold_start',
			}));
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
	});

	it('accepts remote-job workflow operations even when scaling is unapplied', async () => {
		vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'cf-test-account');
		vi.stubEnv('TREESEED_QUEUE_ID', 'queue-123');
		vi.stubEnv('TREESEED_QUEUE_PUSH_TOKEN', 'queue-secret');
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, result: {} }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		}));
		vi.stubGlobal('fetch', fetchMock);
		const sdk = {
			createTask: vi.fn(async () => ({
				payload: {
					id: 'task-remote-no-scale',
					type: 'workflow_dispatch',
					state: 'pending',
				},
			})),
			get: vi.fn(async () => ({
				payload: {
					id: 'task-remote-no-scale',
					workDayId: '',
					agentId: 'workflow-dispatch',
					type: 'workflow_dispatch',
					idempotencyKey: 'workflow:verify:no-scale',
					attemptCount: 0,
					graphVersion: null,
				},
			})),
			searchTasks: vi.fn(async (request) => ({
				payload: Array.isArray(request.state) && request.state.includes('queued')
					? [{
						id: 'task-remote-no-scale',
						state: 'queued',
						payloadJson: JSON.stringify({ estimatedCredits: 1 }),
					}]
					: [],
			})),
			getLatestScaleDecision: vi.fn(async () => ({ payload: null })),
			recordScaleDecision: vi.fn(async (request) => ({ payload: { id: 'scale-3', ...request, createdAt: '2026-04-15T13:00:00.000Z' } })),
			recordTaskProgress: vi.fn(async () => ({ payload: { id: 'task-remote-no-scale', state: 'queued' } })),
		};
		try {
			const app = createTestApp({
				sdk: sdk as any,
				workflowExecutor: async () => {
					throw new Error('remote job should not execute inline');
				},
			});
			const started = await json(await app.request('/auth/device/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scopes: ['operations', 'auth:me'] }),
			}));
			await app.request('/auth/device/approve', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userCode: started.userCode,
					principalId: 'ops-user',
					scopes: ['operations', 'auth:me'],
				}),
			});
			const tokenPayload = await json(await app.request('/auth/device/poll', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deviceCode: started.deviceCode }),
			}));

			const response = await app.request('/operations/save', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${tokenPayload.accessToken}`,
				},
				body: JSON.stringify({
					input: { message: 'accepted' },
				}),
			});

			expect(response.status).toBe(202);
			expect(await json(response)).toMatchObject({
				ok: true,
				mode: 'task',
				operation: 'save',
				workerState: 'cold_starting',
				capacity: {
					desiredWorkers: 1,
					scaleApplied: false,
					reason: 'interactive_cold_start',
				},
				payload: {
					id: 'task-remote-no-scale',
				},
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
	});

	it('exposes the agent surface on the main api app', async () => {
		const { app, token } = await authorizeApp(['agent', 'auth:me']);

		const started = await app.request('/agent/workdays/start', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ capacityBudget: 25 }),
		});
		expect(started.status).toBe(410);
		const workDayId = 'workday-1';

		const task = await app.request('/agent/tasks', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				workDayId,
				agentId: 'market-curator',
				type: 'agent_root',
				idempotencyKey: `${workDayId}:market-curator`,
				payload: { hello: 'world' },
			}),
		});
		expect(task.status).toBe(200);
		const taskPayload = await json(task);

		const context = await app.request('/agent/context/resolve-task', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ taskId: taskPayload.payload.id }),
		});
		expect(context.status).toBe(200);
		expect(await json(context)).toMatchObject({
			ok: true,
			payload: {
				task: {
					id: taskPayload.payload.id,
				},
			},
		});

		const graph = await app.request('/agent/graph/parse-dsl', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ source: 'ctx "market architecture" for plan' }),
		});
		expect(graph.status).toBe(200);

		const specs = await app.request('/agent/specs', {
			headers: {
				authorization: `Bearer ${token}`,
			},
		});
		expect(specs.status).toBe(200);
		const specsPayload = await json(specs);
		expect(Array.isArray(specsPayload.payload)).toBe(true);
		expect(Array.isArray(specsPayload.handlers)).toBe(true);
	});

	it('does not mount the removed internal control-plane routes', async () => {
		const app = createTestApp();

		const response = await app.request('/internal/control/specs');
		expect(response.status).toBe(404);
		expect(await json(response)).toMatchObject({
			ok: false,
			error: 'Not found.',
		});
	});

	it('returns stable errors for unsupported operations and missing auth', async () => {
		const app = createTestApp({
			config: {
				repoRoot: packageRoot,
				authSecret: 'test-secret',
			},
		});

		const unauthorized = await app.request('/sdk/startWorkDay', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ input: { projectId: 'unauthorized', actor: 'test' } }),
		});
		expect(unauthorized.status).toBe(401);

		const { app: authorizedApp, token } = await authorizeApp(['sdk', 'operations']);

		const unsupportedSdk = await authorizedApp.request('/sdk/nope', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ input: {} }),
		});
		expect(unsupportedSdk.status).toBe(400);
		expect(await json(unsupportedSdk)).toMatchObject({ ok: false });

		const unsupportedWorkflow = await authorizedApp.request('/operations/dev', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ cwd: packageRoot }),
		});
		expect(unsupportedWorkflow.status).toBe(400);
	});

	it('fails fast on duplicate or missing provider selections', () => {
		expect(() => createTreeseedApiApp({
			config: {
				repoRoot: packageRoot,
				authSecret: 'test-secret',
			},
			runtimeProviders: {
				auth: {
					memory: ({ config }) => ({
						id: 'memory',
						startDeviceFlow: async () => ({
							ok: true,
							deviceCode: 'a',
							userCode: 'b',
							verificationUri: config.baseUrl,
							verificationUriComplete: config.baseUrl,
							intervalSeconds: 1,
							expiresAt: new Date().toISOString(),
							expiresInSeconds: 1,
						}),
						pollDeviceFlow: async () => ({ ok: false, status: 'invalid', error: 'bad' }),
						refreshAccessToken: async () => {
							throw new Error('nope');
						},
						approveDeviceFlow: async () => ({ ok: true }),
						authenticateBearerToken: async () => null,
						authenticateServiceCredential: async () => null,
						createPersonalAccessToken: async () => ({ id: 'id', token: 'token', prefix: 'prefix', name: 'name', expiresAt: null }),
						listPersonalAccessTokens: async () => [],
						revokePersonalAccessToken: async () => {},
						syncUserIdentity: async () => ({
							principal: { id: 'user', roles: [], permissions: [], scopes: ['auth:me'] },
							userId: 'user',
							identityId: null,
						}),
						createServiceToken: async () => ({ id: 'svc', serviceId: 'svc', secret: 'secret' }),
						rotateServiceToken: async () => ({ id: 'svc', serviceId: 'svc', secret: 'secret' }),
						createTrustedUserAssertion: () => 'assertion',
						verifyTrustedUserAssertion: async () => null,
						exchangeTrustedUserAssertion: async () => ({
							ok: true,
							accessToken: 'token',
							tokenType: 'Bearer',
							expiresAt: new Date().toISOString(),
							expiresInSeconds: 60,
							principal: { id: 'user', roles: [], permissions: [], scopes: ['auth:me'] },
						}),
					} as any),
				},
			},
		})).toThrow(/duplicate auth provider/i);

		expect(() => createTreeseedApiApp({
			config: {
				repoRoot: packageRoot,
				authSecret: 'test-secret',
				providers: {
					auth: 'missing',
					agents: {
						execution: 'stub',
						queue: 'memory',
						notification: 'stub',
						repository: 'stub',
						verification: 'stub',
					},
				},
			},
		})).toThrow(/could not resolve auth provider/i);
	});

});
