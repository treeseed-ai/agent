import { describe, expect, it } from 'vitest';

import { treeDxContentReceipts } from '../../../../src/agents/adapters/codex/execution-codex-receipts.ts';
import { deriveToolEvents } from '../../../../src/agents/tools/agent-tool-telemetry.ts';

function completed(toolId: string, derivedEvents: Record<string, unknown>[]) {
	return { toolId, status: 'completed', derivedEvents };
}

describe('TreeDX content receipts', () => {
	it('emits a durable receipt for an update-only content revision', () => {
		const receipts = treeDxContentReceipts([
			completed('treeseed.content.update', [{
				type: 'content_updated',
				contentRef: {
					id: 'proposal:governed-workday',
					model: 'proposal',
					path: 'src/content/proposals/governed-workday.mdx',
					subjectId: 'objective:governed-workday',
					subjectField: 'relatedObjectives',
				},
			}]),
			completed('treeseed.content.commit', [{
				type: 'content_committed',
				commitSha: '712a574e96bbf76e5997a6dba6309de9188faf15',
				branchRef: 'refs/heads/assignment-revision',
			}]),
		]);

		expect(receipts).toEqual([expect.objectContaining({
			kind: 'treedx_content_receipt',
			uri: 'treedx://src/content/proposals/governed-workday.mdx',
			metadata: expect.objectContaining({
				toolId: 'treeseed.content.update',
				contentRef: expect.objectContaining({
					model: 'proposal',
					commitSha: '712a574e96bbf76e5997a6dba6309de9188faf15',
					ref: 'refs/heads/assignment-revision',
				}),
			}),
		})]);
	});

	it('deduplicates create and update events and retains the latest relation fields', () => {
		const receipts = treeDxContentReceipts([
			completed('treeseed.content.create', [{
				type: 'content_created',
				contentRef: { model: 'note', path: 'src/content/notes/review.mdx' },
			}]),
			completed('treeseed.content.link', [{
				type: 'content_updated',
				contentRef: {
					model: 'note', path: 'src/content/notes/review.mdx',
					subjectId: 'proposal:change', subjectField: 'relatedProposals',
				},
			}]),
			completed('treeseed.content.commit', [{ type: 'content_committed', commitSha: 'abc123' }]),
		]);

		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.metadata).toMatchObject({
			contentRef: {
				model: 'note',
				subjectId: 'proposal:change',
				subjectField: 'relatedProposals',
				commitSha: 'abc123',
			},
		});
	});

	it('does not represent uncommitted workspace mutations as durable artifacts', () => {
		expect(treeDxContentReceipts([
			completed('treeseed.content.update', [{
				type: 'content_updated',
				contentRef: { model: 'proposal', path: 'src/content/proposals/change.mdx' },
			}]),
		])).toEqual([]);
	});

	it('projects an authoritative Discussion response as its own committed content receipt',()=>{
		const commitSha='d'.repeat(40);const path='src/content/discussion-messages/discussion-a/response-a.mdx';
		const derivedEvents=deriveToolEvents('treeseed.discussion.respond',{id:'treeseed.discussion.respond',kind:'agent_tool',executionTarget:'provider_runner',mutability:'content_write'} as never,
			{replyTo:'message-a'},{ok:true,payload:{message:{id:'response-a',path},commitSha,changeset:{baseCommitSha:'c'.repeat(40),resultCommitSha:commitSha,changedPaths:[path]}}});
		expect(derivedEvents).toEqual([expect.objectContaining({type:'content_created',contentRef:expect.objectContaining({model:'discussion_message',artifactKind:'discussion_response',path,commitSha,subjectId:'message-a'})})]);
		expect(treeDxContentReceipts([completed('treeseed.discussion.respond',derivedEvents)])).toEqual([expect.objectContaining({
			kind:'treedx_content_receipt',uri:`treedx://${path}`,metadata:expect.objectContaining({contentRef:expect.objectContaining({artifactKind:'discussion_response',commitSha})}),
		})]);
	});
});
