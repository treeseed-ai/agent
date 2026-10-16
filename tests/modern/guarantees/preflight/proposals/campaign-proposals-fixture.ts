import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';

// Controlled original content for the public reader, never current campaign authority.
export const proposalRoles = [
	['research-context', 'Researcher', 'treedx'], ['architecture-contract', 'Architect', 'treedx'],
	['tests-first', 'Tester', 'git'], ['implement-change', 'Engineer', 'git'],
	['document-change', 'Technical Writer', 'git'], ['simulate-release', 'Releaser', 'git'],
] as const;
export const proposalDocument = '### Fixed work-item graph\n'
	+ proposalRoles.map(([id, role, workspace]) => `| \`${id}\` | ${role} | \`${workspace}\` | none | 2 |`).join('\n') + '\n\n'
	+ Array.from({ length: 17 }, (_, index) => `### ${index + 1}. Configured ${index} — controlled work\n`
		+ `- Source: \`treeseed-ai/configured-${index}#1\`\n- Title: **Original ${index} title**\n`
		+ `- Request: Original ${index} request.\n- Summary: Original ${index} summary.\n`
		+ proposalRoles.map(([, role]) => `| ${role} | Original ${index} ${role} objective. |`).join('\n') + '\n').join('\n');

export function campaignProposal(index: number, source = 'a'.repeat(40), library = 'b'.repeat(40), governed = 'c'.repeat(40)) {
	const expected = { slug: `configured-${index}`, name: `Configured ${index}`, id: `proposal-${index}`,
		projectId: `project-${index}`, sourceCommit: source, libraryCommit: library,
		sourceRepository: `treeseed-ai/configured-${index}`, libraryRepository: `treeseed-ai/configured-${index}-library` };
	const binding = { projectId: expected.projectId, teamId: 'native-team', repositoryId: `repo_native_${index}` };
	const proposal = { schemaVersion: 'treeseed.proposal/v1', id: expected.id, projectId: expected.projectId,
		title: `Original ${index} title`, request: `Original ${index} request.`, summary: `Original ${index} summary.`, status: 'draft',
		evidenceRefs: [{ store: 'url', model: 'issue', id: `source-${index}`, url: `https://github.com/treeseed-ai/configured-${index}/issues/1` }],
		executionPlan: { workItems: proposalRoles.map(([id, role, workspace]) => ({ id, workspace,
			agentClass: role.toLowerCase().replace(/ /gu, '-'), activity: 'acting', review: 'required', maximumReviewCycles: 2,
			objective: `Original ${index} ${role} objective.`, dependsOn: [], requiredCapabilities: ['source.read'],
			acceptanceCriteria: [`Verify the original ${role} result against its exact source.`],
			requestedPermissions: { content: { read: ['proposal'], write: workspace === 'treedx' ? ['knowledge'] : [] }, tools: ['source.read'] },
			contextRefs: [{ store: 'git', model: 'repository', id: `source-${index}`, repository: `treeseed-ai/configured-${index}`, commit: source },
				...(workspace === 'treedx' ? [{ store: 'treedx', model: 'repository', id: `library-${index}`, repository: `treeseed-ai/configured-${index}-library`, commit: library }] : [])] })) } };
	const content = `---\n${stringify(proposal, { aliasDuplicateObjects: false })}---\nOriginal controlled draft body.\n`;
	const path = `proposals/governance/${expected.id}.mdx`, digest = createHash('sha256').update(content).digest('hex');
	return { expected: {...expected,draftRef:{store:'treedx',model:'proposal',id:expected.id,repository:binding.repositoryId,commit:governed,path,revision:1,digest:'sha256:'+digest}}, binding, governance: { id: expected.id, projectId: expected.projectId, title: proposal.title,
		body: proposal.request, summary: proposal.summary, activeVersion: 1, activeContentHash: digest,
		metadata: { contentProvenance: { repositoryId: binding.repositoryId, commitSha: governed, contentPath: path, digest } } },
		observed: { ok: true, ref: governed, resolvedRef: governed, repoId: binding.repositoryId,
			files: [{ path, content, frontmatter: parse(content.match(/^---\n([\s\S]*?)\n---/u)![1]!) as Record<string, unknown> }] } };
}

export function rewriteProposal(value: ReturnType<typeof campaignProposal>, change: (proposal: Record<string, unknown>) => void) {
	const file = value.observed.files[0]!, proposal = structuredClone(file.frontmatter); change(proposal);
	file.content = `---\n${stringify(proposal, { aliasDuplicateObjects: false })}---\nOriginal controlled draft body.\n`;
	file.frontmatter = proposal;
	const digest = createHash('sha256').update(file.content).digest('hex');
	value.governance.activeContentHash = digest; value.governance.metadata.contentProvenance.digest = digest;
	value.expected.draftRef.digest='sha256:'+digest;
	for (const [indexField, sourceField] of [['title', 'title'], ['body', 'request'], ['summary', 'summary']])
		Reflect.set(value.governance, indexField!, proposal[sourceField!]);
}
