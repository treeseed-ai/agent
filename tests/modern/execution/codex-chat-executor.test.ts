import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAssignmentTreeDxTool } from '../../../src/provider/execution/microvm-executor.ts';
import { providerExecutionProgress } from '../../../src/sandbox/guest.ts';
import { codexThreadId, codexTreeDxMcpConfig, completedTimeStatusChecks, prepareNodeWorkspace, providerEventShapeSummary, providerResourceAbort, providerResponsePreview, requiresNodeDependencyRestore, timingAwarenessContract, timingRecoveryEligible, treeDxToolDefinitions, verifyReportedActivityCommands } from '../../../src/sandbox/guest.ts';
import { assertArchitectSourceCitation, assertPredecessorSynthesis, assertReplayableVerificationCommand, assertTesterFailureEvidence, attachObservedTesterFailures, correctObservedTesterRedVerification, omitUnreplayableVerification, codexInteractiveTimeoutMs, codexProjectInstructionArguments, codexReasoningArguments, completionFrontmatterSchema, completionOutputTargetVariants, promptFromContext, requiresActivityCompletion } from '../../../src/sandbox/guest-contract.ts';
import { activityCompletionOutputSchema } from '../../../src/activity-completion.ts';
import { activityAllowsVerification } from '../../../src/sandbox/guest-contract.ts';

