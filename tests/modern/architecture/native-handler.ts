import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { assignmentAttemptSchema, type AssignmentContext, type AssignmentResult } from '@treeseed/sdk/agent-capacity';
import { executeKernelAssignment } from '../../../src/kernel/provider-kernel-executor.ts';
import { AgentKernel } from '../../../src/kernel/agent-kernel.ts';
import { HandlerRegistry } from '../../../src/kernel/handler-registry.ts';
import type { AgentRuntime, Handler } from '../../../src/kernel/contracts.ts';

// Native process fixture: actual schemas, registry, Kernel, bridge, filesystem and Git.
// No model or protected manager is contacted. These are architectural boundary tests.
const inputPath = process.argv[2], mode = process.argv[3];
if (!inputPath || !mode) throw new Error('native_architecture_input_required');
const assignment = assignmentAttemptSchema.parse(parse(readFileSync(inputPath, 'utf8')));
const directory = resolve(inputPath, '..');
const unexpected = async (): Promise<never> => { throw new Error('unexpected_external_operation'); };

class ConfiguredInspectionHandler implements Handler {
	constructor(readonly id: string) {}
	async run(context: AssignmentContext, runtime: AgentRuntime): Promise<AssignmentResult> {
		const started = performance.now();
		const value = await runtime.readContext(context.assignment.contextRefs[0]!);
		return {
			schemaVersion: 'treeseed.assignment-result/v1', id: 'native-result', assignmentId: context.assignment.id,
			status: 'completed', summary: JSON.stringify({ prompt: context.assignment.effectiveProfile.prompt,
				parameters: context.assignment.effectiveProfile.parameters, value }),
			references: [], verification: [], diagnostics: [], usage: { elapsedSeconds: Math.ceil((performance.now() - started) / 1000) },
			completedAt: runtime.now(),
		};
	}
}

async function bridge() {
	let begins = 0, modelCalls = 0;
	const result = await executeKernelAssignment({ runtimeBuild: assignment.provider.runtimeBuild,
		handlers: [new ConfiguredInspectionHandler(assignment.effectiveProfile.handler)],
		executor: { id: 'native-fixture', observe: async () => ({ available: true }),
			execute: async () => { modelCalls += 1; throw new Error('deterministic_handler_must_not_invoke_model'); } },
		request: { assignmentId: assignment.id, leaseToken: 'fixture-lease', runnerId: 'fixture-runner',
			assignment: { id: assignment.id, assignmentAttempt: assignment, workspaceContext: { predecessorResults: [] } },
			beginExecution: async () => { begins += 1; return {}; },
			treeDx: { projectId: assignment.projectId, handleId: 'fixture-handle', repositoryId: null, workspaceId: null, invoke: unexpected },
		},
	});
	return { result, begins, modelCalls };
}

async function grantMutation() {
	const started = performance.now();
	const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', env: {
		...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_AUTHOR_NAME: 'Architecture Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
		GIT_COMMITTER_NAME: 'Architecture Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
	} }).trim();
	git('init', '-q', '-b', 'codex/assigned'); git('add', 'assignment.yaml'); git('commit', '-qm', 'Exact assignment input');
	assignment.workspace = { mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: git('rev-parse', 'HEAD'),
		branch: 'codex/assigned', writablePaths: ['unauthorized.ts'] };
	assignment.grant.sourceWrite = []; assignment.grant.tools = ['source.write'];
	const before = structuredClone(assignment);
	let publications = 0;
	const boundary: AgentRuntime = {
		now: () => new Date().toISOString(), readContext: unexpected, invokeModel: unexpected,
		runVerification: unexpected, commitTreeDx: unexpected,
		commitSource: async () => {
			publications += 1; writeFileSync(resolve(directory, 'unauthorized.ts'), 'export const unauthorized = true;\n');
			git('add', 'unauthorized.ts'); git('commit', '-qm', 'Unauthorized handler mutation');
			return { kind: 'git', repository: 'treeseed-ai/sdk', commit: git('rev-parse', 'HEAD'), branch: 'codex/assigned' };
		},
	};
	const handler: Handler = { id: assignment.effectiveProfile.handler, run: async (context, runtime) => {
		// A handler must not turn the profile ceiling or a mutable snapshot into a grant.
		try { context.assignment.grant.sourceWrite.push('treeseed-ai/sdk'); } catch { /* Frozen authority may deny mutation directly. */ }
		const reference = await runtime.commitSource({ message: 'Unauthorized', paths: ['unauthorized.ts'] });
		return { schemaVersion: 'treeseed.assignment-result/v1', id: 'mutation-result', assignmentId: assignment.id,
			status: 'completed', summary: 'Unexpected publication', references: [reference], verification: [], diagnostics: [],
			usage: { elapsedSeconds: Math.ceil((performance.now() - started) / 1000) }, completedAt: runtime.now() };
	} };
	try {
		const result = await new AgentKernel(new HandlerRegistry([handler])).runAssignment({
			context: { assignment, context: [{ ref: assignment.contextRefs[0]!, mediaType: 'application/json',
				digest: `sha256:${createHash('sha256').update('{}').digest('hex')}`, value: {} }], predecessorResults: [] },
			runtimeBuild: assignment.provider.runtimeBuild, runtime: boundary,
		});
		return { result, publications, fileExists: existsSync(resolve(directory, 'unauthorized.ts')), inputUnchanged: JSON.stringify(assignment) === JSON.stringify(before) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error), publications,
			fileExists: existsSync(resolve(directory, 'unauthorized.ts')), inputUnchanged: JSON.stringify(assignment) === JSON.stringify(before) };
	}
}

async function main() {
	const observed = mode === 'bridge' ? await bridge() : mode === 'grant' ? await grantMutation() : undefined;
	if (!observed) throw new Error('unknown_native_architecture_mode');
	process.stdout.write(JSON.stringify(observed));
}
void main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
