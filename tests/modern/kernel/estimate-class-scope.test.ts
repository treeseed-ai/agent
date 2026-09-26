import { describe, expect, it } from 'vitest';
import { estimateMutableField, estimateProposalOutputSchema } from '../../../src/activity-completion.ts';

describe('class-owned proposal estimating', () => {
	it('allows every owned work item and only required Reviewer work', () => {
		const engineer = { id: 'implementation', agentClass: 'engineer', review: 'required' };
		const integration = { id: 'integration', agentClass: 'engineer', review: 'required' };
		const tester = { id: 'tests', agentClass: 'tester', review: 'none' };
		expect([engineer, integration, tester].map((item) => estimateMutableField(item, 'engineer')))
			.toEqual(['estimate', 'estimate', undefined]);
		expect([engineer, integration, tester].map((item) => estimateMutableField(item, 'reviewer')))
			.toEqual(['reviewEstimate', 'reviewEstimate', undefined]);
		const schema = estimateProposalOutputSchema({ executionPlan: { workItems: [engineer, integration, tester] } }, 'engineer');
		const plan = (schema.properties as { executionPlan: { properties: {
			workItems: { items: { anyOf: Array<{ properties: Record<string, unknown> }> } }
		} } }).executionPlan;
		const items = plan.properties.workItems.items.anyOf;
		expect(items).toHaveLength(2);
		expect(items.map((item) => Object.hasOwn(item.properties, 'estimate'))).toEqual([true, true]);
		expect(items.map((item) => (item.properties.id as { const: string }).const)).toEqual(['implementation', 'integration']);
		const assigned = estimateProposalOutputSchema({ executionPlan: { workItems: [engineer, integration, tester] } }, 'engineer', 'integration');
		const assignedItems = ((assigned.properties as any).executionPlan.properties.workItems.items.anyOf);
		expect(assignedItems).toHaveLength(1);
		expect(assignedItems[0].properties).not.toHaveProperty('id');
		expect(() => estimateProposalOutputSchema({ executionPlan: { workItems: [tester] } }, 'engineer'))
			.toThrow('estimate_work_item_scope_missing');
	});
});
