import { describe, expect, it, vi } from 'vitest';
import { createReviewOutput, reviewArtifactStatus } from '../../../src/provider/execution/activity/review-output.ts';
import type { AgentExecutionRequest } from '../../../src/provider/execution/contracts.ts';
import { assignmentRuntimeSeconds } from '../../../src/provider/execution/activity/context.ts';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';

function fixture() {
  let bytes = '';
  const invoke = vi.fn(async (operation: string, value: Record<string, any>): Promise<Record<string, unknown>> => {
    const schema = controlPlaneOperation(operation).schema;
    schema.path.parse(value.path); schema.query.parse(value.query ?? {}); schema.body.parse(value.body);
    if (operation === 'treedx.workspaces.files.batch') { bytes = value.body.files[0].content; return { files: [{ path: value.body.files[0].path }] }; }
    if (operation === 'treedx.workspaces.commit') return { commitSha: 'a'.repeat(40) };
    if (operation === 'treedx.repositories.files.read') return { files: [{ content: bytes }] };
    throw new Error('Unexpected operation');
  });
  const request = { assignmentId: 'assignment-review', runnerId: 'runner', leaseToken: 'private',
    assignment: { executionKind: 'workday', teamId: 'team', projectAgentClassId: 'class', agentId: 'reviewer', handlerId: 'writer',
      allowedOutputs: { types: ['proposal_feedback_note'], paths: ['notes/**'] },
      capacityProviderId: 'provider', executionProviderId: 'offer', workDayId: 'workday',
      decisionInput: { input: { intent: { artifactKind: 'proposal_feedback_note', subjectModel: 'proposal', subjectId: 'proposal-subject' } } },
      metadata: { activityType: 'reviewing', permissions: { content: { note: { operations: ['create', 'validate', 'commit'] } }, commit: { allowed: true } },
        toolPolicy: { allowed: ['treeseed.content.create', 'treeseed.content.validate', 'treeseed.content.commit'] } } },
    treeDx: { projectId: 'project', repositoryId: 'repo', workspaceId: 'workspace', invoke },
  } satisfies AgentExecutionRequest;
  return { request, invoke };
}

describe('assignment-scoped review publication', () => {
  it('uses only the remaining productive window, never a fresh lease-sized budget', () => {
    const assignment = { leaseSeconds: 300, capacityEnvelope: { budget: { time: { executionDeadlineAt: '2026-09-11T12:00:30Z' } } } };
    expect(assignmentRuntimeSeconds(assignment, Date.parse('2026-09-11T12:00:00Z'))).toBe(30);
    expect(() => assignmentRuntimeSeconds(assignment, Date.parse('2026-09-11T12:00:31Z'))).toThrow('exhausted');
  });
  it('records the reviewer assessment only after validated content is committed and read back exactly', async () => {
    const { request, invoke } = fixture(), output = createReviewOutput(request);
    const receipt = await output.publish({ kind: 'concern', title: 'Missing recovery evidence', body: 'Inspected the implementation: recovery acceptance is not yet demonstrated.' });
    expect(receipt.kind).toBe('concern');
    expect(output.manifest?.contentReferences[0]).toMatchObject({ subjectId: 'proposal-subject', artifactKind: 'proposal_feedback_note', commitSha: 'a'.repeat(40) });
    expect(invoke.mock.calls[0][1].body.files[0].content).toContain('feedback_kind: concern');
    expect(invoke.mock.calls[0][1].body.files[0].content).not.toContain('private');
    expect(output.manifest?.toolEvents[0].status).toBe('completed');
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['treedx.workspaces.files.batch', 'treedx.workspaces.commit', 'treedx.repositories.files.read']);
  });
  it.each(['conversation', 'missing-permission', 'wrong-subject'])('rejects %s without issuing a mutation', async boundary => {
    const { request, invoke } = fixture();
    if (boundary === 'conversation') request.assignment.executionKind = 'conversation';
    if (boundary === 'missing-permission') request.assignment.metadata.toolPolicy.allowed = [];
    if (boundary === 'wrong-subject') request.assignment.decisionInput.input.intent.subjectModel = 'objective';
    await expect(createReviewOutput(request).publish({ kind: 'support', title: 'Title', body: 'Body' })).rejects.toThrow('does not authorize');
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['planning', 'estimating', 'reviewing', 'reporting', 'acting'])('does not require a proposal artifact for an ordinary %s workday', activityType => {
    const { request } = fixture();
    request.assignment.metadata.activityType = activityType;
    request.assignment.decisionInput.input.intent = { artifactKind: 'objective_note', subjectModel: 'objective', subjectId: 'objective' };
    expect(reviewArtifactStatus(createReviewOutput(request))).toEqual({ required: false, verified: false });
  });
  it('requires and verifies an artifact only for the specialized proposal review', async () => {
    const { request } = fixture(), output = createReviewOutput(request);
    expect(reviewArtifactStatus(output)).toEqual({ required: true, verified: false });
    await output.publish({ kind: 'support', title: 'Verified review', body: 'The assigned proposal evidence was reviewed.' });
    expect(reviewArtifactStatus(output)).toEqual({ required: true, verified: true });
  });
  it('does not report a manifest when committed read-back differs', async () => {
    const { request, invoke } = fixture(); invoke.mockImplementation(async operation => operation === 'treedx.workspaces.commit'
      ? { commitSha: 'a'.repeat(40) } : operation === 'treedx.repositories.files.read' ? { files: [{ content: 'altered' }] } : {});
    const output = createReviewOutput(request);
    await expect(output.publish({ kind: 'support', title: 'Title', body: 'Body' })).rejects.toThrow('exact byte');
    expect(output.manifest).toBeUndefined();
  });
});
