import { DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';

// Controlled prospective test inputs, never genuine estimates or accepted runs.
export function campaignInputs(slugs: readonly string[]) {
	const proposals = slugs.map(slug => ({ slug, id: `proposal-${slug}`, projectId: `project-${slug}` }));
	const policy = { id: 'default', revision: 2, policy: { ...DEFAULT_WORKDAY_POLICY,
		maximumConcurrency: 5, communicationConcurrency: 5 } };
	const supply = [{ providerId: 'supplied-provider', status: 'active', nativeLimits: { dailyActiveSecondsLimit: 28800 } }];
	const classes = Object.fromEntries(['architect', 'researcher', 'tester', 'engineer', 'technical-writer',
		'releaser', 'reviewer', 'reporter'].map(name => [name, 12.5]));
	function expand(id: string, selected: typeof proposals, portfolio = false) {
		return { id, input: { profileId: 'default', projects: selected.map(value => value.projectId),
			proposalIds: selected.map(value => value.id), executionMode: 'simulation', startsAt: '2026-10-07T09:00:00.000Z',
			durationSeconds: portfolio ? 28800 : 3600, allocation: { planningPercent: portfolio ? 20 : 100 / 3,
				allocationWeight: 1, planningTurnMaximumSeconds: 180,
				projectPercentages: Object.fromEntries(selected.map(value => [value.projectId, portfolio ? 1 : 100 / selected.length])),
				agentClassPercentages: Object.fromEntries(selected.map(value => [value.projectId, classes])) } },
			policy: { id: 'default', revision: 2, durationSeconds: 28800, maximumConcurrency: 5, communicationConcurrency: 5 },
			providerOfferRevision: 3, providerSupply: supply, acceptedDecisionIds: [], acceptedEstimateRefs: 'pending genuine planning results' };
	}
	const inputs: Record<string, ReturnType<typeof expand> & { sourceAcceptedRun?: string; injectedFault?: string }> = {};
	for (const proposal of proposals) inputs[proposal.slug] = expand(proposal.slug, [proposal]);
	inputs['sdk-api-joint'] = expand('sdk-api-joint', proposals.filter(value => ['sdk', 'api'].includes(value.slug)));
	inputs['all-project-portfolio'] = expand('all-project-portfolio', proposals, true);
	for (const fault of ['actor-summary-corruption', 'review-exhaustion', 'provider-interruption',
		'provider-ineligibility', 'mid-workday-question', 'external-mutation-denial'])
		inputs[`fault-${fault}`] = { ...inputs.sdk!, id: `fault-${fault}`, sourceAcceptedRun: 'sdk', injectedFault: fault };
	return { campaignId: 'supplied-complete', proposals, workdayPolicy: policy, providerOfferRevision: 3, allocationInputsByRun: inputs };
}
