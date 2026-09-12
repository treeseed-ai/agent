import { createHash } from 'node:crypto';
import { matchesGlob } from 'node:path';
import { stringify } from 'yaml';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import type { AgentKernelModeExecutionResult } from '@treeseed/sdk/agent-capacity';
import type { AgentExecutionRequest } from '../contracts.ts';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const payload = (value: unknown) => { const e = record(value), d = record(e.data ?? e), r = record(d.result ?? d); return record(r.data ?? r); };
type AgentArtifactManifest = NonNullable<AgentKernelModeExecutionResult['artifactManifest']>;
interface ReviewReceipt { receiptId: string; contentPath: string; commitSha: string; kind: string; sha256: string; }
export interface ReviewOutput {
  readonly enabled: boolean;
  readonly manifest: AgentArtifactManifest | undefined;
  publish(arguments_: Record<string, unknown>): Promise<ReviewReceipt>;
}

export function reviewArtifactStatus(output: Pick<ReviewOutput, 'enabled' | 'manifest'>) {
  return { required: output.enabled, verified: output.enabled && Boolean(output.manifest) };
}

/** The reviewer chooses its assessment; the host supplies and verifies immutable assignment provenance. */
export function createReviewOutput(request: AgentExecutionRequest): ReviewOutput {
  let manifest: AgentArtifactManifest | undefined;
  const metadata = record(request.assignment.metadata), input = record(record(request.assignment.decisionInput).input), intent = record(input.intent);
  const permissions = record(metadata.permissions ?? input.permissions);
  const tools = record(metadata.toolPolicy), allowed = Array.isArray(tools.allowed) ? tools.allowed : [];
  const note = record(record(permissions.content).note), operations = Array.isArray(note.operations) ? note.operations : [];
  const outputs = record(request.assignment.allowedOutputs), outputTypes = Array.isArray(outputs.types) ? outputs.types : [];
  const enabled = request.assignment.executionKind === 'workday' && intent.artifactKind === 'proposal_feedback_note'
    && intent.subjectModel === 'proposal' && typeof intent.subjectId === 'string' && Boolean(intent.subjectId)
    && ['create', 'validate', 'commit'].every(operation => operations.includes(operation))
    && ['treeseed.content.create', 'treeseed.content.validate', 'treeseed.content.commit'].every(tool => allowed.includes(tool))
    && outputTypes.includes('proposal_feedback_note') && record(permissions.commit).allowed === true && Boolean(request.treeDx.workspaceId);
  return {
    enabled,
    get manifest() { return manifest; },
    async publish(arguments_: Record<string, unknown>) {
      if (!enabled) throw new Error('This assignment does not authorize proposal review publication.');
      const kind = String(arguments_.kind ?? ''), title = String(arguments_.title ?? '').trim(), body = String(arguments_.body ?? '').trim();
      if (!['support', 'concern', 'question', 'response'].includes(kind) || !title || title.length > 240 || !body || Buffer.byteLength(body) > 64_000) throw new Error('Review requires kind, title (up to 240 characters), and evidence-backed body (up to 64 KiB).');
      if (manifest) throw new Error('This assignment already published its review.');
      const subject = String(intent.subjectId), createdAt = new Date().toISOString();
      const frontmatter = { title, date: createdAt, author: String(request.assignment.agentId), feedback_kind: kind,
        related_proposals: [subject], summary: title, status: 'live' };
      const validation = validatePortableContentData('note', frontmatter);
      if (!validation.ok) throw new Error(`Review content is invalid: ${JSON.stringify(validation.diagnostics)}`);
      const key = createHash('sha256').update(request.assignmentId).digest('hex');
      const root = String(metadata.contentRoot ?? '.');
      if (root !== '.' && !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(root)) throw new Error('Assigned content root is invalid.');
      const contentPath = `${root === '.' ? '' : `${root}/`}notes/review-${key}.mdx`, content = `---\n${stringify(frontmatter)}---\n\n${body}\n`;
      if (!Array.isArray(outputs.paths) || !outputs.paths.some(pattern => typeof pattern === 'string' && matchesGlob(contentPath, pattern))) throw new Error('Review path is outside the assigned output boundary.');
      const path = { projectId: request.treeDx.projectId, workspaceId: request.treeDx.workspaceId };
      await request.treeDx.invoke('treedx.workspaces.files.batch', { path, body: { files: [{ path: contentPath, content }] } }, { idempotencyKey: `review-write:${key}` });
      const committed = payload(await request.treeDx.invoke('treedx.workspaces.commit', { path, body: { message: title,
        author: { name: String(request.assignment.agentId), email: 'agent@treeseed.invalid' } } }, { idempotencyKey: `review-commit:${key}` }));
      const commitSha = String(committed.commitSha ?? '');
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commitSha)) throw new Error('TreeDX did not return an immutable review commit.');
      const verified = payload(await request.treeDx.invoke('treedx.repositories.files.read', { path: { projectId: request.treeDx.projectId, repoId: request.treeDx.repositoryId },
        body: { ref: commitSha, paths: [contentPath], encoding: 'utf8', parseFrontmatter: false, allowProtected: true } }));
      const file = record(Array.isArray(verified.files) ? verified.files[0] : undefined);
      if (file.content !== content) throw new Error('Committed review failed exact byte read-back.');
      const receiptId = `review:${key}`, modeRunId = `mode-run:${request.assignmentId}`;
      manifest = { schemaVersion: 1, assignmentId: request.assignmentId, modeRunId, teamId: String(request.assignment.teamId),
        projectId: request.treeDx.projectId, workDayId: String(request.assignment.workDayId), providerId: String(request.assignment.capacityProviderId),
        runnerId: request.runnerId, executionProviderId: String(request.assignment.executionProviderId), mode: 'planning',
        agentClassId: String(request.assignment.projectAgentClassId), agentId: String(request.assignment.agentId),
        handlerId: String(request.assignment.handlerId), activityType: String(metadata.activityType), status: 'completed', summary: title,
        toolEvents: [{ id: receiptId, toolId: 'treeseed_publish_review', status: 'completed', derivedEventTypes: ['content.committed'] }],
        contentReferences: [{ model: 'note', contentPath, receiptId, toolEventId: receiptId, subjectId: subject,
          subjectField: 'relatedProposals', artifactKind: 'proposal_feedback_note', producedByAgent: String(request.assignment.agentId), commitSha }],
        commit: { sha: commitSha, message: title }, verification: [{ status: 'passed', summary: 'SDK note validation and byte-exact committed TreeDX read-back.', evidenceRefs: [receiptId] }],
        citations: [], signals: [], usage: [], diagnostics: [], createdAt };
      return { receiptId, contentPath, commitSha, kind, sha256: createHash('sha256').update(content).digest('hex') };
    },
  };
}
