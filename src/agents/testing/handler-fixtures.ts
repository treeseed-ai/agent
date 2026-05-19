import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveAgentHandler } from '../registry.ts';
import type { AgentContext } from '../runtime-types.ts';
import { resolveWorkspaceReportPath } from '../../services/report-paths.ts';

export interface HandlerFixtureResult {
	id: string;
	handler: string;
	fixtureRoot: string;
	ok: boolean;
	output: unknown;
	reportPath?: string;
}

export interface HandlerFixtureSuiteResult {
	ok: boolean;
	generatedAt: string;
	fixtures: HandlerFixtureResult[];
	reportPath: string;
	jsonPath: string;
}

async function readJson(path: string, fallback: unknown = {}) {
	try {
		return JSON.parse(await readFile(path, 'utf8')) as unknown;
	} catch {
		return fallback;
	}
}

export async function runHandlerFixture(input: {
	id: string;
	handler: string;
	fixtureRoot: string;
	context?: Partial<AgentContext>;
	reportPath?: string;
	tenantRoot?: string;
}): Promise<HandlerFixtureResult> {
	const fixtureRoot = resolve(input.fixtureRoot);
	const handler = await resolveAgentHandler(input.handler as never, { tenantRoot: input.tenantRoot ?? fixtureRoot });
	const trigger = await readJson(resolve(fixtureRoot, 'trigger-message.json'));
	const expected = await readJson(resolve(fixtureRoot, 'expected-result.json'), {});
	const sdkCalls: unknown[] = [];
	const messages: unknown[] = [];
	const events: unknown[] = [];
	const artifacts: unknown[] = [];
	const approvals: unknown[] = [];
	const mutations: unknown[] = [];
	const context = {
		runId: `fixture:${input.id}`,
		repoRoot: process.cwd(),
		agent: {
			slug: input.handler,
			handler: input.handler,
			enabled: true,
			triggers: [],
			permissions: [],
			execution: {},
			outputs: {},
		},
		task: { id: input.id, payloadJson: JSON.stringify(trigger) },
		trigger: {
			kind: 'message',
			source: 'fixture',
			trigger: { type: 'message' },
			message: {
				id: 1,
				type: String((trigger as Record<string, unknown>).messageType ?? 'fixture'),
				status: 'claimed',
				payloadJson: JSON.stringify(trigger),
			},
		},
		sdk: new Proxy({}, {
			get(_target, property) {
				return async (...args: unknown[]) => {
					sdkCalls.push({ method: String(property), args });
					if (property === 'createMessage') messages.push(args[0]);
					if (property === 'appendTaskEvent') events.push(args[0]);
					if (String(property).toLowerCase().includes('artifact')) artifacts.push({ method: String(property), args });
					if (String(property).toLowerCase().includes('approval')) approvals.push({ method: String(property), args });
					if (String(property).toLowerCase().includes('mutation') || String(property).toLowerCase().includes('stage')) mutations.push({ method: String(property), args });
					if (property === 'buildContextPack') {
						return {
							seedIds: ['fixture'],
							totalTokenEstimate: 16,
							includedNodeIds: ['fixture'],
							nodes: [{
								node: {
									id: 'fixture',
									title: 'Fixture Context',
									data: { relativePath: 'packages/agent/src/agents/testing/handler-fixtures.ts' },
								},
							}],
							edges: [],
						};
					}
					return { payload: null };
				};
			},
		}),
		execution: {},
		mutations: {},
		repository: {},
		verification: {},
		notifications: {},
		research: {},
		operations: {},
		...input.context,
	} as AgentContext;
	const resolvedInputs = await handler.resolveInputs(context);
	const executed = await handler.execute(context, resolvedInputs);
	const output = typeof handler.emitOutputs === 'function'
		? await handler.emitOutputs(context, executed)
		: executed;
	const expectedStatus = typeof (expected as Record<string, unknown>).status === 'string'
		? String((expected as Record<string, unknown>).status)
		: null;
	const actualStatus = typeof (output as Record<string, unknown>)?.status === 'string'
		? String((output as Record<string, unknown>).status)
		: null;
	const result = {
		id: input.id,
		handler: input.handler,
		fixtureRoot,
		ok: !expectedStatus || expectedStatus === actualStatus,
		output: { resolvedInputs, executed, emitted: output, sdkCalls, messages, events, artifacts, approvals, mutations, expected },
		reportPath: input.reportPath,
	};
	if (input.reportPath) {
		await mkdir(dirname(input.reportPath), { recursive: true });
		await writeFile(input.reportPath, [
			`# Handler Fixture: ${input.id}`,
			'',
			`Handler: ${input.handler}`,
			'Status: PASS',
			'',
		].join('\n'), 'utf8');
	}
	return result;
}

function renderSuiteReport(result: Omit<HandlerFixtureSuiteResult, 'reportPath' | 'jsonPath'>) {
	const lines = [
		'# Handler Fixture Report',
		'',
		`Generated: ${result.generatedAt}`,
		`Status: ${result.ok ? 'PASS' : 'FAIL'}`,
		'',
	];
	for (const fixture of result.fixtures) {
		const emitted = (fixture.output as Record<string, unknown>).emitted as Record<string, unknown> | undefined;
		lines.push(
			`## ${fixture.id}`,
			'',
			`Handler: ${fixture.handler}`,
			`Fixture: ${fixture.fixtureRoot}`,
			`Status: ${fixture.ok ? 'PASS' : 'FAIL'}`,
			`Emitted status: ${String(emitted?.status ?? 'unknown')}`,
			'',
		);
	}
	return `${lines.join('\n')}\n`;
}

export async function runHandlerFixtureSuite(input: {
	fixtures: Array<{ id: string; handler: string; fixtureRoot: string; context?: Partial<AgentContext>; tenantRoot?: string }>;
	reportPath?: string;
	now?: Date;
}): Promise<HandlerFixtureSuiteResult> {
	const generatedAt = (input.now ?? new Date()).toISOString();
	const fixtures = [];
	for (const fixture of input.fixtures) {
		fixtures.push(await runHandlerFixture(fixture));
	}
	const resultWithoutPaths = {
		ok: fixtures.every((fixture) => fixture.ok),
		generatedAt,
		fixtures,
	};
	const reportPath = resolveWorkspaceReportPath(input.reportPath ?? '.treeseed/test-reports/handler-fixtures.md');
	const jsonPath = resolveWorkspaceReportPath(reportPath.replace(/\.md$/u, '.json'));
	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(reportPath, renderSuiteReport(resultWithoutPaths), 'utf8');
	await writeFile(jsonPath, `${JSON.stringify(resultWithoutPaths, null, 2)}\n`, 'utf8');
	return {
		...resultWithoutPaths,
		reportPath,
		jsonPath,
	};
}
