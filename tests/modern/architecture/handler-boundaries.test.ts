import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { expect, it } from 'vitest';
import { assignmentAttemptSchema, assignmentTimingAwarenessReceiptSchema, type AssignmentContext } from '@treeseed/sdk/agent-capacity';
import { WriterHandler } from '../../../src/kernel/handlers/model-handler.ts';
import type { AgentRuntime, ModelInvocationRequest } from '../../../src/kernel/contracts.ts';
import { request, timingAwareness } from '../kernel/provider-kernel-fixture.ts';

function configuredAssignment() {
	const assignment = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	assignment.agentClass = 'cartographer'; assignment.workspace = { mode: 'read-only' };
	assignment.grant.sourceWrite = []; assignment.grant.tools = ['source.read'];
	Object.assign(assignment.effectiveProfile, parse(`
activity: acting
handler: portfolio/inspect
handlerOrigin: project-runtime
prompt:
  system: Inspect the configured evidence without changing it.
  instructions: [Preserve the assigned scope.]
parameters: { style: exact, detail: 3 }
`));
	return assignmentAttemptSchema.parse(assignment);
}

type Observation = { begins?: number; modelCalls?: number; publications?: number; fileExists?: boolean;
	inputUnchanged?: boolean; error?: string; result?: { status: string; outputs?: Record<string, unknown> } };
function native(mode: 'bridge' | 'grant' | 'paths' | 'deadline', agentClass = 'cartographer'): Observation {
	const root = mkdtempSync(resolve(tmpdir(), 'agent-architecture-native-'));
	try {
		const assignment = configuredAssignment(); assignment.agentClass = agentClass;
		const path = resolve(root, 'assignment.yaml'); writeFileSync(path, stringify(assignment));
		const processResult = spawnSync(process.execPath, ['--import', 'tsx',
			resolve(import.meta.dirname, 'native-handler.ts'), path, mode], {
			cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 10_000,
		});
		expect(processResult.error).toBeUndefined();
		expect(processResult.status, processResult.stderr).toBe(0);
		return JSON.parse(processResult.stdout) as Observation;
	} finally { rmSync(root, { recursive: true, force: true }); }
}

it('executes arbitrary YAML-selected deterministic handlers with ordinary execution admission', () => {
	const observed = native('bridge');
	expect(observed.result?.status, JSON.stringify(observed)).toBe('completed');
	expect(observed.begins).toBe(1);
	expect(observed.modelCalls).toBe(0);
});

it('closes a no-sandbox deterministic assignment without special-casing the Reporter handler name', () => {
	const observed = native('bridge', 'reporter');
	expect(observed.result?.status, JSON.stringify(observed)).toBe('completed');
	expect(observed.result?.outputs?.teardown).toEqual({ verified: true, completedAt: expect.stringMatching(/^\d{4}-/u) });
	expect(observed.modelCalls).toBe(0);
});

it('preserves exact YAML prompts parameters and authorized context through a native configured handler', () => {
	const assignment = configuredAssignment();
	for (const name of ['cartographer', 'renamed-inspector']) {
		const observed = native('bridge', name);
		expect(observed.result?.status, JSON.stringify(observed)).toBe('completed');
		const result = observed.result?.outputs?.assignmentResult as { summary: string; usage: { elapsedSeconds: number } };
		expect(JSON.parse(result.summary)).toEqual({ prompt: assignment.effectiveProfile.prompt,
			parameters: { style: 'exact', detail: 3 }, value: { repository: 'treeseed-ai/sdk', commit: assignment.contextRefs[0]!.commit } });
		expect(result.usage.elapsedSeconds).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(result.usage.elapsedSeconds)).toBe(true);
	}
});

it('denies a handler attempting to widen its immutable grant before a real Git publication', () => {
	const observed = native('grant');
	expect(observed.error, JSON.stringify(observed)).toBe('assignment_grant_denied:source.path');
	expect(observed.publications).toBe(0);
	expect(observed.fileExists).toBe(false);
	expect(observed.inputUnchanged).toBe(true);
});

it('denies handler-side writable-path widening before a real Git publication', () => {
	const observed = native('paths');
	expect(observed.error, JSON.stringify(observed)).toBe('assignment_grant_denied:source.path');
	expect(observed.publications).toBe(0);
	expect(observed.fileExists).toBe(false);
	expect(observed.inputUnchanged).toBe(true);
});

it('enforces the original assignment deadline after handler mutation and a native event-loop stall', () => {
	const observed = native('deadline');
	expect(observed.error, JSON.stringify(observed)).toBe('assignment_timeout');
	expect(observed.publications).toBe(0);
	expect(observed.fileExists).toBe(false);
	expect(observed.inputUnchanged).toBe(true);
});

it('uses the same Writer behavior after a class rename rather than imposing Architect task semantics', async () => {
	const assignment = configuredAssignment(); assignment.effectiveProfile.handler = 'writer';
	assignment.effectiveProfile.handlerOrigin = 'agent-package';
	const context: AssignmentContext = { assignment, context: [], predecessorResults: [] };
	const invocations: ModelInvocationRequest[] = [];
	const unexpected = async (): Promise<never> => { throw new Error('unexpected_mutation'); };
	const runtime: AgentRuntime = { now: () => '2026-10-02T19:00:00.000Z', readContext: unexpected,
		invokeModel: async input => { invocations.push(input); return { text: 'Inspected the assigned scope.',
			timingAwareness: assignmentTimingAwarenessReceiptSchema.parse(timingAwareness), usage: { elapsedSeconds: 1 } }; },
		runVerification: unexpected, commitSource: unexpected, commitTreeDx: unexpected };
	const expected = await new WriterHandler().run(context, runtime);
	assignment.agentClass = 'architect';
	expect(await new WriterHandler().run(context, runtime)).toEqual(expected);
	expect(invocations[1]).toEqual(invocations[0]);
});
