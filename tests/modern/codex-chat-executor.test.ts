import { describe, expect, it } from 'vitest';
import { discussionMessageSourcePaths } from '../../src/provider/execution/codex-chat-executor.ts';

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
});
