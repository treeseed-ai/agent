import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { nativeCloseoutTransport, portableKernel, portableProfile } from './portable-kernel-fixture.ts';
import { contextPredecessor } from './context-fixture.ts';
import { sandboxAccountingUsage } from '../../../../../src/provider/execution/microvm-executor.ts';

const closeoutTransport = (f: Awaited<ReturnType<typeof portableKernel>>) => nativeCloseoutTransport(f, dirname(f.checkout));

describe('portable configured profiles through real provider Kernel and native Git', () => {
	it('native renamed integration profiles retain one supplied original base and both independent Git inputs through the same Releaser handler without hidden base construction', async () => {
		for (const name of ['configured-integration-author', 'customer-composition-worker']) {
			const f = await portableKernel(); try {
				if (f.attempt.workspace.mode !== 'git') throw new Error('Original sole Git workspace required');
				const workspace = f.attempt.workspace, left = await f.candidate(['src/left.txt']);
				f.git('switch', '--detach', f.base); const right = await f.candidate(['src/right.txt']);
				const leftBytes = execFileSync('git', ['show', `${left}:src/left.txt`], { cwd: f.checkout });
				const rightBytes = execFileSync('git', ['show', `${right}:src/right.txt`], { cwd: f.checkout });
				f.git('switch', workspace.branch); f.git('merge', '--no-ff', right, '-m', 'Explicit supplied integration candidate');
				const integrated = f.git('rev-parse', 'HEAD'), inputs = [contextPredecessor(f.attempt, 'left-input', 'left-earlier-input', left),
					contextPredecessor(f.attempt, 'right-input', 'right-earlier-input', right)];
				const profile = portableProfile(name, 'releaser'), selected = profile.activityProfiles.acting!;
				selected.permissions.tools.push('release');
				f.attempt.agentClass = profile.agentClass; f.attempt.workItemId = 'combine-reviewed-candidates';
				Object.assign(f.attempt.effectiveProfile, { handler: selected.handler, profileRef: { ...f.attempt.effectiveProfile.profileRef, id: profile.id },
					prompt: selected.prompt, parameters: selected.parameters, permissionCeiling: selected.permissions });
				f.attempt.grant.tools.push('release'); f.attempt.predecessorResultIds = inputs.map(value => value.id);
				// The sole workspace already owns the original base. Do not copy
				// that same authority into context beside both predecessor sources.
				f.attempt.contextRefs = inputs.map((value, index) => ({ store: 'git' as const, model: 'repository', id: value.id,
					repository: workspace.repository, commit: index === 0 ? left : right }));
				f.input.assignment.workspaceContext = { assignmentAttempt: f.attempt, predecessorResults: inputs };
				const reply = f.getReply(); reply.outputs = { ...reply.outputs, changedPaths: ['src/left.txt', 'src/right.txt'],
					sourceReference: { kind: 'git', repository: workspace.repository, commit: integrated, branch: workspace.branch } }; f.setReply(reply);
				const before = structuredClone(f.input.assignment), result = await f.run();
				expect(result.status, `${result.code}: ${result.summary}`).toBe('completed'); expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
				expect(f.requests[0]).toMatchObject({ workspaceContext: { assignmentAttempt: { agentClass: name,
					workspace: { baseCommit: f.base }, effectiveProfile: { handler: 'releaser' } }, predecessorResults: inputs } });
				expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).references).toContainEqual({ kind: 'git', repository: workspace.repository, commit: integrated, branch: workspace.branch });
				expect(f.git('rev-list', '--parents', '-n', '1', integrated).split(' ')).toEqual([integrated, left, right]);
				expect(execFileSync('git', ['show', `${integrated}:src/left.txt`], { cwd: f.checkout })).toEqual(leftBytes);
				expect(execFileSync('git', ['show', `${integrated}:src/right.txt`], { cwd: f.checkout })).toEqual(rightBytes);
				expect(execFileSync('git', ['show', `${left}:src/left.txt`], { cwd: f.checkout })).toEqual(leftBytes);
				expect(execFileSync('git', ['show', `${right}:src/right.txt`], { cwd: f.checkout })).toEqual(rightBytes);
				expect(f.git('rev-parse', 'fixture-base')).toBe(f.base); expect(f.git('rev-parse', 'HEAD')).toBe(integrated);
				expect(f.input.assignment).toEqual(before);
				// Explicit native merge and predecessor DTOs are controlled inputs,
				// not accepted governance, model-generated work or native review proof.
			} finally { await f.close(); }
		}
	});
	it('native cancellation and original expiry retain late executor bytes and failed public closeout without another execution or successful retry', async () => {
		// Six independent allocated boundaries share no repository, host slot,
		// transport or deadline. Observe their original clocks concurrently instead
		// of serially accumulating three one-second expiry windows in one watchdog.
		const scenarios = (['cancel', 'expire'] as const).flatMap(cause => (['completed', 'returned', 'throw'] as const).map(late => ({ cause, late })));
		const outcomes = await Promise.allSettled(scenarios.map(async ({ cause, late }) => {
			let release!: () => void, stopped!: () => void;
			const gate = new Promise<void>(resolve => { release = resolve; }), interrupted = new Promise<void>(resolve => { stopped = resolve; });
			// A shorter original test input is allocated before admission; the
			// original five-second test watchdog and every admitted clock stay fixed.
			const f = await portableKernel(gate, cause === 'expire' ? 1 : undefined), abort = new AbortController();
			let api: Awaited<ReturnType<typeof closeoutTransport>> | undefined, running: Promise<unknown> | undefined;
			try {
				const candidate = await f.candidate(), reply = f.getReply(); f.input.signal = abort.signal;
				reply.usage = [{ activeSeconds: 0.125, elapsedSeconds: 0.25, inputTokens: 7, nativeUsage: { input_tokens: 7 } }];
				reply.artifacts = [{ id: 'native-late-observation', content: 'unchanged native late observation\n' }]; f.setReply(reply);
				const original = structuredClone(reply), before = structuredClone(f.input.assignment),
					bytes = execFileSync('git', ['show', `${candidate}:src/output.txt`], { cwd: f.checkout });
				const executor = { ...f.executor, execute: async (execution: Parameters<typeof f.executor.execute>[0]) => {
					try { return await f.executor.execute(execution); }
					catch (error) {
						if (!execution.signal?.aborted) throw error;
						stopped(); await gate;
						if (late === 'throw') throw Object.assign(new Error('Original native interrupted observation.'),
							{ outputs: reply.outputs, usage: reply.usage, artifacts: reply.artifacts });
						return { ...reply, status: late, retryable: late === 'returned' };
					}
				} };
				api = await nativeCloseoutTransport({ ...f, executor }, dirname(f.checkout), true);
				let terminal = false; running = api.run(); void running.then(() => { terminal = true; }, () => { terminal = true; });
				await Promise.race([f.requestArrived, running.then(() => { throw new Error('Original execution ended before native executor admission'); })]);
				if (cause === 'cancel') abort.abort(); await interrupted;
				expect(terminal).toBe(false); expect(api.requests.some(item => ['failAssignment', 'returnAssignment', 'completeAssignment'].includes(item.operation))).toBe(false);
				release(); await running;
				const held = (await api.reopen().claimsForRecovery(true)).find(item => item.id === api!.claim.id),
					failure = api.requests.filter(item => item.operation === 'failAssignment');
				expect(failure).toHaveLength(1); expect(failure[0]!.body).toMatchObject({ leaseToken: f.input.leaseToken, runnerId: f.input.runnerId,
					code: cause === 'expire' ? 'assignment_timeout' : 'agent_kernel_failed', retryable: false });
				expect(api.requests.map(item => item.operation)).toEqual(['assignment', 'startExecution', 'reportUsage', 'failAssignment']);
				expect(api.requests.find(item => item.operation === 'reportUsage')?.body.usageActual).toEqual(original.usage![0]);
				expect(held?.closeoutOutput).toEqual({ ...original.outputs, artifacts: original.artifacts });
				expect(held?.dispatchEnvelope).toEqual(api.lease.dispatchEnvelope); expect(held?.leaseExpiresAt).toBe(f.attempt.deadline);
				const retained = structuredClone(held); expect((await api.reopen().claimsForRecovery(true)).find(item => item.id === api!.claim.id)).toEqual(retained);
				expect(f.requests).toHaveLength(1); expect(f.getReply()).toEqual(original); expect(f.input.assignment).toEqual(before);
				expect(f.git('rev-parse', 'HEAD')).toBe(candidate); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
				expect(execFileSync('git', ['show', `${candidate}:src/output.txt`], { cwd: f.checkout })).toEqual(bytes);
				// Native HTTP abort, owning Kernel/runner and durable local custody;
				// delayed counters/teardown are controlled inputs, not Kata/model proof.
			} finally { release(); await Promise.allSettled(running ? [running] : []); try { await api?.close(); } finally { await f.close(); } }
		}));
		expect(outcomes).toHaveLength(scenarios.length);
		for (const [index, outcome] of outcomes.entries()) {
			expect(outcome.status, `${scenarios[index]!.cause}/${scenarios[index]!.late}: ${outcome.status === 'rejected' ? String(outcome.reason) : 'complete'}`).toBe('fulfilled');
		}
	});
	it('native successful usage delivery preserves exact observations and blocks denied closeout before completion without another model turn', async () => {
		for (const denial of [undefined, { status: 403, fault: '' }, { status: 503, fault: '' },
			{ status: 200, fault: 'reset' }, { status: 200, fault: 'json' }]) {
			const f = await portableKernel(); let api: Awaited<ReturnType<typeof closeoutTransport>> | undefined;
			try {
				const candidate = await f.candidate(), reply = f.getReply(), before = structuredClone(f.input.assignment);
				const bytes = execFileSync('git', ['show', `${candidate}:src/output.txt`], { cwd: f.checkout });
				const raw = { activeSeconds: 1.125, elapsedSeconds: 2.25, input_tokens: 19, output_tokens: 3,
					cpuUserMicros: 17, provenance: 'execution-provider' }, rawBefore = structuredClone(raw);
				const usage = sandboxAccountingUsage(raw);
				expect(usage).toEqual({ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3,
					cpuUserMicros: 17, provenance: 'execution-provider', nativeUsage: { activeSeconds: 1.125, elapsedSeconds: 2.25,
						input_tokens: 19, output_tokens: 3, cpuUserMicros: 17 } }); expect(raw).toEqual(rawBefore);
				reply.usage = [usage]; f.setReply(reply); const original = structuredClone(reply);
				api = await closeoutTransport(f); if (denial) api.deny('reportUsage', denial.status, denial.fault);
				let failure: unknown; try { await api.run(); } catch (error) { failure = error; }
				const held = (await api.reopen().claimsForRecovery(true)).find(item => item.id === api!.claim.id);
				expect(held?.closeoutOutput).toMatchObject({ ...reply.outputs, artifacts: [],
					assignmentResult: { assignmentId: f.attempt.id, status: 'completed', references: [{ kind: 'git',
						repository: 'treeseed-ai/sdk', commit: candidate, branch: 'simulation/portable/workday/assignment-1' }] } });
				expect(api.requests.filter(item => item.operation === 'reportUsage')).toEqual([{ operation: 'reportUsage',
					key: `usage:${f.attempt.id}:${f.input.runnerId}:0`, body: { leaseToken: f.input.leaseToken, runnerId: f.input.runnerId,
						usageDimension: 'diagnostic-0', accountingMode: 'informational', activeSeconds: 0, elapsedSeconds: 0, usageActual: usage } }]);
				if (denial) {
					expect(failure).toBeInstanceOf(Error); expect(api.requests.some(item => item.operation === 'completeAssignment')).toBe(false);
					expect(api.requests.some(item => item.operation === 'settleAssignment')).toBe(false);
					const history = structuredClone(api.requests), exactHeld = structuredClone(held); api.deny();
					const diagnostic = history.find(item => item.operation === 'reportUsage');
					if (!diagnostic?.key) throw new Error('Original successful usage delivery key required');
					await api.client.reportAssignmentUsage(f.attempt.id, diagnostic.body, diagnostic.key);
					expect(api.requests.slice(0, history.length)).toEqual(history);
					expect(api.requests.at(-1)).toEqual(diagnostic);
					expect((await api.reopen().claimsForRecovery(true)).find(item => item.id === api!.claim.id)).toEqual(exactHeld);
					// Retry only the actual rejected delivery, not another Kernel/model
					// execution, fabricated settlement, or fabricated completed attempt.
				} else {
					expect(failure).toBeUndefined();
					expect(api.requests.filter(item => item.operation === 'settleAssignment')).toEqual([{ operation: 'settleAssignment',
						key: `assignment-settlement:${f.attempt.id}:${f.input.runnerId}`, body: { activeSeconds: 2, elapsedSeconds: 3,
							usageDimension: 'aggregate', usageActual: usage } }]);
					expect(api.requests.filter(item => item.operation === 'completeAssignment')).toHaveLength(1);
					const operations = api.requests.map(item => item.operation);
					expect(operations.indexOf('reportUsage')).toBeLessThan(operations.indexOf('settleAssignment'));
					expect(operations.indexOf('settleAssignment')).toBeLessThan(operations.indexOf('completeAssignment'));
				}
				expect(f.requests).toHaveLength(1); expect(f.getReply()).toEqual(original); expect(f.input.assignment).toEqual(before);
				expect(held?.dispatchEnvelope).toEqual(api.lease.dispatchEnvelope); expect(held?.leaseExpiresAt).toBe(f.attempt.deadline);
				expect(f.git('rev-parse', 'HEAD')).toBe(candidate); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
				expect(execFileSync('git', ['show', `${candidate}:src/output.txt`], { cwd: f.checkout })).toEqual(bytes);
			} finally { try { await api?.close(); } finally { await f.close(); } }
		}
	});
	it('native configured model completion denies incomplete sandbox closeout without replacing candidate bytes failed history or measured usage', async () => {
		const f = await portableKernel(); try {
			const candidate = await f.candidate(), original = f.getReply(), before = structuredClone(f.input.assignment);
			const candidateBytes = execFileSync('git', ['show', `${candidate}:src/output.txt`], { cwd: f.checkout });
			const observations = [], invalid: unknown[] = [undefined, null, {}, { verified: false, completedAt: new Date().toISOString() },
				{ verified: 'true', completedAt: new Date().toISOString() }, { verified: 1, completedAt: new Date().toISOString() },
				{ verified: true }, { verified: true, completedAt: null }, { verified: true, completedAt: '' },
				{ verified: true, completedAt: 'not-a-clock' }, { verified: true, completedAt: Date.now() },
				{ verified: true, completedAt: '2099-01-01T00:00:00.000Z' }];
			for (const teardown of invalid) {
				const reply = structuredClone(original); reply.outputs = { ...reply.outputs, sandboxId: 'owned-native-incomplete-closeout', ...(teardown === undefined ? {} : { teardown }) };
				reply.artifacts = [{ id: 'native-closeout-observation', content: 'original incomplete native closeout\n' }];
				const supplied = structuredClone(reply); f.setReply(reply); const result = await f.run();
				observations.push({ status: result.status, code: result.code, retryable: result.retryable });
				expect(result.outputs?.assignmentResult).toBeUndefined(); expect(result.outputs).toEqual(supplied.outputs);
				expect(result.usage).toEqual(supplied.usage); expect(result.artifacts).toEqual(supplied.artifacts); expect(f.getReply()).toEqual(supplied);
				expect(f.input.assignment).toEqual(before); expect(f.git('rev-parse', 'HEAD')).toBe(candidate); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
				expect(execFileSync('git', ['show', `${candidate}:src/output.txt`], { cwd: f.checkout })).toEqual(candidateBytes);
			}
			expect(observations).toEqual(invalid.map(() => ({ status: 'failed', code: 'sandbox_teardown_unverified', retryable: false })));
			expect(f.requests).toHaveLength(invalid.length); expect(f.begin).toHaveLength(invalid.length);
			// Actual owning Kernel/configured profile/native HTTP and Git. Supplied
			// broker observations do not establish Kata teardown or API retry admission.
		} finally { await f.close(); }
	});
	it('native claimed model completions with incomplete clocks retain exact candidate and closeout while returning retryable timing refusal', async () => {
		const f = await portableKernel(); try {
			const candidate = await f.candidate(), original = f.getReply(), before = structuredClone(f.input.assignment);
			const fields: Record<string, unknown> = { schemaVersion: 'unknown', requiredChecks: 3, completedChecks: 1,
				firstTool: 'source.read', firstToolSucceeded: false, lastTool: 'source.read', lastToolSucceeded: false,
				firstToolCompliant: false, finalToolCompliant: false };
			const canonical = original.outputs?.timingAwareness;
			if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) throw new Error('Original complete fixture receipt required');
			const values: unknown[] = [undefined, null, {}];
			for (const [field, changed] of Object.entries(fields)) {
				const absent: Record<string, unknown> = { ...canonical }; delete absent[field];
				values.push(absent, { ...canonical, [field]: null }, { ...canonical, [field]: changed });
			}
			const observations = [];
			for (const value of values) {
				const reply = structuredClone(original);
				reply.outputs = { ...reply.outputs, timingAwareness: value, sandboxId: 'owned-native-clock-refusal',
					teardown: { verified: false, completedAt: null } };
				reply.artifacts = [{ id: 'native-clock-observation', content: 'original native response\n' }];
				f.setReply(reply); const result = await f.run();
				observations.push({ status: result.status, code: result.code, retryable: result.retryable });
				expect(result.outputs).toEqual(reply.outputs); expect(result.usage).toEqual(reply.usage); expect(result.artifacts).toEqual(reply.artifacts);
				expect(result.outputs?.assignmentResult).toBeUndefined(); expect(result.summary).toContain('model_timing_result_invalid:');
				expect(f.input.assignment).toEqual(before); expect(f.git('rev-parse', 'HEAD')).toBe(candidate);
				expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
			}
			expect(observations).toEqual(values.map(() => ({ status: 'returned', code: 'assignment_timing_awareness_missing', retryable: true })));
			expect(f.requests).toHaveLength(values.length); expect(f.begin).toHaveLength(values.length);
			// Each call exercises the same owning boundary with a controlled native
			// reply. It is not an API retry admission, live model, or deadline reset.
		} finally { await f.close(); }
	});
	it('native executor failure classifications retain exact durable closeout bytes through Kernel runner and public provider transport', async () => {
		const outcomes = [];
		for (const mode of [
			{ summary: 'Kata guest exited 1: Codex execution failed: Selected model is at capacity. Please try a different model.', code: 'execution_provider_unavailable' },
			{ summary: 'Kata guest exited 1: Agent timing-awareness contract requires first and final checks.', code: 'assignment_timing_awareness_missing' },
		]) {
			const f = await portableKernel(); let api: Awaited<ReturnType<typeof closeoutTransport>> | undefined;
			try {
				const candidate = await f.candidate(), original = f.getReply();
				const usage = { activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, nativeUsage: { input_tokens: 19, output_tokens: 3 } };
				const outputs = { ...original.outputs, sandboxId: 'owned-failure-sandbox', teardown: { verified: false, completedAt: null } };
				const artifacts = [{ id: 'failed-observation', content: 'original failed observation\n' }];
				f.setReply({ status: 'failed', summary: mode.summary, code: 'sandbox_failed', retryable: false, outputs, artifacts, usage: [usage] });
				const before = structuredClone(f.input.assignment); api = await closeoutTransport(f); await api.run();
				const held = (await api.reopen().claimsForRecovery(true)).find(item => item.id === api!.claim.id);
				outcomes.push({ output: held?.closeoutOutput, returned: api.requests.find(item => item.operation === 'returnAssignment')?.body,
					expected: { ...outputs, artifacts }, code: mode.code });
				expect(api.requests.filter(item => item.operation === 'reportUsage')).toEqual([{ operation: 'reportUsage',
					key: `usage:${f.attempt.id}:${f.input.runnerId}:0`, body: { leaseToken: f.input.leaseToken, runnerId: f.input.runnerId,
						usageDimension: 'diagnostic-0', accountingMode: 'informational', activeSeconds: 0, elapsedSeconds: 0, usageActual: usage } }]);
				expect(api.requests.filter(item => item.operation === 'settleAssignment')).toEqual([{ operation: 'settleAssignment',
					key: `assignment-settlement:${f.attempt.id}:${f.input.runnerId}`, body: { activeSeconds: 2, elapsedSeconds: 3, usageDimension: 'aggregate', usageActual: usage } }]);
				expect(api.requests.map(item => item.operation)).toEqual(['assignment', 'startExecution', 'reportUsage', 'settleAssignment', 'returnAssignment']);
				expect(f.requests).toHaveLength(1); expect(f.input.assignment).toEqual(before);
				expect(held?.dispatchEnvelope).toEqual(api.lease.dispatchEnvelope); expect(held?.leaseExpiresAt).toBe(f.attempt.deadline);
				expect(f.git('rev-parse', 'HEAD')).toBe(candidate); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
			} finally { try { await api?.close(); } finally { await f.close(); } }
		}
		for (const outcome of outcomes) {
			expect(outcome.output).toEqual(outcome.expected);
			expect(outcome.returned).toEqual({ leaseToken: 'lease-token', runnerId: 'runner-1', code: outcome.code,
				reason: outcome.code === 'execution_provider_unavailable'
					? 'Kata guest exited 1: Codex execution failed: Selected model is at capacity. Please try a different model.'
					: 'Kata guest exited 1: Agent timing-awareness contract requires first and final checks.', retryable: true,
				output: outcome.expected });
		}
	});
	it('native denied diagnostic and settlement deliveries preserve failed custody for exact closeout retry without another executor turn', async () => {
		for (const operation of ['reportUsage', 'settleAssignment'] as const) for (const denial of [
			{ status: 403, fault: '' }, { status: 503, fault: '' }, { status: 200, fault: 'reset' }, { status: 200, fault: 'json' },
		]) {
			const f = await portableKernel(); let api: Awaited<ReturnType<typeof closeoutTransport>> | undefined;
			try {
				const candidate = await f.candidate(), before = structuredClone(f.input.assignment);
				const outputs = { sandboxId: 'owned-failure-sandbox', teardown: { verified: false, completedAt: null } };
				const usage = { activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, nativeUsage: { input_tokens: 19, output_tokens: 3 } };
				f.setReply({ status: 'returned', code: 'sandbox_resource_exhausted', summary: 'original resource failure', retryable: true, outputs, usage: [usage] });
				api = await closeoutTransport(f); api.deny(operation, denial.status, denial.fault);
				let failure: unknown; try { await api.run(); } catch (error) { failure = error; }
				expect(failure).toBeInstanceOf(Error); expect(api.requests.filter(item => item.operation === operation)).toHaveLength(1);
				expect(api.requests.some(item => item.operation === 'returnAssignment')).toBe(false);
				if (operation === 'reportUsage') expect(api.requests.some(item => item.operation === 'settleAssignment')).toBe(false);
				await api.store.recordFailure(api.claim.id, failure instanceof Error ? failure.message : 'missing native denial');
				const failed = (await api.reopen().claimsForRecovery(true)).find(item => item.id === api!.claim.id);
				expect(failed?.closeoutOutput).toEqual({ ...outputs, artifacts: [] }); expect(failed?.leaseExpiresAt).toBe(f.attempt.deadline);
				const historical = structuredClone(api.requests); api.deny();
				if (operation === 'reportUsage') {
					const diagnostic = historical.find(item => item.operation === 'reportUsage');
					if (!diagnostic?.key) throw new Error('Original diagnostic idempotency required');
					await api.client.reportAssignmentUsage(f.attempt.id, diagnostic.body, diagnostic.key);
				}
				const settlement = historical.find(item => item.operation === 'settleAssignment');
				const body = { activeSeconds: 2, elapsedSeconds: 3, usageDimension: 'aggregate', usageActual: usage };
				if (settlement) expect(settlement.body).toEqual(body);
				await api.client.settleAssignment(f.attempt.id, body, `assignment-settlement:${f.attempt.id}:${f.input.runnerId}`);
				await api.client.returnAssignment(f.attempt.id, { leaseToken: f.input.leaseToken, runnerId: f.input.runnerId,
					code: 'sandbox_resource_exhausted', reason: 'original resource failure', retryable: true, output: outputs });
				expect(api.requests.slice(0, historical.length)).toEqual(historical);
				expect(api.requests.filter(item => item.operation === 'returnAssignment')).toHaveLength(1);
				expect(api.requests.at(-2)).toMatchObject({ operation: 'settleAssignment', body,
					key: `assignment-settlement:${f.attempt.id}:${f.input.runnerId}` });
				expect((await api.reopen().claimsForRecovery(true)).find(item => item.id === api!.claim.id)).toEqual(failed);
				expect(f.requests).toHaveLength(1); expect(f.input.assignment).toEqual(before);
				expect(f.git('rev-parse', 'HEAD')).toBe(candidate); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
			} finally { try { await api?.close(); } finally { await f.close(); } }
		}
	});
	it('real Kernel retains exact predecessor evidence and native source bytes while denying unassigned result inventories before execution', async () => {
		for (const variant of ['exact', 'missing', 'extra', 'duplicate', 'foreign-id', 'self-owned', 'reused-attempt']) {
			const f = await portableKernel(); try {
				// Two actual Git commits are fixture inputs; no BASE tests or model
				// were executed to produce the supplied failed verification record.
				const predecessorCommit = await f.candidate(['src/predecessor-evidence.txt']);
				const predecessorBytes = execFileSync('git', ['show', `${predecessorCommit}:src/predecessor-evidence.txt`], { cwd: f.checkout });
				const first = contextPredecessor(f.attempt, 'predecessor-one', 'earlier-attempt-one', predecessorCommit),
					second = contextPredecessor(f.attempt, 'predecessor-two', 'earlier-attempt-two', predecessorCommit);
				f.attempt.predecessorResultIds = [first.id, second.id];
				if (f.attempt.workspace.mode !== 'git') throw new Error('Original Git workspace required');
				f.attempt.workspace.baseCommit = predecessorCommit;
				f.attempt.contextRefs.push({ store: 'git', model: 'repository', id: 'predecessor-source', repository: f.attempt.workspace.repository, commit: predecessorCommit });
				const values = variant === 'missing' ? [first] : variant === 'extra' ? [first, second, { ...second, id: 'unassigned-result', assignmentId: 'another-attempt' }]
					: variant === 'duplicate' ? [first, first] : variant === 'foreign-id' ? [first, { ...second, id: 'foreign-result' }]
					: variant === 'self-owned' ? [first, { ...second, assignmentId: f.attempt.id }]
					: variant === 'reused-attempt' ? [first, { ...second, assignmentId: first.assignmentId }] : [second, first];
				f.input.assignment.workspaceContext = { assignmentAttempt: f.attempt, predecessorResults: values };
				const candidate = await f.candidate(), before = structuredClone(f.input.assignment), result = await f.run();
				if (variant === 'exact') {
					expect(result.status).toBe('completed'); expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
					expect(f.requests[0]).toMatchObject({ workspaceContext: { predecessorResults: values } });
					expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).references).toContainEqual({ kind: 'git', repository: f.attempt.workspace.repository, commit: candidate, branch: f.attempt.workspace.branch });
				} else {
					expect(result.status).toBe('failed'); expect(result.summary).toContain('assignment_predecessor_result_authority_mismatch');
					expect(result.outputs?.assignmentResult).toBeUndefined(); expect(f.requests).toEqual([]); expect(f.begin).toEqual([]);
				}
				expect(f.git('rev-parse', 'HEAD')).toBe(candidate); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
				expect(execFileSync('git', ['show', `${candidate}:src/predecessor-evidence.txt`], { cwd: f.checkout })).toEqual(predecessorBytes);
				expect(execFileSync('git', ['show', `${predecessorCommit}:src/predecessor-evidence.txt`], { cwd: f.checkout })).toEqual(predecessorBytes);
				expect(f.input.assignment).toEqual(before);
			} finally { await f.close(); }
		}
	});
	it('runs renamed YAML identities changed prompts and parameters through the same selected handler and exact native candidate', async () => {
		for (const name of ['renamed-boundary-agent', 'another-configured-builder']) {
			const f = await portableKernel(); try {
				const profile = portableProfile(name), selected = profile.activityProfiles.acting!;
				f.attempt.agentClass = profile.agentClass; f.attempt.effectiveProfile.profileRef.id = profile.id;
				f.attempt.effectiveProfile.prompt = { ...selected.prompt, system: `Changed governed prompt for ${name}.` };
				f.attempt.effectiveProfile.parameters = { temperature: 0.5 };
				const commit = await f.candidate(), before = structuredClone(f.input.assignment), result = await f.run();
				expect(result.status).toBe('completed'); const canonical = assignmentResultSchema.parse(result.outputs?.assignmentResult);
				expect(canonical.assignmentId).toBe(f.attempt.id); expect(canonical.references).toEqual([{ kind: 'git', repository: 'treeseed-ai/sdk', commit, branch: f.attempt.workspace.mode === 'git' ? f.attempt.workspace.branch : '' }]);
				expect(f.git('show', `${commit}:src/output.txt`)).toBe('exact candidate'); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
				expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1); expect(f.input.assignment).toEqual(before);
				expect(f.requests[0]).toMatchObject({ workspaceContext: { assignmentAttempt: { agentClass: name,
					effectiveProfile: { prompt: f.attempt.effectiveProfile.prompt, parameters: { temperature: 0.5 } } } } });
			} finally { await f.close(); }
		}
	});
	it('denies unavailable handlers wrong origins and unpinned builds before context transport or native publication', async () => {
		const outcomes: string[] = [];
		for (const mutation of ['unknown', 'origin', 'build']) {
			const f = await portableKernel(); try {
				if (mutation === 'unknown') f.attempt.effectiveProfile.handler = 'project/not-built';
				if (mutation === 'origin') f.attempt.effectiveProfile.handlerOrigin = 'project-runtime';
				if (mutation === 'build') f.attempt.provider.runtimeBuild = `sha256:${'f'.repeat(64)}`;
				const before = structuredClone(f.input.assignment), result = await f.run(); outcomes.push(result.status);
				expect(f.requests).toEqual([]); expect(f.begin).toEqual([]); expect(f.git('rev-parse', 'HEAD')).toBe(f.base); expect(f.input.assignment).toEqual(before);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(['failed', 'failed', 'failed']);
		for (const field of ['idempotencyKey', 'nodeId', 'source', 'authority', 'profile', 'offerId',
			'executionProviderId', 'modelConfigurationId', 'executionCapabilityId']) {
			const f = await portableKernel(); try {
				if (field === 'idempotencyKey') f.attempt.idempotencyKey = ` ${f.attempt.idempotencyKey} `;
				if (field === 'nodeId') f.attempt.nodeId = ` ${f.attempt.nodeId} `;
				if (field === 'source') f.attempt.sourceRef.id = ` ${f.attempt.sourceRef.id} `;
				if (field === 'authority') f.attempt.authorityRefs[0]!.id = ` ${f.attempt.authorityRefs[0]!.id} `;
				if (field === 'profile') f.attempt.effectiveProfile.profileRef.id = ` ${f.attempt.effectiveProfile.profileRef.id} `;
				if (field === 'offerId' || field === 'executionProviderId' || field === 'modelConfigurationId' || field === 'executionCapabilityId')
					f.attempt.provider[field] = ` ${f.attempt.provider[field]} `;
				const before = structuredClone(f.input.assignment), result = await f.run();
				expect(result.status, field).toBe('failed'); expect(result.code, field).toBe('assignment_attempt_invalid');
				expect(result.outputs?.assignmentResult).toBeUndefined(); expect(f.requests).toEqual([]); expect(f.begin).toEqual([]);
				expect(f.git('rev-parse', 'HEAD')).toBe(f.base); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
				expect(f.input.assignment).toEqual(before);
			} finally { await f.close(); }
		}
	});
	it('denies concrete changed paths outside the immutable grant while retaining the original reviewed base', async () => {
		const outcomes: string[] = [];
		for (const paths of [['tests/protected.test.ts'], ['src/../tests/protected.test.ts'], ['/tmp/unscoped'], []]) {
			const f = await portableKernel(); try {
				// The fixture creates only safe paths within its disposable checkout;
				// adversarial changed-path reports are transport inputs, not filesystem writes.
				await f.candidate(); const reply = f.getReply(); reply.outputs = { ...reply.outputs, changedPaths: paths }; f.setReply(reply);
				const before = structuredClone(f.input.assignment), result = await f.run(); outcomes.push(result.status);
				expect(f.git('rev-parse', 'fixture-base')).toBe(f.base); expect(f.input.assignment).toEqual(before);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(['failed', 'failed', 'failed', 'failed']);
		// These safe fixture paths are actual native commits, not merely
		// adversarial reported paths. Keep denied candidate bytes as evidence.
		for (const paths of [['tests/protected.test.ts'], ['src/output.txt', 'tests/protected.test.ts'], ['tests/protected.test.ts', 'src/output.txt']]) {
			const f = await portableKernel(); try {
				const candidate = await f.candidate(paths), reply = f.getReply(), before = structuredClone(f.input.assignment);
				const bytes = execFileSync('git', ['show', `${candidate}:tests/protected.test.ts`], { cwd: f.checkout });
				expect(f.git('diff', '--name-only', f.base, candidate).split('\n')).toContain('tests/protected.test.ts');
				expect(reply.outputs?.changedPaths).toEqual(paths);
				const result = await f.run();
				expect(result.status).toBe('failed'); expect(result.outputs?.assignmentResult).toBeUndefined();
				expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
				expect(f.input.assignment).toEqual(before); expect(f.getReply()).toEqual(reply);
				expect(f.git('rev-parse', 'HEAD')).toBe(candidate); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
				expect(execFileSync('git', ['show', `${candidate}:tests/protected.test.ts`], { cwd: f.checkout })).toEqual(bytes);
			} finally { await f.close(); }
		}
	});
	it('denies missing malformed and false timing boundaries from the native transport without accepting a canonical result', async () => {
		const outcomes: string[] = [];
		for (const value of [undefined, {}, { requiredChecks: 2, completedChecks: 1 },
			{ schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2,
				firstTool: 'source.read', lastTool: 'treedx:treeseed_time_status', firstToolSucceeded: true, lastToolSucceeded: true,
				firstToolCompliant: false, finalToolCompliant: true }]) {
			const f = await portableKernel(); try {
				await f.candidate(); const reply = f.getReply(); reply.outputs = { ...reply.outputs, timingAwareness: value }; f.setReply(reply);
				const result = await f.run(); outcomes.push(result.status); expect(result.outputs?.assignmentResult).toBeUndefined(); expect(f.requests).toHaveLength(1);
			} finally { await f.close(); }
		}
		expect(outcomes.every(status => status !== 'completed')).toBe(true);
	});
	it('denies coerced negative and nonfinite native measurements instead of manufacturing successful usage facts', async () => {
		const outcomes: string[] = [];
		for (const measurement of [{ elapsedSeconds: '2', inputTokens: 7 }, { elapsedSeconds: -1, inputTokens: 7 },
			{ elapsedSeconds: 2, inputTokens: '7' }, { elapsedSeconds: 2, inputTokens: -7 }, { elapsedSeconds: 2, activeSeconds: null }]) for (const leading of [[], [{ elapsedSeconds: 1, inputTokens: 1 }]]) {
			const f = await portableKernel(); try {
				const candidate = await f.candidate(); const reply = f.getReply(); reply.usage = [...leading, measurement]; f.setReply(reply);
				const before = structuredClone(reply), input = structuredClone(f.input.assignment), result = await f.run();
				outcomes.push(result.status); expect(result.outputs?.assignmentResult).toBeUndefined(); expect(result.usage).toEqual(before.usage);
				expect(f.getReply()).toEqual(before); expect(f.input.assignment).toEqual(input);
				expect(f.requests).toHaveLength(1); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base); expect(f.git('rev-parse', 'HEAD')).toBe(candidate);
			} finally { await f.close(); }
		}
		expect(outcomes.every(status => status !== 'completed')).toBe(true);
		const f = await portableKernel(); try {
			const candidate = await f.candidate(), reply = f.getReply(); reply.usage = [
				{ elapsedSeconds: 1.25, inputTokens: 6, outputTokens: 4, activeSeconds: 0.5, nativeUsage: { activeSeconds: 0.5 } },
				{ elapsedSeconds: 2.75, inputTokens: 14, outputTokens: 6, activeSeconds: 0.75, nativeUsage: { activeSeconds: 0.75 } }];
			f.setReply(reply); const before = structuredClone(reply), input = structuredClone(f.input.assignment), result = await f.run();
			expect(result.status).toBe('completed'); expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).usage).toEqual({
				elapsedSeconds: 4, modelInputTokens: 20, modelOutputTokens: 10, native: { activeSeconds: 1.25 } });
			expect(result.usage).toEqual(before.usage); expect(f.getReply()).toEqual(before); expect(f.input.assignment).toEqual(input);
			expect(f.requests).toHaveLength(1); expect(f.git('rev-parse', 'HEAD')).toBe(candidate); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
		} finally { await f.close(); }
	});
	it('preserves exact read-only Git citations without requesting or manufacturing a mutable workspace', async () => {
		const f = await portableKernel(); try {
			await f.candidate(); const reply = f.getReply(); f.attempt.workspace = { mode: 'read-only' };
			f.attempt.effectiveProfile.handler = 'writer'; f.attempt.grant.sourceWrite = []; f.attempt.grant.tools = ['source.read'];
			f.attempt.grant.sourceRead = ['readonly/context'];
			f.attempt.contextRefs = [{ store: 'git', model: 'repository', id: 'readonly-context', repository: 'readonly/context', commit: f.base }];
			reply.outputs = { ...reply.outputs, changedPaths: [], contentReferences: [{ kind: 'git', repository: 'readonly/context', commit: f.base }] };
			f.setReply(reply); const before = structuredClone(f.input.assignment), result = await f.run();
			expect(result.status).toBe('completed'); expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).references)
				.toEqual([{ kind: 'git', repository: 'readonly/context', commit: f.base }]);
			expect(f.input.assignment).toEqual(before); expect(f.requests).toHaveLength(1);
		} finally { await f.close(); }
	});
	it('retains denied reset and malformed transport failures without an automatic second model turn', async () => {
		const outcomes: string[] = [];
		for (const [status, fault] of [[403, ''], [200, 'reset'], [200, 'json']] as const) {
			const f = await portableKernel(); try {
				await f.candidate(); f.setReply(f.getReply(), status, fault); const before = structuredClone(f.input.assignment);
				outcomes.push((await f.run()).status); expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1); expect(f.input.assignment).toEqual(before);
			} finally { await f.close(); }
		}
		expect(outcomes.every(status => status !== 'completed')).toBe(true);
	});
	it('denies cancelled expired and malformed attempts before the real executor begins', async () => {
		const outcomes: string[] = [];
		for (const mutation of ['cancel', 'expire', 'ordinal']) {
			const f = await portableKernel(); try {
				if (mutation === 'cancel') { const abort = new AbortController(); abort.abort(); f.input.signal = abort.signal; }
				if (mutation === 'expire') f.attempt.deadline = '2000-01-01T00:00:00.000Z';
				if (mutation === 'ordinal') f.input.assignment.assignmentAttempt = { ...f.attempt, attempt: '1' };
				const before = structuredClone(f.input.assignment); outcomes.push((await f.run()).status);
				expect(f.requests).toEqual([]); expect(f.begin).toEqual([]); expect(f.git('rev-parse', 'HEAD')).toBe(f.base); expect(f.input.assignment).toEqual(before);
				if (mutation !== 'ordinal') expect(assignmentAttemptSchema.parse(f.input.assignment.assignmentAttempt).id).toBe(f.attempt.id);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(['failed', 'failed', 'failed']);
	});
});
