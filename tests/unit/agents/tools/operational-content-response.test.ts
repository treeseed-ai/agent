import { describe,expect,it } from 'vitest';
import { assignmentOperationalPath,operationalResponseContent } from '../../../../src/agents/tools/assignment/operational-content-tool.ts';
import { modelRelativePlacement } from '../../../../src/agents/tools/content-tool-runtime.ts';
import { contentModelForArtifactKind,missingOperationalCloseoutReceipts,missingPrecommitContentReceipts } from '../../../../src/agents/tools/agent-tool-completion.ts';
import { matchesScopedPath } from '../../../../src/agents/tools/path-scope/path-matcher.ts';
import { assignmentContextRef,assignmentRuntimeContextRef } from '../../../../src/agents/handlers/context/shared-context-queries.ts';

describe('assignment operational content response extraction', () => {
	it('terminates on absent nested envelopes', () => {
		expect(operationalResponseContent({ ok: false })).toBe('');
	});

	it('extracts nested TreeDX content without following cycles', () => {
		const response: Record<string,unknown> = {};
		response.payload = response;
		response.data = { file: { content: '---\nid: assignment-1\n---\nPlan' } };
		expect(operationalResponseContent(response)).toContain('id: assignment-1');
	});

	it('preserves the exact case-sensitive assignment identity in owned paths', () => {
		expect(assignmentOperationalPath('treeseed.assignment_plan',{}, { assignmentId:'assignment_AbC-123' }))
			.toBe('src/content/assignment-plans/assignment_AbC-123.mdx');
		expect(modelRelativePlacement({ placement:{ path:'src/content/assignment-plans/assignment_AbC-123.mdx' } },'assignment_plan','src/content'))
			.toEqual({ path:'src/content/assignment-plans/assignment_AbC-123' });
	});

	it('matches embedded wildcards in assignment-owned status paths', () => {
		expect(matchesScopedPath(
			'src/content/assignment-statuses/assignment_AbC-123-status-0.mdx',
			'src/content/assignment-statuses/assignment_AbC-123-status-*',
		)).toBe(true);
	});

	it('separates immutable query definitions from current runtime content', () => {
		const context={ capacity:{ treedxProxyHandle:{ baseCommitSha:'workspace-ref' } } } as never;
		const payload={ contextDefinitionRef:'definition-ref',contextRuntimeRef:'runtime-ref',contentBaseRef:'workspace-ref' };
		expect(assignmentContextRef(context,payload)).toBe('definition-ref');
		expect(assignmentRuntimeContextRef(context,payload)).toBe('runtime-ref');
	});

	it('requires terminal operational records before a content workspace can commit', () => {
		const artifact = { status:'completed', derivedEvents:[{ type:'content_created', contentRef:{ model:'knowledge', path:'src/content/knowledge/guide.mdx' } }] };
		expect(missingPrecommitContentReceipts([artifact], 'knowledge_update')).toEqual([
			'assignment_terminal_status', 'assignment_summary',
		]);
		expect(missingPrecommitContentReceipts([artifact,
			{ toolId:'treeseed.assignment_status_update', status:'completed', inputSummary:{ status:'completed' } },
			{ toolId:'treeseed.assignment_summary', status:'completed', inputSummary:{ action:'write', status:'completed' } },
		], 'knowledge_update')).toEqual([]);
		expect(missingOperationalCloseoutReceipts([])).toEqual(['assignment_terminal_status','assignment_summary']);
		expect(missingOperationalCloseoutReceipts([
			{ toolId:'treeseed.assignment_status_update',status:'completed',inputSummary:{status:'completed'} },
			{ toolId:'treeseed.assignment_summary',status:'completed',inputSummary:{action:'write',status:'completed'} },
		])).toEqual([]);
	});

	it('binds the Chat output contract to the dedicated Discussion message model',()=>{
		expect(contentModelForArtifactKind('discussion_response')).toBe('discussion_message');
	});
});
