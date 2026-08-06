import { describe, expect, it } from 'vitest';
import type { ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { buildAgentArtifactManifest, validateAgentArtifactManifest } from '../../../src/agents/kernel/artifacts/artifact-manifest.ts';
import { recordAssignmentModeRun } from '../../../src/agents/kernel/telemetry/telemetry.ts';

function assignment(): ProviderAssignment {
	return {
		id: 'assignment-1',
		teamId: 'team-1',
		projectId: 'project-1',
		capacityProviderId: 'provider-1',
		executionProviderId: 'codex',
		projectAgentClassId: 'researcher',
		workDayId: 'workday-1',
		mode: 'planning',
		status: 'leased',
		leaseState: 'leased',
		capacityEnvelope: {
			teamId: 'team-1',
			projectId: 'project-1',
			projectAgentClassId: 'researcher',
			capacityProviderId: 'provider-1',
			mode: 'planning',
			reservedCredits: 3,
		},
		decisionInput: { input: {} },
	};
}

describe('AgentArtifactManifest', () => {
	it('persists kernel lifecycle telemetry under the artifact manifest mode-run identity', async () => {
		const writes: Array<Record<string, unknown>> = [];
		const options = {
			assignment: assignment(),
			modeRunId: 'mode-run-authority',
			recordModeRun: async (run: Record<string, unknown>) => {
				writes.push(run);
				return run;
			},
		};
		await recordAssignmentModeRun(options, {
			status: 'running',
			selectedInput: {},
			capacityEnvelope: assignment().capacityEnvelope,
		});
		await recordAssignmentModeRun(options, {
			status: 'succeeded',
			selectedInput: {},
			capacityEnvelope: assignment().capacityEnvelope,
			outputs: { artifactManifest: { modeRunId: 'mode-run-authority' } },
		});
		expect(writes.map((entry) => entry.id)).toEqual(['mode-run-authority', 'mode-run-authority']);
	});

	it('retries the same durable mode-run identity after an interrupted response', async () => {
		const writes: Array<Record<string, unknown>> = [];
		await recordAssignmentModeRun({
			assignment: assignment(),
			modeRunId: 'mode-run-retry',
			recordModeRun: async (run: Record<string, unknown>) => {
				writes.push(run);
				if (writes.length === 1) throw new TypeError('fetch failed');
				return run;
			},
		}, {
			status: 'succeeded',
			selectedInput: {},
			capacityEnvelope: assignment().capacityEnvelope,
		});
		expect(writes).toHaveLength(2);
		expect(writes.map((entry) => entry.id)).toEqual(['mode-run-retry', 'mode-run-retry']);
	});

	it('normalizes durable content, code, citations, verification, usage, and tool evidence', () => {
		const manifest = buildAgentArtifactManifest({
			assignment: assignment(),
			modeRunId: 'mode-run-1',
			runnerId: 'runner-1',
			agentId: 'researcher',
			handlerId: 'execution-content',
			activityType: 'research',
			status: 'completed',
			createdAt: '2026-07-16T20:00:00.000Z',
			output: {
				status: 'completed',
				summary: 'Completed cited research and implementation.',
				metadata: {
					providerToken: 'must-never-be-copied',
					classifiedContentReferences: [{
						model: 'note',
						contentPath: 'notes/research/result.mdx',
						subjectId: 'question-1',
						subjectField: 'relatedQuestions',
						artifactKind: 'failing_test_proof',
						producedByAgent: 'researcher',
					}],
					executionSnapshot: {
						status: 'completed',
						summary: 'done',
						outputs: {
							citations: [{
								sourceUrl: 'https://example.test/paper?token=secret',
								title: 'Paper',
								retrievedAt: '2026-07-16T19:00:00.000Z',
								contentHash: 'sha256:paper',
								claimIds: ['claim-1'],
								confidence: 'high',
							}],
							toolTelemetry: [
								{
									toolId: 'treedx.write',
									status: 'completed',
									derivedEvents: [{ type: 'content_created' }],
								},
								{
									toolId: 'treeseed.checkpoint', status: 'completed',
									derivedEvents: [{ type: 'source_checkpoint_committed', commitSha: 'abc123', branchRef: 'agent/tester/assignment-1', changedPaths: ['src/result.ts'] }],
								},
								{
									toolId: 'treeseed.verify', status: 'completed',
									derivedEvents: [{
										type: 'verification_completed',
										status: 'passed',
										summary: 'Tests passed.',
										commands: ['npm test'],
									}],
								},
								{
									toolId: 'treeseed.review_decision', status: 'completed',
									derivedEvents: [{
										type: 'review_decision_recorded',
										disposition: 'approved',
										summary: 'Evidence passed review.',
									}],
								},
								{ operation: 'test', status: 'failed', error: 'failed' },
							],
						},
						usage: [{ kind: 'tokens', unit: 'token', amount: 42, source: 'codex' }],
						artifacts: [
							{ kind: 'changed_path', name: 'src/result.ts', uri: 'repo://src/result.ts' },
							{
								kind: 'treedx_content_receipt',
								metadata: {
									toolId: 'treedx.write',
									contentRef: {
										model: 'note',
										path: 'notes/research/result.mdx',
										subjectId: 'question-1',
										subjectField: 'relatedQuestions',
									},
								},
							},
						],
					},
				},
			},
		});

		expect(manifest).toMatchObject({
			schemaVersion: 1,
			assignmentId: 'assignment-1',
			modeRunId: 'mode-run-1',
			agentClassId: 'researcher',
			activityType: 'research',
			contentReferences: [{ model: 'note', contentPath: 'notes/research/result.mdx', subjectId: 'question-1', artifactKind: 'failing_test_proof', producedByAgent: 'researcher' }],
			sourceWorktree: { changedPaths: ['src/result.ts'] },
			commit: { sha: 'abc123', ref: 'agent/tester/assignment-1' },
			verification: [{ status: 'passed', summary: 'Tests passed.' }],
			signals: [{ code: 'review_approved', severity: 'info' }],
			toolEvents: [{ toolId: 'treedx.write', status: 'completed' }, { toolId: 'treeseed.checkpoint', status: 'completed' }, { toolId: 'treeseed.verify', status: 'completed' }, { toolId: 'treeseed.review_decision', status: 'completed' }, { status: 'failed' }],
			usage: [{ kind: 'tokens', unit: 'token', amount: 42 }],
		});
		expect(manifest.citations[0]?.sourceUrl).toContain('token=%5Bredacted%5D');
		expect(JSON.stringify(manifest)).not.toContain('must-never-be-copied');
		expect(validateAgentArtifactManifest(manifest)).toEqual({ ok: true });
		expect(validateAgentArtifactManifest(manifest, { artifactContracts: ['failing-test-proof'], signalContracts: ['review-approved'] })).toEqual({ ok: true });
		expect(validateAgentArtifactManifest(manifest, { artifactContracts: ['planning-proposal'] })).toMatchObject({
			ok: false, reason: expect.stringContaining('artifact:planning-proposal'),
		});
	});

	it('rejects a completed execution with no durable evidence', () => {
		const manifest = buildAgentArtifactManifest({
			assignment: assignment(),
			modeRunId: 'mode-run-1',
			agentId: 'researcher',
			handlerId: 'execution-content',
			activityType: 'research',
			status: 'completed',
			output: {
				status: 'completed',
				summary: 'Only a transient response.',
				metadata: {
					classifiedContentReferences: [{ model: 'note', contentPath: 'notes/fabricated.mdx', subjectId: 'question-1' }],
					executionSnapshot: { status: 'completed', summary: 'done', artifacts: [{ kind: 'assistant_final_response' }] },
				},
			},
		});
		expect(manifest.contentReferences).toEqual([]);
		expect(validateAgentArtifactManifest(manifest)).toMatchObject({ ok: false });
	});

	it('projects governed fetch, claim, and research-review tool receipts into workflow evidence', () => {
		const researchAssignment = assignment();
		researchAssignment.decisionInput = { input: { researchStage: 'citation-review-rejection' } };
		const manifest = buildAgentArtifactManifest({
			assignment: researchAssignment,
			modeRunId: 'mode-run-research',
			agentId: 'reviewer',
			handlerId: 'writer',
			activityType: 'planning',
			status: 'completed',
			output: {
				status: 'completed',
				summary: 'Recorded governed research evidence.',
				metadata: {
					executionSnapshot: {
						status: 'completed',
						summary: 'done',
						outputs: {
							toolTelemetry: [
								{ status: 'completed', derivedEvents: [{ type: 'research_citation_fetched', citation: {
									sourceUrl: 'https://example.com/', title: 'Example', publisher: 'example.com',
									retrievedAt: '2026-07-21T00:00:00.000Z', contentHash: 'sha256:example',
									claimIds: ['claim-1'], confidence: 'medium',
								} }] },
								{ status: 'completed', derivedEvents: [{ type: 'research_claims_recorded', claims: [{
									id: 'claim-1', text: 'Material claim', material: true, status: 'unsupported', citationIds: [],
								}] }] },
								{ toolId: 'treeseed.review_decision', status: 'completed', derivedEvents: [{
									type: 'review_decision_recorded', disposition: 'rejected', summary: 'Unsupported material claim.',
								}] },
							],
						},
					},
				},
			},
		});
		expect(manifest.citations).toEqual([expect.objectContaining({ sourceUrl: 'https://example.com/', claimIds: ['claim-1'] })]);
		expect(manifest.signals).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 'research_claim', metadata: expect.objectContaining({ id: 'claim-1', status: 'unsupported' }) }),
			expect.objectContaining({ code: 'research_review_rejected' }),
		]));
	});

	it('accepts a validated structured estimate as a durable control-plane output', () => {
		const manifest = buildAgentArtifactManifest({
			assignment: assignment(),
			modeRunId: 'mode-run-estimate',
			agentId: 'engineer',
			handlerId: 'estimate',
			activityType: 'estimating',
			status: 'completed',
			output: {
				status: 'completed',
				summary: 'Estimated the linked proposal.',
				metadata: {
					structuredEstimate: {
						id: 'estimate-assignment-1',
						decisionId: 'decision-1',
						proposalId: 'proposal-1',
						agentId: 'engineer',
					},
					estimateValidation: { ok: true },
					executionSnapshot: { status: 'completed', summary: 'done' },
				},
			},
		});
		expect(manifest.controlPlaneReferences).toEqual([expect.objectContaining({
			kind: 'structured_agent_estimate', id: 'estimate-assignment-1', status: 'submitted',
		})]);
		expect(validateAgentArtifactManifest(manifest)).toEqual({ ok: true });
	});

	it('does not project a TreeDX content commit as source-repository authority', () => {
		const manifest = buildAgentArtifactManifest({
			assignment: assignment(), modeRunId: 'mode-run-content', agentId: 'researcher',
			handlerId: 'writer', activityType: 'acting', status: 'completed',
			output: { status: 'completed', summary: 'Created content evidence.', metadata: {
				classifiedContentReferences: [{ model: 'note', contentPath: 'notes/research/evidence.mdx', subjectId: 'decision-1', subjectField: 'relatedDecisions' }],
				executionSnapshot: {
					status: 'completed', summary: 'done', outputs: { toolTelemetry: [{ toolId: 'treeseed.content.commit', status: 'completed', derivedEvents: [{ type: 'content_created' }] }] },
					artifacts: [{ kind: 'treedx_content_receipt', metadata: { toolId: 'treeseed.content.commit', contentRef: { model: 'note', path: 'notes/research/evidence.mdx', subjectId: 'decision-1', subjectField: 'relatedDecisions', commitSha: 'abcdef1234567890', ref: 'refs/heads/assignment' } } }],
				},
			} },
		});
		expect(manifest.contentReferences[0]).toMatchObject({ commitSha: 'abcdef1234567890' });
		expect(manifest.commit).toBeUndefined();
	});

	it('selects the final authenticated source checkpoint as downstream authority', () => {
		const manifest = buildAgentArtifactManifest({
			assignment: assignment(), modeRunId: 'mode-run-checkpoints', agentId: 'engineer',
			handlerId: 'actor', activityType: 'acting', status: 'completed',
			output: { status: 'completed', summary: 'Implemented and checkpointed the change.', metadata: {
				executionSnapshot: {
					status: 'completed', summary: 'done',
					outputs: { toolTelemetry: [
						{ toolId: 'treeseed.checkpoint', status: 'completed', derivedEvents: [{ type: 'source_checkpoint_committed', commitSha: '1111111111111111', branchRef: 'agent/engineer/work' }] },
						{ toolId: 'treeseed.checkpoint', status: 'completed', derivedEvents: [{ type: 'source_checkpoint_committed', commitSha: '2222222222222222', branchRef: 'agent/engineer/work' }] },
					] },
					artifacts: [{ kind: 'changed_path', name: 'src/result.ts', uri: 'repo://src/result.ts' }],
				},
			} },
		});
		expect(manifest.commit).toEqual({ sha: '2222222222222222', ref: 'agent/engineer/work' });
	});

	it('fails closed instead of dropping a malformed declared citation', () => {
		expect(() => buildAgentArtifactManifest({
			assignment: assignment(),
			modeRunId: 'mode-run-1',
			agentId: 'researcher',
			handlerId: 'execution-content',
			activityType: 'research',
			status: 'completed',
			output: {
				status: 'completed',
				summary: 'Malformed citation.',
				metadata: { executionSnapshot: { status: 'completed', summary: 'done', outputs: { citations: [{ sourceUrl: 'not-a-url' }] } } },
			},
		})).toThrow(/research_citation_url_invalid/u);
	});

	it('rejects a TreeDX note receipt without validated subject-link evidence', () => {
		const telemetry = { toolId: 'treedx.write', status: 'completed', derivedEvents: [{ type: 'content_created' }] };
		const manifest = buildAgentArtifactManifest({
			assignment: assignment(),
			modeRunId: 'mode-run-1',
			agentId: 'researcher',
			handlerId: 'execution-content',
			activityType: 'research',
			status: 'completed',
			output: {
				status: 'completed',
				summary: 'Unlinked note.',
				metadata: { executionSnapshot: {
					status: 'completed',
					summary: 'done',
					outputs: { toolTelemetry: [telemetry] },
					artifacts: [{ kind: 'treedx_content_receipt', metadata: { toolId: 'treedx.write', telemetry, contentRef: { model: 'note', path: 'notes/unlinked.mdx' } } }],
				} },
			},
		});
		expect(validateAgentArtifactManifest(manifest)).toMatchObject({ ok: false, reason: expect.stringContaining('subject link') });
	});
});
