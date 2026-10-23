import { expect, it } from 'vitest';
import { promptFromContext } from '../../../../src/kernel/handlers/model-workload-contract.ts';

it('preserves exact authorized context without adding rediscovery instructions', () => {
 const content = { ref: { commit: 'a'.repeat(40) }, value: { body: 'Original exact content.' } };
 const rendered = promptFromContext({ canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'acting', handler: 'actor', prompt: { system: 'Implement the approved repair.' } } }, context: [content], predecessorResults: [] } });
 expect(JSON.parse(rendered.split('\n\n').at(-1)!).canonicalAssignmentContext.context).toEqual([content]);
 expect(rendered).not.toContain('Do not rebuild that same context');
});

it('does not infer release instructions from class handler or criteria text', () => {
 for(const activity of ['acting','reviewing']) {
  const rendered = promptFromContext({ canonicalAssignmentContext: { assignment: { agentClass: 'releaser', authorityRefs: [{ model: 'decision' }], effectiveProfile: { activity, handler: 'releaser', prompt: { system: 'Follow the accepted repair boundary.' } }, acceptanceCriteria: ['Later checks are coordinator release gates.'] } } });
  expect(rendered.split('\n\n').slice(0,-1)).toEqual(['Follow the accepted repair boundary.']);
  expect(rendered).not.toContain('CURRENT-ATTEMPT INDEPENDENT RELEASE VERIFICATION');
  expect(rendered).not.toContain('standalone archive verification command');
 }
});
