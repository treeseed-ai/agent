import { DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';
import { parse, stringify } from 'yaml';
import { createHash } from 'node:crypto';
import type { SeedBundle } from '@treeseed/sdk/operator-contracts';

// Controlled prospective test inputs, never genuine estimates or accepted runs.
export function campaignInputs(slugs: readonly string[], seedBytes?: string) {
	const bundle = seedBytes ? parse(seedBytes) as SeedBundle : undefined;
	const seed = bundle ? { name: bundle.name, version: bundle.version, digest: bundle.digest } : undefined;
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
	const selected = bundle?.resources.projects.filter(project => slugs.includes(project.slug)) ?? [];
	const keys = selected.flatMap(project => [project.primaryRepository!, project.libraryRepository!]);
	const repositoryBases = Object.fromEntries(keys.map(key => [key, 'a'.repeat(40)]));
	return { campaignId: 'supplied-complete', seed, proposals, repositoryBases, workdayPolicy: policy, providerOfferRevision: 3, allocationInputsByRun: inputs };
}

// Controlled configuration bytes for independent index/source/API comparisons.
export function campaignProfiles(slug: string, ref: string, repoId: string,
	names = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter']) {
	const agents = names.map(agentSlug => ({ agentSlug, definitionRevision: ref, definition: {
		schemaVersion: 'treeseed.agent/v1', id: `${slug}/${agentSlug}`, name: `Configured ${agentSlug}`, agentClass: agentSlug,
		purpose: 'Controlled governed profile custody', responsibilities: ['Retain exact configured authority'],
		capabilities: ['source-read'], context: { include: ['project'] }, activityProfiles: {
			chat: { handler: 'writer', permissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] },
				prompt: { system: 'For coordination-only messages; Inspect project files only when asked.' } },
			...(agentSlug === 'reviewer' ? { reviewing: { handler: 'reviewer',
				permissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] },
				prompt: { system: 'Review only a completed Actor candidate bound to an accepted decision; approve only proven work. Proposal feedback and estimates belong to planning.' } } } : {}),
		},
	} }));
	const files = agents.map(agent => {
		const content = `---\n${stringify(agent.definition)}---\n\nControlled independent source.\n`;
		return { ok: true, ref, resolvedRef: ref, repoId,
			files: [{ path: `agents/${agent.agentSlug}.mdx`, content, frontmatter: agent.definition }] };
	});
	const entries = files.map(observed => {
		const file = observed.files[0]!, bytes = Buffer.from(file.content);
		return { path: file.path, kind: 'blob', mode: '100644', size: bytes.length,
			objectId: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
	});
	return { paths: { ok: true, ref, resolvedRef: ref, repoId, entries, page: { hasMore: false, nextCursor: null } },
		files, inventory: { projectId: `project-${slug}`, agents } };
}
