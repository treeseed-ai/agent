import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { portfolioRelations, verifyPortfolioRelations } from '../../../acceptance/workday/support/portfolio-relations.ts';
import { crossProjectReadbackInputs } from './custody/cross-project-readback-fixture.ts';
import type { Row } from '../../../acceptance/acceptance-cli.ts';

const document = 'The acceptance portfolio contains these 2 projects:\n\n1. SDK\n2. API\n\nFixed cross-project relations for the portfolio run:\n\n| Approved predecessor | Dependent work item | Reason |\n|---|---|---|\n| SDK `bounded-work` | API `bounded-work` | Supplied UNIT authority input |\n\n';
const seed = 'resources:\n  projects:\n    - { name: TreeSeed SDK, slug: precursor }\n    - { name: TreeSeed API, slug: dependent }\n';
function inputs() {
	const fixture = crossProjectReadbackInputs(), expected = portfolioRelations(document, seed);
	const bindings = new Map<string, Row>(expected.projects.map(project => [project.slug, { projectId: project.slug, teamId: fixture.graph.teamId, repositoryId: `${project.slug}-library` }]));
	return { ...fixture, expected, bindings, workday: assignmentAttemptSchema.parse(fixture.items[0]!.assignmentAttempt).workdayId };
}
function verify(value: ReturnType<typeof inputs>) { verifyPortfolioRelations(value.expected, value.bindings, value.graph, value.items, value.workday); }

describe('independent portfolio relation inventory', () => {
	it('derives named project slugs and collective work-item anchors from supplied document and seed authority without copying the returned graph', () => {
		const original = inputs(), before = structuredClone(original); verify(original); expect(original).toEqual(before);
		const expanded = portfolioRelations(document.replace('2 projects', '4 projects').replace('2. API\n', '2. API\n3. Engineering Template\n4. Platform\n')
			.replace('SDK `bounded-work` | API', 'SDK, Engineering Template, and Platform `bounded-work` | API'),
			seed + '    - { name: Engineering Template, slug: template-engineering }\n    - { name: TreeSeed Platform, slug: platform }\n');
		expect(expanded.relations.map(value => value.from)).toEqual([{ slug: 'precursor', workItem: 'bounded-work' }, { slug: 'template-engineering', workItem: 'bounded-work' }, { slug: 'platform', workItem: 'bounded-work' }]);
	});
	it('denies absent truncated unknown duplicate or ambiguous document seed and collective endpoint authority', () => {
		for (const bytes of ['', document.replace('2 projects', '3 projects'), document.replace('2. API', '2. SDK'), document.replace('Approved predecessor', 'Unknown'), document.replace('| API `bounded-work` |', '| Missing `bounded-work` |'),
			document.replace('SDK `bounded-work`', 'SDK'), document.replace('SDK `bounded-work`', 'SDK and API'), document.replace('Supplied UNIT authority input |', 'truncated'), document + document.slice(document.indexOf('Fixed cross-project')),
			document.replace('| SDK `bounded-work` | API `bounded-work` | Supplied UNIT authority input |', '| SDK `bounded-work` | API `bounded-work` | reason |\n| SDK `bounded-work` | API `bounded-work` | repeated |')]) {
			expect(() => portfolioRelations(bytes, seed)).toThrow();
		}
		for (const bytes of ['', seed.replace('TreeSeed API', 'Foreign API'), seed + '    - { name: TreeSeed API, slug: another }\n', seed.replace('slug: dependent', 'slug: precursor')]) expect(() => portfolioRelations(document, bytes)).toThrow();
	});
	it('denies missing extra duplicated implicit actor-only dangling and wrong-anchor dependencies against the entire independent expected set', () => {
		const mutations: Array<(value: ReturnType<typeof inputs>) => void> = [
			value => { value.graph.edges = value.graph.edges.filter(edge => edge.provenance !== 'treedx-link'); },
			value => { value.expected.relations.push({ from: { slug: 'dependent', workItem: 'another-work' }, to: { slug: 'precursor', workItem: 'bounded-work' } }); },
			value => { value.graph.edges.push({ ...value.graph.edges[1]!, id: 'duplicate-semantic-edge' }); },
			value => { value.graph.edges[1]!.provenance = 'work-item'; }, value => { value.graph.edges[1]!.fromNodeId = 'actor'; },
			value => { value.graph.edges[1]!.fromNodeId = 'missing-review'; },
			value => { value.expected.relations[0]!.from.workItem = 'different-work'; },
			value => { value.expected.relations = []; },
		];
		for (const mutate of mutations) { const value = inputs(); mutate(value); const before = structuredClone(value); expect(() => verify(value)).toThrow(); expect(value).toEqual(before); }
	});
	it('denies incomplete foreign duplicate moved-library or wrong-workday project bindings rather than accepting a smaller managed portfolio', () => {
		const mutations: Array<(value: ReturnType<typeof inputs>) => void> = [
			value => { value.bindings.delete('dependent'); }, value => { value.bindings.get('dependent')!.projectId = 'foreign'; },
			value => { value.bindings.get('dependent')!.projectId = 'precursor'; }, value => { value.bindings.get('dependent')!.repositoryId = 'precursor-library'; },
			value => { value.bindings.get('dependent')!.repositoryId = 'moved-library'; }, value => { value.bindings.get('dependent')!.teamId = 'foreign-team'; },
			value => { value.items = value.items.filter(item => item.projectId === 'precursor'); }, value => { value.workday = 'foreign-workday'; },
			value => { value.items.push(structuredClone(value.items[0]!)); },
		];
		for (const mutate of mutations) { const value = inputs(); mutate(value); const before = structuredClone(value); expect(() => verify(value)).toThrow(); expect(value).toEqual(before); }
	});
});
