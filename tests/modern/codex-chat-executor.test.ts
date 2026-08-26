import { describe, expect, it } from 'vitest';
import { discussionMessageSourcePaths, readDiscussionSourceMessage } from '../../src/provider/execution/codex-chat-executor.ts';

describe('Codex chat executor', () => {
	it('accepts root and nested TreeDX discussion-message references', () => {
		expect(discussionMessageSourcePaths({ sourceMessageRefs: [
			'discussion-messages/topic/message.mdx',
			'./discussion-messages/topic/second.mdx',
			'src/content/discussion-messages/topic/legacy.mdx',
			'knowledge/topic/message.mdx',
		] })).toEqual([
			'discussion-messages/topic/message.mdx',
			'discussion-messages/topic/second.mdx',
			'src/content/discussion-messages/topic/legacy.mdx',
		]);
	});

	it('reads the committed discussion message at the assignment exact ref', async () => {
		let input: Record<string, unknown> | undefined;
		const content = await readDiscussionSourceMessage({
			assignment: { sourceMessageRefs: ['discussion-messages/topic/message.mdx'] },
			assignmentId: 'assignment-1', leaseToken: 'lease', runnerId: 'runner',
			treeDx: { projectId: 'project-1', repositoryId: 'repo-1', workspaceId: 'workspace-1', baseRef: 'commit-1',
				invoke: async (_operationId, value) => { input = value; return {
					data: { result: { files: [{ content: 'Exact message' }] }, receipt: { requestId: 'request-1' } },
				}; } },
		});
		expect(content).toBe('Exact message');
		expect(input).toEqual({ path: { repoId: 'repo-1' }, body: {
			ref: 'commit-1', paths: ['discussion-messages/topic/message.mdx'], encoding: 'utf8', parseFrontmatter: true, allowProtected: true,
		} });
	});
});
