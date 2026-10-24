import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAssignmentTreeDxTool } from '../../../../src/provider/execution/microvm-executor.ts';
import { providerExecutionProgress } from '../../../../src/kernel/handlers/model-workload.ts';
import { codexThreadId, codexTreeDxMcpConfig, completedTimeStatusChecks, prepareNodeWorkspace, providerEventShapeSummary, providerResourceAbort, providerResponsePreview, requiresNodeDependencyRestore, timingAwarenessContract, timingRecoveryEligible, treeDxToolDefinitions, verifyReportedActivityCommands } from '../../../../src/kernel/handlers/model-workload.ts';
import { assertArchitectSourceCitation, assertReplayableVerificationCommand, assertTesterFailureEvidence, attachObservedTesterFailures, correctObservedTestFirstRedVerification, omitUnreplayableVerification, codexInteractiveTimeoutMs, codexProjectInstructionArguments, codexReasoningArguments, completionFrontmatterSchema, completionOutputTargetVariants, validateModelContext, promptFromContext, requiresActivityCompletion } from '../../../../src/kernel/handlers/model-workload-contract.ts';
import { assertPredecessorSynthesis } from '../../../../src/kernel/handlers/planning-synthesis.ts';
import { activityCompletionOutputSchema } from '../../../../src/activity-completion.ts';
import { activityAllowsVerification } from '../../../../src/kernel/handlers/model-workload-contract.ts';
import { architectureTaskInstructions } from '../../architecture/knowledge-task-fixture.ts';
import { request as executionRequest } from '../../kernel/provider-kernel-fixture.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
describe('Codex chat executor', () => {
	it('does not install dependencies for read-only planning, estimating, chat, or Architecture knowledge', () => {
		for (const activity of ['planning', 'estimating', 'chat']) {
			expect(activityAllowsVerification(activity, 'tester', 'git')).toBe(false);
		}
		for (const agentClass of ['architect', 'configured-author']) {
			expect(activityAllowsVerification('acting', agentClass, 'treedx', ['Do not claim test verification.'])).toBe(false);
		}
		for (const activity of ['acting', 'reviewing', 'releasing']) {
			expect(activityAllowsVerification(activity, 'tester', 'git')).toBe(true);
		}
	});
	it('preserves tool and model progress categories without secret-bearing payloads', () => {
		expect(providerExecutionProgress({ type: 'item.started', item: { type: 'mcp_tool_call', arguments: { token: 'secret' } } }))
			.toBe('provider.tool.started');
		expect(providerExecutionProgress({ type: 'item.completed', item: { type: 'mcp_tool_call', result: 'secret' } }))
			.toBe('provider.tool.completed');
		expect(providerExecutionProgress({ type: 'item.completed', item: { type: 'reasoning', text: 'secret' } }))
			.toBe('provider.reasoning.completed');
		expect(providerExecutionProgress({ type: 'turn.started' })).toBe('provider.turn.started');
		expect(providerExecutionProgress({ type: 'turn.completed', usage: { secret: 'secret' } })).toBe('provider.turn.completed');
	});
	it('reports command progress without arguments, output, or credentials', () => {
		expect(providerExecutionProgress({ type: 'item.started', item: { type: 'command_execution', command: 'npm pack --token secret-value' } }))
			.toBe('provider.command.started.pack');
		expect(providerExecutionProgress({ type: 'item.completed', item: { type: 'command_execution', command: 'npm run release:verify', exit_code: 1, aggregated_output: 'secret-value' } }))
			.toBe('provider.command.completed.release-checks.exit-1');
		expect(providerExecutionProgress({ type: 'item.started', item: { type: 'command_execution', command: 'curl secret-value' } }))
			.toBe('provider.command.started.other');
		expect(providerExecutionProgress({ type: 'item.started', item: { type: 'agent_message', text: 'secret-value' } })).toBeNull();
	});
	it('keeps recovered inner-tool resource outcomes distinct from unsuccessful provider execution', () => {
		for (const [exit_code, aggregated_output] of [[134, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\nAborted\n'], [137, 'Killed\n']] as const) {
			const events = [{ type: 'item.completed', item: { type: 'command_execution', command: 'npx tsc --noEmit -p tsconfig.json', exit_code, aggregated_output } }];
			const before = structuredClone(events);
			expect(providerResourceAbort(events, false)).toBeNull();
			expect(providerResourceAbort(events, true)).toEqual({ exitCode: exit_code, command: 'npx tsc --noEmit -p tsconfig.json' });
			expect(events).toEqual(before);
		}
	});
	it('classifies only evidenced resource exhaustion, not a generic command abort', () => {
		expect(providerResourceAbort([{ type: 'item.completed', item: { type: 'command_execution',
			command: 'npm run build', aggregated_output: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\nAborted\n', exit_code: 134 } }], true))
			.toEqual({ exitCode: 134, command: 'npm run build' });
		expect(providerResourceAbort([{ type: 'item.completed', item: { type: 'command_execution',
			command: 'npm run build', aggregated_output: 'Aborted\n', exit_code: 134 } }], true)).toBeNull();
		expect(providerResourceAbort([{ type: 'item.completed', item: { type: 'command_execution',
			command: 'npm run build', aggregated_output: 'Killed\n', exit_code: 137 } }], true))
			.toEqual({ exitCode: 137, command: 'npm run build' });
		expect(providerResourceAbort([{ type: 'item.completed', item: { type: 'command_execution',
			command: 'npm test', aggregated_output: 'assertion failed\n', exit_code: 1 } }], true)).toBeNull();
	});
	it('honors profile-owned Architecture Book instructions and an exact knowledge-only grant after a rename', () => {
		const bookRef = { store: 'treedx', model: 'book', id: 'sdk-architecture', repository: 'library', commit: '9'.repeat(40),
			path: 'books/architecture.md', revision: 1, digest: `sha256:${'b'.repeat(64)}` };
		const context = { projectManifest: { source: { commit: 'c'.repeat(40) } }, canonicalAssignmentContext: { assignment: { id: 'architect-1', agentClass: 'architect', projectId: 'sdk',
			workspace: { mode: 'treedx' }, effectiveProfile: { activity: 'acting', handler: 'writer', prompt: { system: 'Follow the governed source audit.', instructions: architectureTaskInstructions('c'.repeat(40)) } },
			contextRefs: [bookRef], grant: { contentWrite: [{ model: 'knowledge', id: 'architect-knowledge', repository: 'library',
				commit: 'a'.repeat(40), path: 'knowledge/sdk-architecture/architect-knowledge.md' }] } }, context: [], predecessorResults: [] } };
		expect(promptFromContext(context)).toContain('model exactly "knowledge"');
		expect(promptFromContext(context)).toContain('bookRef equal to the exact authorized Architecture Book reference');
		expect(promptFromContext(context)).toContain('A negative claim about what is absent from serialized request bytes needs evidence from the actual serializer or request-construction path');
		expect(promptFromContext(context)).toContain('Copy every related reference ID, commit, and digest exactly from the authorized context');
		expect(promptFromContext(context)).toContain(`The exact attached project Git source commit is ${'c'.repeat(40)}`);
		expect(promptFromContext(context)).toContain(`FINAL SOURCE AUDIT: In contentOutput.body, every phrase claiming an SDK or project Git source commit must use exactly ${'c'.repeat(40)}`);
		expect(promptFromContext(context)).toContain('Return verification: []: source inspection belongs in the page body');
		expect(() => assertArchitectSourceCitation({ contentOutput: { model: 'knowledge', body: `Source ${'a'.repeat(40)}` } } as never,
			'c'.repeat(40), 'architect', 'acting')).toThrow('project_source_commit_citation_missing');
		expect(() => assertArchitectSourceCitation({ contentOutput: { model: 'knowledge', body: `Source ${'c'.repeat(40)}` } } as never,
			'c'.repeat(40), 'architect', 'acting')).not.toThrow();
		expect(() => assertArchitectSourceCitation({ contentOutput: { model: 'knowledge', body: `At authorized SDK commit \`${'a'.repeat(40)}\`, with proposal \`${'c'.repeat(40)}\`.` } } as never,
			'c'.repeat(40), 'architect', 'acting')).toThrow('project_source_commit_citation_mismatch');
		const schema = activityCompletionOutputSchema(completionFrontmatterSchema(context), true, completionOutputTargetVariants(context));
		expect((schema.properties.contentOutput as { anyOf: Array<{ properties?: { model?: unknown } }> }).anyOf[0]?.properties?.model)
			.toEqual({ type: 'string', const: 'knowledge' });
		expect((schema.properties.contentOutput as { anyOf: Array<{ properties?: { frontmatter?: { properties?: { id?: unknown } } } }> }).anyOf[0]?.properties?.frontmatter?.properties?.id)
			.toEqual({ type: 'string', const: 'architect-knowledge' });
		expect(completionOutputTargetVariants(context)[0]?.frontmatter.properties).toMatchObject({
			slug: { type: 'string', const: 'architect-knowledge' },
			bookRef: { type: 'object', additionalProperties: false,
				properties: { store: { type: 'string', const: 'treedx' }, model: { type: 'string', const: 'book' },
					revision: { type: 'number', const: 1 } }, required: Object.keys(bookRef) },
		});
		expect(() => completionOutputTargetVariants({ ...context, canonicalAssignmentContext: {
			...context.canonicalAssignmentContext, assignment: { ...context.canonicalAssignmentContext.assignment,
				contextRefs: [{ ...bookRef, digest: undefined }] } } })).toThrow('writer_knowledge_target_invalid');
		const checkSchema = (node: unknown, path = '$'): void => {
			const value = node as Record<string, unknown>;
			expect(typeof value.type === 'string' || Array.isArray(value.type) || Array.isArray(value.anyOf), path).toBe(true);
			if (value.type === 'object') {
				expect(value.additionalProperties).toBe(false);
				expect(value.required).toEqual(Object.keys(value.properties as Record<string, unknown>));
				Object.entries(value.properties as Record<string, unknown>).forEach(([name, child]) => checkSchema(child, `${path}.${name}`));
			}
			if (value.type === 'array') checkSchema(value.items, `${path}[]`);
			if (Array.isArray(value.anyOf)) value.anyOf.forEach((child, index) => checkSchema(child, `${path}.anyOf[${index}]`));
		};
		checkSchema(schema);
		expect((schema.properties.contentOutput as { anyOf: unknown[] }).anyOf).toHaveLength(1);
		const before = promptFromContext(context); context.canonicalAssignmentContext.assignment.agentClass = 'configured-author';
		expect(promptFromContext(context).split('\n\n').slice(0, -1)).toEqual(before.split('\n\n').slice(0, -1));
		for (const instruction of architectureTaskInstructions('c'.repeat(40))) expect(before.split(instruction)).toHaveLength(2);
	});
	it('requires structured completion only for a mutable legacy source workspace', () => {
		expect(requiresActivityCompletion('work')).toBe(true);
		expect(requiresActivityCompletion('read')).toBe(false);
	});
	it('rejects retired workday context and exposes no semantic publication tools', () => {
		expect(() => promptFromContext({ assignment: { executionKind: 'workday' } })).toThrow('legacy_workday_assignment_not_supported');
		expect(treeDxToolDefinitions().map(tool => tool.name)).not.toContain('treeseed_publish_review');
		expect(treeDxToolDefinitions().map(tool => tool.name)).toContain('treeseed_time_status');
	});
	it('rejects a Reviewer assignment without an accepted decision', () => {
		expect(() => validateModelContext({ canonicalAssignmentContext: { assignment: {
			id: 'assignment-review', sourceRef: { model: 'proposal', id: 'proposal-1', commit: 'proposal-commit' },
			workspace: { mode: 'treedx' }, effectiveProfile: { activity: 'reviewing', handler: 'writer',
				prompt: { system: 'Review the proposal.' } },
		}, context: [], predecessorResults: [] } })).toThrow('work_review_requires_accepted_decision');
	});
	it('requires test-first actors to report each acceptance boundary independently', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'test-first', agentClass: 'tester', sourceRef: { model: 'proposal', id: 'proposal-1' },
			workspace: { mode: 'git' }, effectiveProfile: { activity: 'acting', handler: 'writer', prompt: { system: 'Perform only the governed task.' } },
			acceptanceCriteria: ['Reject caller-authored fields.', 'Report failing test names and paths.'],
		}, context: [], predecessorResults: [] } });
		expect(() => assertTesterFailureEvidence({ summary: 'Added tests-first coverage.' } as never,
			'tester', 'acting', ['Report failing test names and paths.'])).toThrow('test_first_failure_evidence_missing');
		expect(() => assertTesterFailureEvidence({ summary: 'Frozen-base failing tests:\n- tests/unit/example.test.ts: rejects duplicate decision IDs' } as never,
			'tester', 'acting', ['Report failing test names and paths.'])).not.toThrow();
		const observed = attachObservedTesterFailures({ summary: 'Added test coverage.' } as never,
			[{ type: 'item.completed', item: { type: 'command_execution', command: 'npx vitest run tests/unit/example.test.ts', exit_code: 1,
				aggregated_output: ' FAIL  tests/unit/example.test.ts > decision selection > rejects duplicates\n Test Files 1 failed\n' } }],
			'tester', 'acting', ['Report failing test names and paths.']);
		expect(observed?.summary).toContain('Frozen-base failing tests:\n- tests/unit/example.test.ts: FAIL');
		expect(() => assertTesterFailureEvidence(observed, 'tester', 'acting', ['Report failing test names and paths.'])).not.toThrow();
		const redCommand = 'npx vitest run tests/unit/example.test.ts';
		const mislabeled = { summary: observed?.summary ?? '', verification: [{ status: 'passed', summary: 'red tests', commands: [redCommand] }] };
		const corrected = correctObservedTestFirstRedVerification(mislabeled as never,
			[{ type: 'item.completed', item: { type: 'command_execution', command: redCommand, exit_code: 1 } }],
			'tester', 'acting', ['Report failing test names and paths.']);
		expect(corrected.verification[0]?.status).toBe('failed');
		expect(correctObservedTestFirstRedVerification(mislabeled as never, [], 'tester', 'acting',
			['Report failing test names and paths.']).verification[0]?.status).toBe('passed');
		const omitted = omitUnreplayableVerification({ summary: 'Built candidate.', verification: [
			{ status: 'passed', summary: 'chained', commands: ['git merge-base --is-ancestor abc HEAD && npm run build'] },
			{ status: 'passed', summary: 'focused', commands: ['npm run build'] },
		] } as never);
		expect(omitted.verification).toEqual([{ status: 'passed', summary: 'focused', commands: ['npm run build'] }]);
		expect(omitted.summary).toContain('those gates remain unproven');
	});
	it('requires later planning cycles, but not focused estimates, to cite predecessor results', () => {
		const context = { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'planning', prompt: { system: 'Synthesize the governed contributions.' } } },
			predecessorResults: [{ id: 'result-a' }, { id: 'result-b' }] } };
		const prompt = promptFromContext(context);
		expect(prompt).toContain('result-a');
		expect(() => assertPredecessorSynthesis(context, { schemaVersion: 'treeseed.activity-completion/v1',
			summary: '- result-a: Incorporated scoped evidence.', verification: [], reviewDisposition: null,
			contentOutput: null }))
			.toThrow('predecessor_result_citation_missing:result-b');
		expect(() => assertPredecessorSynthesis(context, { schemaVersion: 'treeseed.activity-completion/v1',
			summary: '- result-a: Supplied scope.\n- result-b: Supplied risks.', verification: [], reviewDisposition: null,
			contentOutput: null }))
			.not.toThrow();
		const estimateContext = { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'estimating', prompt: { system: 'Estimate only the governed scope.' } } },
			predecessorResults: [{ id: 'result-a' }, { id: 'result-b' }] } };
		expect(promptFromContext(estimateContext)).not.toContain('Collaborative synthesis is mandatory');
		expect(() => assertPredecessorSynthesis(estimateContext, { schemaVersion: 'treeseed.activity-completion/v1',
			summary: 'Focused estimate.', verification: [], reviewDisposition: null,
			contentOutput: { model: 'proposal', body: 'Sizing only the assigned work item.', frontmatter: {} } }))
			.not.toThrow();
	});
	it('passes the configured reasoning effort to Codex', () => {
		expect(codexReasoningArguments('high')).toEqual(['-c', 'model_reasoning_effort=high']);
		expect(codexReasoningArguments(undefined)).toEqual([]);
	});
	it('respects the configured activity runtime for deeper chat reasoning', () => {
		expect(codexInteractiveTimeoutMs(900)).toBe(895_000);
		expect(codexInteractiveTimeoutMs(20)).toBe(15_000);
	});
	it('accepts passing verification only after the guest runner observes every command', async () => {
		const observed: string[] = [];
		await verifyReportedActivityCommands({ schemaVersion: 'treeseed.activity-completion/v1', summary: 'done', reviewDisposition: null, contentOutput: null,
			verification: [{ status: 'passed', summary: 'focused tests passed', commands: ['npm test -- focused'] }] }, async (command) => { observed.push(command); });
		expect(observed).toEqual(['npm test -- focused']);
	});
	it('rejects a claimed pass when runner observation fails', async () => {
		await expect(verifyReportedActivityCommands({ schemaVersion: 'treeseed.activity-completion/v1', summary: 'done', reviewDisposition: null, contentOutput: null,
			verification: [{ status: 'passed', summary: 'claimed pass', commands: ['false'] }] }, async () => { throw new Error('exit 1'); })).rejects.toThrow(/Runner-observed verification failed/u);
	});
	it('rejects excessive verification before running any command', async () => {
		const execute = vi.fn(async () => {});
		const report = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Checks', reviewDisposition: null, contentOutput: null,
			verification: Array.from({ length: 9 }, (_, index) => ({ status: 'passed' as const, summary: 'Check', commands: [`git show HEAD:${index}`] })) };
		await expect(verifyReportedActivityCommands(report, execute)).rejects.toThrow('9/8 commands');
		await expect(verifyReportedActivityCommands({ ...report, verification: [{ status: 'passed', summary: 'Check', commands: ['x'.repeat(4097)] }] }, execute))
			.rejects.toThrow('4097/4096 characters');
		expect(execute).not.toHaveBeenCalled();
	});
	it('rejects compound, setup, and source-mutating commands as verification evidence', async () => {
		expect(() => assertReplayableVerificationCommand('npm test && git add . && git commit -m test')).toThrow(/one standalone command/u);
		expect(() => assertReplayableVerificationCommand('git commit -am test')).toThrow(/may not mutate/u);
		expect(() => assertReplayableVerificationCommand('npm ci')).toThrow(/may not mutate/u);
		expect(assertReplayableVerificationCommand('git diff --check')).toBe('git diff --check');
		expect(assertReplayableVerificationCommand('git merge-base --is-ancestor HEAD~1 HEAD')).toBe('git merge-base --is-ancestor HEAD~1 HEAD');
		expect(assertReplayableVerificationCommand('npm test -- focused')).toBe('npm test -- focused');
		expect(assertReplayableVerificationCommand("find /workspace/project -maxdepth 2 -mindepth 1 -printf '%y %p\\n' | head -100"))
			.toContain('| head -100');
		expect(() => assertReplayableVerificationCommand('npm test || true')).toThrow(/one standalone command/u);
		expect(() => assertReplayableVerificationCommand("git show --no-patch --format='%H%n%P%n%s' abc123 2>&1")).toThrow(/one standalone command/u);
		expect(assertReplayableVerificationCommand('node -e "const result = values.map(value => value > 0); if (!result[0]) process.exit(1)"'))
			.toContain('value => value > 0');
		expect(() => assertReplayableVerificationCommand('node test.js > result.txt')).toThrow(/one standalone command/u);
		expect(() => assertReplayableVerificationCommand('node -e "console.log($(whoami))"')).toThrow(/one standalone command/u);
	});
	it('restores Node dependencies for script and executable verification commands', () => {
		expect(requiresNodeDependencyRestore('npm run test:unit')).toBe(true);
		expect(requiresNodeDependencyRestore('npm exec vitest -- tests/example.test.ts')).toBe(true);
		expect(requiresNodeDependencyRestore('npx vitest tests/example.test.ts')).toBe(true);
		expect(requiresNodeDependencyRestore('git diff --check')).toBe(false);
	});
	it('prepares a source-backed Node workspace before model execution', async () => {
		const execute = vi.fn(async () => undefined);
		const root = await mkdtemp(join(tmpdir(), 'treeseed-node-workspace-'));
		await writeFile(join(root, 'package.json'), '{}');
		await writeFile(join(root, 'package-lock.json'), '{}');
		expect(await prepareNodeWorkspace(root, 'http://assignment-proxy', execute)).toBe(true);
		expect(execute).toHaveBeenCalledWith('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'],
			expect.objectContaining({ cwd: root, timeoutMs: 120_000,
				env: expect.objectContaining({ HTTPS_PROXY: 'http://assignment-proxy', https_proxy: 'http://assignment-proxy',
					GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
					GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'ssh://git@github.com/',
					GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:' }) }));
	});
	it('requires the assignment TreeDX MCP server and gives it only ephemeral relay authority', () => {
		const config = codexTreeDxMcpConfig('sandbox-1', 'one-use-token', { network: { relayUrl: 'https://relay.invalid' } } as never);
		expect(config).toContain('required = true');
		// This Codex runtime fails closed without its code-mode host.
		expect(config).toContain('[features]\ncode_mode_host = true');
		expect(config).toContain('startup_timeout_sec = 10');
		expect(config).toContain('TREESEED_GUEST_TOKEN = "one-use-token"');
		expect(config).toContain('TREESEED_RELAY_URL = "https://relay.invalid"');
	});
});
