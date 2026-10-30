import { expect, it } from 'vitest';
import { stat } from 'node:fs/promises';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { microvmBroker } from '../fixtures/broker-preparation.ts';
import { publicationFixture } from './source-publication-fixture.ts';
import { nativeCloseoutTransport } from '../../kernel/architecture/portable/portable-kernel-fixture.ts';
import { modelExecutionInventory } from '../../../acceptance/workday/support/assignment-authority.ts';

it('native publication failure retains original diagnostics through Kernel runner and public event delivery without a source result', async () => {
	const f = await microvmBroker(); let api: Awaited<ReturnType<typeof nativeCloseoutTransport>> | undefined;
	try {
		const source = publicationFixture(), current = assignmentAttemptSchema.parse(f.input.assignment.assignmentAttempt);
		const attempt = assignmentAttemptSchema.parse({ ...current, workspace: source.workspace,
			grant: source.attempt.grant, contextRefs: source.attempt.contextRefs });
		f.input.assignment.assignmentAttempt = attempt;
		f.input.assignment.workspaceContext = { assignmentAttempt: attempt, predecessorResults: [] };
		f.input.authorizeSource = async () => ({ ...source.authority, authorization: { ...source.authority.authorization,
			assignmentId: attempt.id, attempt: attempt.attempt, providerId: attempt.provider.providerId,
			source: { ...source.authority.authorization.source, teamId: attempt.teamId, projectId: attempt.projectId } } });
		const reason = 'Candidate bundle creation failed. Git exit code 128: fatal: Refusing to create empty bundle.';
		f.failPublication(reason);
		const clock = (id: string, remainingSeconds: number) => {
			const value = { startedAt: attempt.createdAt, deadlineAt: attempt.deadline, remainingSeconds,
				observedAt: new Date(Date.parse(attempt.deadline) - remainingSeconds * 1000).toISOString() };
			return { type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status',
				status: 'completed', result: { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] } } };
		};
		const diagnostics = { sourceCommit: source.reference.commit, providerEvents: [clock('first', 30),
			{ type: 'item.completed', item: { id: 'read', type: 'command_execution', command: 'git rev-parse HEAD', exit_code: 0,
				aggregated_output: source.reference.commit } }, clock('last', 29),
			{ type: 'turn.completed', usage: { input_tokens: 19, output_tokens: 3 } }] };
		f.patchResult({ diagnostics });
		const before = structuredClone(f.input.assignment);
		api = await nativeCloseoutTransport({ attempt, input: f.input, executor: f.executor }, f.directory, true);
		await api.run();
		const delivered = api.requests.filter(x => x.operation === 'createEvent');
		const terminal = delivered.filter(x => ['provider.execution.failed', 'provider.execution.completed'].includes(String(x.body.eventType)));
		expect(terminal).toHaveLength(1); expect(terminal[0]!.body.eventType).toBe('provider.execution.failed');
		expect(terminal[0]!.body.message).toContain(reason);
		expect(terminal[0]!.body.protectedPayload).toMatchObject({ sourceCommit: source.reference.commit,
			providerEventCount: diagnostics.providerEvents.length });
		const rows = delivered.map((x, eventIndex) => ({ id: String(x.body.id), eventIndex, eventType: x.body.eventType,
			context: x.body.context, protectedPayload: x.body.protectedPayload, assignmentId: attempt.id, runId: attempt.workdayId,
			workdayId: attempt.workdayId, teamId: attempt.teamId, projectId: attempt.projectId, createdAt: x.body.createdAt }));
		const inventory = modelExecutionInventory([{ id: attempt.id, status: 'failed', assignmentAttempt: attempt }], rows,
			{ id: attempt.workdayId, teamId: attempt.teamId });
		expect(inventory[0]!.terminal.protectedPayload).toEqual({ sourceCommit: source.reference.commit,
			providerEventCount: diagnostics.providerEvents.length, providerEvents: diagnostics.providerEvents });
		expect(api.requests.filter(x => x.operation === 'failAssignment')).toHaveLength(1);
		expect(api.requests.some(x => x.operation === 'completeAssignment')).toBe(false);
		expect(delivered.some(x => (x.body.context as Record<string, unknown>)?.stage === 'source.published')).toBe(false);
		expect(f.input.assignment).toEqual(before); expect(f.observations[0]!.diagnostics).toEqual(diagnostics);
		expect(f.paths.filter(x => x.endsWith('/source-publication/start'))).toHaveLength(1);
		expect(f.paths.filter(x => x.startsWith('DELETE '))).toHaveLength(1);
	} finally { await api?.close(); await f.close(); }
	expect(f.server.listening).toBe(false); await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
	// Real Unix HTTP, signer, materializer, Kernel, runner and public transport;
	// supplied candidate/broker/model data are not live Git, API, charge or Kata proof.
});
