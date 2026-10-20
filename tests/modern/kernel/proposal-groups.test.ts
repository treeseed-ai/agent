import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { prepareTreeDxContent } from '../../../src/kernel/treedx-content-commit.ts';

const target = { store: 'treedx' as const, model: 'proposal', id: 'complete-scoped-snapshots',
	repository: 'treeseed-ai/ui-library', commit: 'a'.repeat(40), path: 'proposals/complete-scoped-snapshots.mdx' };
const frontmatter = { schemaVersion: 'treeseed.proposal/v1', id: target.id, projectId: 'ui',
	title: 'Support complete scoped activity snapshots in UI', status: 'draft',
	request: 'Replace complete snapshots, including empty results, while retaining incremental activity updates.',
	groupIds: ['portfolio-atlas'] };

describe('kernel proposal group custody', () => {
	it('retains the shared team group when preparing a real planning product for TreeDX', () => {
		const input = { frontmatter, body: 'The shared UI component owns snapshot replacement; Admin consumes the same contract.' };
		const before = structuredClone(input), result = prepareTreeDxContent(target, input);
		expect(parse(result.content.split('---')[1]!)).toEqual(frontmatter);
		expect(result.content).toContain(input.body);
		expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
		expect(input).toEqual(before);
	});

	it('rejects individual targeting and malformed shared membership before any write', () => {
		for (const extra of [{ agentIds: ['ui/engineer'] }, { agentSlugs: ['engineer'] },
			{ groupIds: ['portfolio-atlas', 'portfolio-atlas'] }, { groupIds: ['bad group'] }]) {
			expect(() => prepareTreeDxContent(target, { frontmatter: { ...frontmatter, ...extra }, body: 'Bounded real UI work.' }))
				.toThrow('treedx_content_invalid');
		}
	});
});