describe('Codex chat executor', () => {
	it('does not install dependencies for read-only planning, estimating, chat, or Architecture knowledge', () => {
		for (const activity of ['planning', 'estimating', 'chat']) {
			expect(activityAllowsVerification(activity, 'tester', 'git')).toBe(false);
		}
		expect(activityAllowsVerification('acting', 'architect', 'treedx')).toBe(false);
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
	it('classifies only evidenced resource exhaustion, not a generic command abort', () => {
		expect(providerResourceAbort([{ type: 'item.completed', item: { type: 'command_execution',
			command: 'npm run build', aggregated_output: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\nAborted\n', exit_code: 134 } }]))
			.toEqual({ exitCode: 134, command: 'npm run build' });
		expect(providerResourceAbort([{ type: 'item.completed', item: { type: 'command_execution',
			command: 'npm run build', aggregated_output: 'Aborted\n', exit_code: 134 } }])).toBeNull();
		expect(providerResourceAbort([{ type: 'item.completed', item: { type: 'command_execution',
			command: 'npm run build', aggregated_output: 'Killed\n', exit_code: 137 } }]))
			.toEqual({ exitCode: 137, command: 'npm run build' });
		expect(providerResourceAbort([{ type: 'item.completed', item: { type: 'command_execution',
			command: 'npm test', aggregated_output: 'assertion failed\n', exit_code: 1 } }])).toBeNull();
	});
	it('requires Architect acting output to be Architecture Book knowledge, not an arbitrary Note', () => {
		const bookRef = { store: 'treedx', model: 'book', id: 'sdk-architecture', repository: 'library', commit: '9'.repeat(40),
			path: 'books/architecture.md', revision: 1, digest: `sha256:${'b'.repeat(64)}` };
		const context = { projectManifest: { source: { commit: 'c'.repeat(40) } }, canonicalAssignmentContext: { assignment: { id: 'architect-1', agentClass: 'architect', projectId: 'sdk',
			workspace: { mode: 'treedx' }, effectiveProfile: { activity: 'acting', handler: 'writer', prompt: {} },
			contextRefs: [bookRef], grant: { contentWrite: [{ model: 'knowledge', id: 'architect-knowledge', repository: 'library',
				commit: 'a'.repeat(40), path: 'knowledge/sdk-architecture/architect-knowledge.md' },
			{ model: 'note', id: 'architect-note' }] } }, context: [], predecessorResults: [] } };
		expect(promptFromContext(context)).toContain('model exactly "knowledge"');
		expect(promptFromContext(context)).toContain('bookRef equal to the exact authorized Architecture Book reference');
		expect(promptFromContext(context)).toContain('A negative claim about what is absent from serialized request bytes needs evidence from the actual serializer or request-construction path');
		expect(promptFromContext(context)).toContain('Copy every related reference ID, commit, and digest exactly from the authorized context');
		expect(promptFromContext(context)).toContain(`The exact attached project Git source commit is ${'c'.repeat(40)}`);
		expect(promptFromContext(context)).toContain(`FINAL SOURCE AUDIT: In contentOutput.body, every phrase claiming an SDK or project Git source commit must use exactly ${'c'.repeat(40)}`);
		expect(promptFromContext(context)).toContain('Return verification: []: source inspection belongs in the page body');
		expect(() => assertArchitectSourceCitation({ contentOutput: { body: `Source ${'a'.repeat(40)}` } } as never,
			'c'.repeat(40), 'architect', 'acting')).toThrow('project_source_commit_citation_missing');
		expect(() => assertArchitectSourceCitation({ contentOutput: { body: `Source ${'c'.repeat(40)}` } } as never,
			'c'.repeat(40), 'architect', 'acting')).not.toThrow();
		expect(() => assertArchitectSourceCitation({ contentOutput: { body: `At authorized SDK commit \`${'a'.repeat(40)}\`, with proposal \`${'c'.repeat(40)}\`.` } } as never,
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
	});
	it('keeps Researcher content-only findings out of executable verification', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'research-1', agentClass: 'researcher', workspace: { mode: 'treedx' },
			effectiveProfile: { activity: 'acting', handler: 'writer', prompt: {} },
			acceptanceCriteria: ['Return exact source refs; do not claim test verification.'],
		}, context: [], predecessorResults: [] } });
		expect(prompt).toContain('If it says not to claim test verification, verification must be []');
		expect(prompt).toContain('relatedRefs, include a Git reference only when it has both the exact authorized repository ID and its 40-character source commit');
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
	it('directs source-backed chat to the mounted repository and TreeDX MCP rather than the host CLI', () => {
		const prompt = promptFromContext({
			identity: { manifest: { agentHandle: '@sdk/architect' } },
			assignment: { executionKind: 'communication', metadata: { communication: { requirement: 'required' }, chatProfile: {
				prompt: { system: 'Answer with evidence.', task: 'Research the current project.' },
			} } },
			projectManifest: { revision: 'exact-commit' }, coreContext: { sources: [] },
			message: { content: 'Describe the state of the project.' },
		}, undefined, 180);
		expect(prompt).toContain('attached at /workspace/project at immutable revision exact-commit');
		expect(prompt).toContain('For questions about current code or implementation state, inspect the relevant repository files');
		expect(prompt).toContain('For coordination or role/dependency discussion already grounded in the exact proposal and TreeDX context, do not scan the repository without a concrete source question');
		expect(prompt).toContain('If the first clock reports at most 120 seconds, make no more than one targeted source search and two exact file reads');
		expect(prompt).toContain('with 45 seconds or less, make the required final clock check and answer immediately');
		expect(prompt).toContain('the deadline is a ceiling, not a target');
		expect(prompt).toContain('treedx_* MCP tools');
		expect(prompt).toContain('Do not invoke trsd');
		expect(prompt).toMatch(/^MANDATORY ASSIGNMENT CLOCK:/u);
		expect(prompt).toContain('You have 180 productive seconds');
		expect(prompt).toContain('Your FIRST tool action must call mcp__treedx__treeseed_time_status');
		expect(prompt).toContain("independently of the activity profile's grant.tools list");
		expect(prompt).toContain('call mcp__treedx__treeseed_time_status again as your FINAL tool action');
		expect(prompt).toContain('including a failed attempt');
		expect(prompt).toContain('text(await tools.mcp__treedx__treeseed_time_status({}));');
		expect(prompt).toContain('not as a directly callable outer tool');
		expect(prompt).toContain('fewer than two successful clock checks is rejected');
		expect(prompt).toContain('Complete every shell command, verification, inspection, and other tool action before the final clock check');
		expect(prompt).toMatch(/DO NOT ANSWER OR REASON ABOUT THE TASK YET[\s\S]*call time status again so it is truly your final tool action\.$/u);
		expect(prompt).toContain('The provider publishes your final plain Markdown reply to the Discussion');
		expect(prompt).toContain('you do not need or have a discussion-write tool');
		expect(prompt).toContain('Do not report a missing discussion-write tool as a blocker');
		expect(codexProjectInstructionArguments()).toEqual(['-c', 'project_doc_max_bytes=0']);
	});
	it('accepts timing awareness only from completed model-initiated clock checks', () => {
		expect(completedTimeStatusChecks([
			{ type: 'item.started', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'in_progress' } },
			{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null } },
			{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null } },
		])).toBe(2);
		expect(completedTimeStatusChecks([
			{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'failed', error: 'unavailable' } },
		])).toBe(0);
	});
	it('requires clock checks to bracket every other provider tool action', () => {
		const clock = { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null } };
		const command = { type: 'item.completed', item: { type: 'command_execution', status: 'completed', error: null } };
		expect(timingAwarenessContract([clock, command, clock])).toMatchObject({
			completedChecks: 2, firstToolCompliant: true, finalToolCompliant: true,
		});
		expect(timingAwarenessContract([command, clock, clock])).toMatchObject({ firstToolCompliant: false });
		expect(timingAwarenessContract([clock, clock, command])).toMatchObject({ finalToolCompliant: false });
		expect(timingRecoveryEligible(timingAwarenessContract([clock, command]), 20_000)).toBe(true);
		expect(timingRecoveryEligible(timingAwarenessContract([command, clock]), 20_000)).toBe(false);
		expect(timingRecoveryEligible(timingAwarenessContract([clock, command, clock]), 20_000)).toBe(false);
		expect(timingRecoveryEligible(timingAwarenessContract([clock, command, clock, command]), 20_000)).toBe(true);
		expect(codexThreadId([{ type: 'thread.started', thread_id: '12345678-1234-1234-1234-123456789abc' }])).toBe('12345678-1234-1234-1234-123456789abc');
		expect(codexThreadId([{ type: 'thread.started', thread_id: '../other-session' }])).toBeNull();
		expect(timingAwarenessContract([
			{ type: 'item.started', item: { type: 'mcp_tool_call', server: 'treedx', tool: 'wrong_clock_alias', status: 'in_progress' } },
			clock, clock,
		])).toMatchObject({ firstTool: 'treedx:wrong_clock_alias', firstToolCompliant: false });
	});
	it.each(['planning', 'estimating', 'acting', 'reviewing', 'chat'] as const)(
		'applies the same first/final clock boundary to %s', (activity) => {
			const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
				id: `assignment-${activity}`, workspace: { mode: 'read-only' },
				...(activity === 'reviewing' ? { authorityRefs: [{ model: 'decision', id: 'accepted-decision' }] } : {}),
				effectiveProfile: { activity, handler: 'writer', prompt: { system: 'Complete the assigned work.' } },
			}, context: [], predecessorResults: [] } });
			expect(prompt).toMatch(/^MANDATORY ASSIGNMENT CLOCK:/u);
			expect(prompt).toContain('Your FIRST tool action must call mcp__treedx__treeseed_time_status');
			expect(prompt).toContain('call mcp__treedx__treeseed_time_status again as your FINAL tool action');
		},
	);
	it('summarizes provider event shapes without retaining arguments or output', () => {
		expect(providerEventShapeSummary([{ type: 'item.completed', item: {
			type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed',
			arguments: { secret: 'never retain' }, result: { remainingSeconds: 42 },
	} }])).toEqual([{ type: 'item.completed', itemType: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null }]);
	});
	it('redacts the last provider response used to diagnose a missing clock boundary', () => {
		expect(providerResponsePreview([{ type: 'item.completed', item: { type: 'agent_message', text: 'Cannot call sk-secret.' } }], ['sk-secret']))
			.toBe('Cannot call [redacted].');
	});
	it('reports remaining time from the API-started productive window without a content grant', async () => {
		const deadlineAt = new Date(Date.now() + 60_000).toISOString();
		const result = await executeAssignmentTreeDxTool({} as never, 'treeseed_time_status', {}, {
			startedAt: new Date().toISOString(), deadlineAt,
		});
		expect(result).toMatchObject({ deadlineAt });
		expect(Number((result as Record<string, unknown>).remainingSeconds)).toBeGreaterThan(55);
	});
	it('requires structured activities to report replayable checks as separate commands', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'assignment-1', sourceRef: { model: 'proposal', id: 'proposal-1' }, workspace: { mode: 'treedx' },
			effectiveProfile: { activity: 'estimating', handler: 'estimate', prompt: { system: 'Estimate the work.' } },
		}, context: [], predecessorResults: [] } });
		expect(prompt).toMatch(/^MANDATORY ASSIGNMENT CLOCK:/u);
		expect(prompt).toContain('Put each command in its own JSON array item');
		expect(prompt).toContain('never join commands with &&, ||, ;');
		expect(prompt).toContain('never rewrite it into a cleaner command');
		expect(prompt).toContain('observed pass or fail status and exit code');
		expect(prompt).toContain('A search that finds no matches exits nonzero');
		expect(prompt).not.toContain('This is pre-decision proposal review');
		expect(prompt).toContain('never include exploratory search or inspection commands');
		expect(prompt).toContain('rg, grep, find, ls, cat, sed, or git status');
		expect(prompt).toContain('compact estimate patch');
		expect(prompt).toContain('AgentKernel maps the patch into the exact assigned proposal');
		expect(prompt).toContain('Include each Reviewer-owned work item with its exact id');
		expect(prompt).toContain('Never attribute source paths to the TreeDX library commit');
		expect(prompt).toContain('never copy their estimates into other work items');
		expect(prompt).not.toContain('place every accepted estimate and dependency');
		expect(prompt).not.toContain('Put other evidence in the proposal-level evidenceRefs');
	});
	it('requests only class-owned estimate patches and leaves canonical proposal assembly to AgentKernel', () => {
		const context = (workItemId?: string) => ({ canonicalAssignmentContext: { assignment: {
			id: 'estimate-1', workItemId, sourceRef: { model: 'proposal', id: 'proposal-1' },
			workspace: { mode: 'treedx' }, effectiveProfile: { activity: 'estimating', handler: 'estimate', prompt: {} },
		}, context: [], predecessorResults: [] } });
		const owner = promptFromContext(context('implement-change'));
		expect(owner).toContain('Return only the estimate and rationale patch for work item implement-change');
		expect(owner).toContain('Do not copy immutable proposal fields');
		expect(owner).toContain('execute the proposed work, or mark the proposal ready');
		expect(owner).toContain('Reserve at least the final 45 seconds');
		expect(owner).toContain('Time-box source inspection to the first 60 active seconds');
		expect(owner).toContain('At 60 seconds remaining, stop all inspection');
		expect(owner).toContain('metered active harness seconds');
		expect(owner).toContain("not this estimating assignment's read-only grant");
		expect(owner).toContain('not human developer hours, queue time, sandbox preparation, or the entire workday');
		expect(owner).toContain('Do not shrink an honest estimate merely to fit remaining capacity');
		expect(owner).toContain('Set verification to [] exactly');
		const reviewer = promptFromContext(context());
		expect(reviewer).toContain('return reviewEstimate patches for every review-required work item');
		expect(reviewer).toContain('metered active harness seconds');
	});
	it('does not let planning source inspection masquerade as passing verification', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'planning-1', workspace: { mode: 'git' }, effectiveProfile: { activity: 'planning', handler: 'writer', prompt: {} },
		}, context: [], predecessorResults: [] } });
		expect(prompt).toContain('Set verification to [] exactly');
		expect(prompt).toContain('Source searches, git status, and exploratory commands are inspection');
	});
	it('keeps Git work descended from the exact assigned candidate across review revisions', () => {
		const baseCommit = 'f'.repeat(40);
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'git-revision-1', workspace: { mode: 'git', baseCommit },
			effectiveProfile: { activity: 'acting', handler: 'actor', prompt: {} },
		}, context: [], predecessorResults: [] } });
		expect(prompt).toContain(`keep HEAD descended from the assigned base commit ${baseCommit}`);
		expect(prompt).toContain('Do not checkout, reset, rebase');
		expect(prompt).toContain('an exported temporary copy');
	});
	it('bounds releaser work while permitting one repair of missing local gate prerequisites', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'release-1', workspace: { mode: 'git' }, effectiveProfile: { activity: 'acting', handler: 'releaser', prompt: {} },
		}, context: [], predecessorResults: [] } }, 'low', 600);
		expect(prompt).toContain('The attached candidate already contains the approved predecessor commits');
		expect(prompt).toContain('inspect package.json scripts once');
		expect(prompt).toContain('do not run npm install or npm ci again');
		expect(prompt).toContain('run that generator before the full contract/release suite');
		expect(prompt).toContain('standards-foundation tests require its generated contract-bundle.json');
		expect(prompt).toContain('retry that gate once');
		expect(prompt).toContain('At 90 seconds remaining, stop new work');
		expect(prompt).toContain('Reserve at least 60 seconds');
	});
	it('directs a releaser revision actor to apply exact reviewer corrections before gating', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'release-revision-1', workspace: { mode: 'git' }, effectiveProfile: { activity: 'acting', handler: 'releaser', prompt: {} },
		}, context: [], predecessorResults: [{ id: 'review-1', assignmentId: 'review-assignment', status: 'completed',
			summary: 'Request changes. Restore the missing time_range_ambiguous validation.', references: [],
		}] } }, 'low', 600);
		expect(prompt).toContain('this is a bounded revision assignment');
		expect(prompt).toContain('apply only the exact corrections required by the predecessor Reviewer finding');
		expect(prompt).toContain('commit them, and then run the required release gates');
		expect(prompt).not.toContain('do not debug, modify source');
	});
	it('rejects a Reviewer assignment without an accepted decision', () => {
		expect(() => promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'assignment-review', sourceRef: { model: 'proposal', id: 'proposal-1', commit: 'proposal-commit' },
			workspace: { mode: 'treedx' }, effectiveProfile: { activity: 'reviewing', handler: 'writer',
				prompt: { system: 'Review the proposal.' } },
		}, context: [], predecessorResults: [] } })).toThrow('work_review_requires_accepted_decision');
	});
	it('reviews the paired Actor result when exact decision authority exists', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'assignment-work-review', agentClass: 'reviewer', sourceRef: { model: 'proposal', id: 'proposal-1' },
			authorityRefs: [{ store: 'postgresql', model: 'decision', id: 'decision-1', revision: 1, digest: `sha256:${'a'.repeat(64)}` }],
			acceptanceCriteria: ['The Actor identifies the exact source commit.'],
			workspace: { mode: 'treedx' }, effectiveProfile: { activity: 'reviewing', handler: 'writer',
				prompt: { system: 'Review the Actor result.' } },
		}, context: [], predecessorResults: [{ id: 'result-1' }] } });
		expect(prompt).not.toContain('This is pre-decision proposal review');
		expect(prompt).toContain('This is post-decision paired work review');
		expect(prompt).toContain('Review only the exact predecessor Actor result');
		expect(prompt).toContain('For kind git, inspect that exact commit in /workspace/project with Git');
		expect(prompt).toContain('If the paired work item requires only tracing or reading exact refs, return verification: [] exactly');
		expect(prompt).toContain('do not call treedx_read_files for a Git commit');
		expect(prompt).toContain('call treedx_read_files with paths containing that reference.path and ref equal to that reference.commit');
		expect(prompt).toContain('not the attached project Git checkout');
		expect(prompt).toContain('pages are discovered by bookRef, not copied into a reverse page list');
		expect(prompt).toContain('Status review is a valid committed page status');
		expect(prompt).toContain('a failing focused suite in a test-only candidate against unchanged implementation is expected evidence');
		expect(prompt).toContain('independently passing frozen-base checks are valid evidence');
		expect(prompt).toContain('compare the candidate against every stated acceptance criterion and report all observed gaps together');
		expect(prompt).toContain('source evidence for negative claims about serialization or excluded fields');
		expect(prompt).toContain('Later review must not introduce a gap that already existed in the first candidate');
		expect(prompt).toContain('audit both the test diff and the durable Actor result summary');
		expect(prompt).toContain('Report this omission together with every coverage gap on the first request-changes disposition');
		expect(prompt).toContain('Do not reject a candidate for an additional preference that the accepted work item does not require');
		expect(prompt).toContain('The Actor identifies the exact source commit.');
		expect(prompt).toContain('Predecessor results');
	});
	it('treats release review as a fresh VM and prepares pack output before reporting a passing command', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'release-review', agentClass: 'reviewer', workItemId: 'simulate-release',
			sourceRef: { model: 'proposal', id: 'proposal-1' },
			authorityRefs: [{ store: 'postgresql', model: 'decision', id: 'decision-1', revision: 1, digest: `sha256:${'a'.repeat(64)}` }],
			acceptanceCriteria: ['Pack and inspect the local SDK release candidate.'],
			workspace: { mode: 'git' }, effectiveProfile: { activity: 'reviewing', handler: 'writer', prompt: {} },
		}, context: [], predecessorResults: [{ id: 'release-result' }] } });
		expect(prompt).toContain('Release review runs in a fresh VM');
		expect(prompt).toContain('first create that destination directory in this VM');
		expect(prompt).toContain('the guest runner replays every reported passing verification command');
	});
	it('requires test-first actors to report each acceptance boundary independently', () => {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'test-first', agentClass: 'tester', sourceRef: { model: 'proposal', id: 'proposal-1' },
			workspace: { mode: 'git' }, effectiveProfile: { activity: 'acting', handler: 'writer', prompt: {} },
			acceptanceCriteria: ['Reject caller-authored fields.'],
		}, context: [], predecessorResults: [] } });
		expect(prompt).toContain('map every work-item acceptance criterion to an independently runnable assertion');
		expect(prompt).toContain('substring matches do not prove an exact contract');
		expect(prompt).toContain('exact test file path and verbatim name of EACH failing test observed');
		expect(prompt).toContain('complete expected serialized object and exact JSON bytes');
		expect(prompt).toContain('actual runtime key-validation path');
		expect(prompt).toContain('both rather than inspecting only one');
		expect(prompt).toContain('Test optional-field omission and presence in separate fixtures');
		expect(prompt).toContain('never expect a rejected input to normalize successfully');
		expect(prompt).toContain('preserve every previously covered criterion');
		expect(prompt).toContain('In completion.summary, include a section headed "Frozen-base failing tests:"');
		expect(prompt).toContain('an earlier failure cannot hide evidence for another criterion');
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
		const corrected = correctObservedTesterRedVerification(mislabeled as never,
			[{ type: 'item.completed', item: { type: 'command_execution', command: redCommand, exit_code: 1 } }],
			'tester', 'acting', ['Report failing test names and paths.']);
		expect(corrected.verification[0]?.status).toBe('failed');
		expect(correctObservedTesterRedVerification(mislabeled as never, [], 'tester', 'acting',
			['Report failing test names and paths.']).verification[0]?.status).toBe('passed');
		const omitted = omitUnreplayableVerification({ summary: 'Built candidate.', verification: [
			{ status: 'passed', summary: 'chained', commands: ['git merge-base --is-ancestor abc HEAD && npm run build'] },
			{ status: 'passed', summary: 'focused', commands: ['npm run build'] },
		] } as never);
		expect(omitted.verification).toEqual([{ status: 'passed', summary: 'focused', commands: ['npm run build'] }]);
		expect(omitted.summary).toContain('those gates remain unproven');
	});
	it('requires later planning cycles, but not focused estimates, to cite predecessor results', () => {
		const context = { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'planning' } },
			predecessorResults: [{ id: 'result-a' }, { id: 'result-b' }] } };
		const prompt = promptFromContext(context);
		expect(prompt).toContain('cite every predecessor result by its exact ID');
		expect(prompt).toContain('result-a, result-b');
		expect(prompt).toContain('Before your final clock check, compare the summary against this entire ID list');
		expect(prompt).toContain('Required line starts:\n- result-a: \n- result-b: ');
		expect(prompt).toContain('Return contentOutput: null');
		expect(() => assertPredecessorSynthesis(context, { schemaVersion: 'treeseed.activity-completion/v1',
			summary: 'Used result-a only.', verification: [], reviewDisposition: null,
			contentOutput: null }))
			.toThrow('predecessor_result_citation_missing:result-b');
		expect(() => assertPredecessorSynthesis(context, { schemaVersion: 'treeseed.activity-completion/v1',
			summary: 'result-a supplied scope; result-b supplied risks.', verification: [], reviewDisposition: null,
			contentOutput: null }))
			.not.toThrow();
		const estimateContext = { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'estimating' } },
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
				env: expect.objectContaining({ HTTPS_PROXY: 'http://assignment-proxy', https_proxy: 'http://assignment-proxy' }) }));
	});
	it('requires canonical assignment prompts to explain complete verification commands', () => {
		const rendered = promptFromContext({ canonicalAssignmentContext: {
			assignment: { id: 'assignment', workItemId: 'work', sourceRef: { model: 'proposal', id: 'proposal' },
				authorityRefs: [], effectiveProfile: { activity: 'acting', handler: 'actor', prompt: { system: 'Work.' } },
				workspace: { mode: 'git' }, acceptanceCriteria: [], limits: { maximumSeconds: 30 } },
			context: [], predecessorResults: [],
		} }, 'high', 30);
		expect(rendered).toContain('syntactically complete with balanced quotes');
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
