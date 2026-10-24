import { describe, expect, it } from 'vitest';
import { estimateMutableField, estimateProposalOutputSchema, mergeSubscriberEstimateOutput } from '../../../src/activity-completion.ts';

describe('class-owned proposal estimating', () => {
	it('allows every owned work item and only required Reviewer work', () => {
		const engineer = { id: 'implementation', agentClass: 'engineer', review: 'required' };
		const integration = { id: 'integration', agentClass: 'engineer', review: 'required' };
		const tester = { id: 'tests', agentClass: 'tester', review: 'none' };
		expect([engineer, integration, tester].map((item) => estimateMutableField(item, 'engineer')))
			.toEqual(['estimate', 'estimate', undefined]);
		expect([engineer, integration, tester].map((item) => estimateMutableField(item, 'reviewer')))
			.toEqual(['reviewEstimate', 'reviewEstimate', undefined]);
		const schema = estimateProposalOutputSchema({ executionPlan: { workItems: [engineer, integration, tester] } }, { agentClass: 'engineer' });
		const plan = (schema.properties as { executionPlan: { properties: {
			workItems: { items: { anyOf: Array<{ properties: Record<string, unknown> }> } }
		} } }).executionPlan;
		const items = plan.properties.workItems.items.anyOf;
		expect(items).toHaveLength(2);
		expect(items.map((item) => Object.hasOwn(item.properties, 'estimate'))).toEqual([true, true]);
		expect(items.map((item) => (item.properties.id as { const: string }).const)).toEqual(['implementation', 'integration']);
		const assigned = estimateProposalOutputSchema({ executionPlan: { workItems: [engineer, integration, tester] } }, { agentClass: 'engineer', workItemId: 'integration' });
		const assignedItems = ((assigned.properties as any).executionPlan.properties.workItems.items.anyOf);
		expect(assignedItems).toHaveLength(1);
		expect(assignedItems[0].properties).not.toHaveProperty('id');
		expect(() => estimateProposalOutputSchema({ executionPlan: { workItems: [tester] } }, { agentClass: 'engineer' }))
			.toThrow('estimate_work_item_scope_missing');
	});
});

describe('subscriber-owned proposal estimating', () => {
	const proposal = { schemaVersion: 'treeseed.proposal/v2', id: 'prepared-workload-repair', projectId: 'agent',
		groupIds: ['provider-runtime'], title: 'Preserve prepared workload inputs', status: 'discussing',
		request: 'Document, reproduce and repair the actual model request handoff.', summary: 'Each subscriber owns meaningful source work.' };
	const assignment = { id: 'estimate-docs', attempt: 2, agentClass: 'maintenance', sourceRef: { model: 'proposal', id: proposal.id },
		effectiveProfile: { activity: 'estimating' } };
	const reference = { store: 'postgresql', model: 'assignment-attempt', id: assignment.id, revision: assignment.attempt };
	const estimate = { expectedSeconds: 120, maximumSeconds: 240, rationale: 'Controlled own contribution input, not measured execution.' };
	const work = { id: 'document-handoff', activity: 'acting', workspace: 'read-only', review: 'required', maximumReviewCycles: 2,
		objective: 'Document the actual prepared request contract.', estimateRef: reference, estimate, reviewEstimate: estimate,
		dependsOn: [], requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: [] },
		acceptanceCriteria: ['Document the concrete interface that the regression and repair must implement.'] };
	const patch = { executionPlan: { workItems: [work] } };
	it('claims its own discussed item while retaining an unestimated downstream contribution', () => {
		const unestimated = (item: Record<string, unknown>) => Object.fromEntries(Object.entries(item)
			.filter(([key]) => !['estimate', 'estimateRef', 'reviewEstimate'].includes(key)));
		const peer = unestimated({ ...work, id: 'implement-handoff', dependsOn: [work.id] });
		const base = { ...proposal, executionPlan: { workItems: [unestimated(work), peer] } }, held = structuredClone(base);
		expect(mergeSubscriberEstimateOutput(base, patch, assignment)).toEqual({ ...base,
			executionPlan: { workItems: [work, peer] } });
		expect(base).toEqual(held);
	});
	it('requires actual own estimates even while the shared plan permits unestimated peers', () => {
		const schema = estimateProposalOutputSchema(proposal, assignment);
		const item = (schema.properties as { executionPlan: { properties: { workItems: {
			items: { required: string[] } } } } }).executionPlan.properties.workItems.items;
		expect(item.required).toEqual(expect.arrayContaining(['estimateRef', 'estimate']));
		for (const field of ['estimate', 'reviewEstimate']) {
			const incomplete = { ...work } as Record<string, unknown>; Reflect.deleteProperty(incomplete, field);
			const output = { executionPlan: { workItems: [incomplete] } }, held = structuredClone(output);
			expect(() => mergeSubscriberEstimateOutput(proposal, output, assignment)).toThrow();
			expect(output).toEqual(held);
		}
	});
	it('pins the actual attempt without a role filter and preserves peers in one private candidate on first contribution and retry', () => {
		const peer = { ...work, id: 'reproduce-handoff', estimateRef: { ...reference, id: 'estimate-peer' } };
		const base = { ...proposal, executionPlan: { workItems: [peer] } }, held = structuredClone(base);
		for (const agentClass of ['maintenance', 'reviewer', 'renamed-allocation']) {
			const schema = estimateProposalOutputSchema(proposal, { ...assignment, agentClass });
			expect(schema).toEqual(estimateProposalOutputSchema(proposal, assignment));
			const result = mergeSubscriberEstimateOutput(base, patch, { ...assignment, agentClass });
			expect(result).toEqual({ ...base, executionPlan: { workItems: [work, peer] } });
			expect(mergeSubscriberEstimateOutput(result, patch, { ...assignment, agentClass })).toEqual(result);
		}
		expect(base).toEqual(held);
	});
	it('rejects forged malformed and unrelated output before any private content commit', () => {
		for (const changed of [
			{ ...patch, request: 'Changed authored objective.' },
			{ executionPlan: { workItems: [] } },
			{ executionPlan: { workItems: [work, work] } },
			{ executionPlan: { workItems: [{ ...work, agentClass: 'engineer' }] } },
			{ executionPlan: { workItems: [{ ...work, estimateRef: { ...reference, id: 'foreign' } }] } },
			{ executionPlan: { workItems: [{ ...work, estimateRef: { ...reference, revision: 3 } }] } },
			{ executionPlan: { workItems: [{ ...work, estimate: { ...estimate, expectedSeconds: 300 } }] } },
		]) {
			const held = structuredClone(changed);
			expect(() => mergeSubscriberEstimateOutput(proposal, changed, assignment)).toThrow(); expect(changed).toEqual(held);
		}
		for (const invalid of [{ ...assignment, id: '' }, { ...assignment, attempt: 0 }, { ...assignment, attempt: '2' },
			{ ...assignment, sourceRef: { model: 'proposal', id: 'another-objective' } }]) {
			expect(() => estimateProposalOutputSchema(proposal, invalid)).toThrow('estimate_assignment_authority_required');
		}
	});
});
