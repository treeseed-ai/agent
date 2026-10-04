import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { assignmentAttemptSchema, executionEdgeSchema, executionNodeSchema } from '@treeseed/sdk/agent-capacity';
import { row, type Row } from '../acceptance-cli.ts';

// Acceptance assertions only. Expected relations come from the authoritative
// document, never from returned graph edges or a second portfolio policy.
export function portfolioRelations(document: string, seed: string) {
	const marker = /acceptance portfolio contains these (\d+) projects:\n/u.exec(document);
	assert.ok(marker, 'ACCEPTANCE_PORTFOLIO_AUTHORITY: Missing declared project inventory');
	const list = document.slice(marker.index + marker[0].length).split('\n\n').find(block => block.trim());
	assert.ok(list);
	const names = list.trim().split('\n').map((line, index) => {
		const match = /^(\d+)\. ([\w -]+)$/u.exec(line);
		assert.ok(match && Number(match[1]) === index + 1, 'ACCEPTANCE_PORTFOLIO_AUTHORITY: Malformed ordered project inventory');
		return match[2]!;
	});
	assert.equal(names.length, Number(marker[1])); assert.equal(new Set(names).size, names.length);
	const projects = row(row(parse(seed)).resources).projects;
	assert.ok(Array.isArray(projects), 'ACCEPTANCE_PORTFOLIO_AUTHORITY: Missing seeded project authority');
	const selected = names.map(name => {
		const matches = projects.map(row).filter(project => typeof project.name === 'string' && project.name.replace(/^TreeSeed /u, '') === name);
		assert.equal(matches.length, 1, `ACCEPTANCE_PORTFOLIO_AUTHORITY: Ambiguous or unknown project ${name}`);
		const slug = matches[0]!.slug;
		assert.ok(typeof slug === 'string' && /^[a-z0-9-]+$/u.test(slug)); return { name, slug };
	});
	assert.equal(new Set(selected.map(project => project.slug)).size, selected.length);
	const heading = 'Fixed cross-project relations for the portfolio run:\n';
	assert.equal(document.split(heading).length, 2, 'ACCEPTANCE_PORTFOLIO_AUTHORITY: Missing or duplicate fixed relation table');
	const table = document.split(heading)[1]!.trimStart().split('\n\n')[0]!.split('\n');
	assert.equal(table[0], '| Approved predecessor | Dependent work item | Reason |');
	assert.equal(table[1], '|---|---|---|'); assert.ok(table.length > 2);
	function endpoints(cell: string) {
		const parts = cell.split(/,\s*(?:and\s+)?|\s+and\s+/u).map(part => part.trim());
		assert.ok(parts.every(Boolean));
		const parsed = parts.map(part => {
			const match = /^([\w -]+?)(?: `([a-z0-9-]+)`)?$/u.exec(part); assert.ok(match);
			const project = selected.find(value => value.name === match[1]); assert.ok(project, `ACCEPTANCE_PORTFOLIO_AUTHORITY: Unknown endpoint ${part}`);
			return { slug: project.slug, workItem: match[2] };
		});
		const shared = new Set(parsed.map(value => value.workItem).filter((value): value is string => value !== undefined));
		// The document uses a trailing work-item anchor for collective project lists.
		if (parsed.some(value => !value.workItem)) assert.ok(shared.size === 1 && parsed.at(-1)?.workItem, 'ACCEPTANCE_PORTFOLIO_AUTHORITY: Ambiguous collective anchor');
		return parsed.map(value => ({ slug: value.slug, workItem: value.workItem ?? [...shared][0]! }));
	}
	const relations = table.slice(2).flatMap(line => {
		const cells = /^\| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/u.exec(line); assert.ok(cells, 'ACCEPTANCE_PORTFOLIO_AUTHORITY: Malformed or truncated relation row');
		const from = endpoints(cells[1]!), to = endpoints(cells[2]!); assert.equal(to.length, 1);
		return from.map(source => { assert.notEqual(source.slug, to[0]!.slug); return { from: source, to: to[0]! }; });
	});
	assert.equal(new Set(relations.map(value => JSON.stringify(value))).size, relations.length, 'ACCEPTANCE_PORTFOLIO_AUTHORITY: Duplicate semantic relation');
	return { projects: selected, relations };
}

let authority: { root: string; head: string; document: string; seed: string } | undefined;
export function readPortfolioAuthority() {
	const root = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
	assert.ok(root, 'ACCEPTANCE_PORTFOLIO_AUTHORITY: Existing development workspace required');
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	const document = readFileSync(resolve(root, 'docs/agent-acceptance.md'), 'utf8');
	const seed = readFileSync(resolve(root, 'seeds/treeseed.yaml'), 'utf8');
	for (const [path, bytes] of [['docs/agent-acceptance.md', document], ['seeds/treeseed.yaml', seed]]) {
		assert.equal(bytes, execFileSync('git', ['show', `${head}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
	}
	const current = { root, head, document, seed };
	if (authority) assert.deepEqual(current, authority, 'ACCEPTANCE_PORTFOLIO_AUTHORITY: Moving or changed requirement authority');
	else authority = current;
	assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head);
	const expected = portfolioRelations(document, seed); assert.equal(expected.projects.length, 17);
	return { ...current, expected };
}

export function verifyPortfolioRelations(expected: ReturnType<typeof portfolioRelations>, bindings: Map<string, Row>, graph: Row, items: Row[], workday: string): void {
	assert.equal(bindings.size, expected.projects.length);
	const byId = new Map<string, { slug: string; repository: string }>();
	for (const project of expected.projects) {
		const binding = bindings.get(project.slug); assert.ok(binding);
		assert.equal(binding.teamId, graph.teamId);
		assert.ok(typeof binding.projectId === 'string' && binding.projectId.length > 0);
		assert.ok(typeof binding.repositoryId === 'string' && binding.repositoryId.length > 0);
		assert.ok(!byId.has(binding.projectId)); byId.set(binding.projectId, { slug: project.slug, repository: binding.repositoryId });
	}
	assert.equal(new Set([...byId.values()].map(value => value.repository)).size, byId.size);
	const attempts = items.map(item => {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		assert.equal(attempt.workdayId, workday); assert.equal(attempt.teamId, graph.teamId);
		assert.equal(item.id, attempt.id); assert.equal(item.projectId, attempt.projectId); assert.equal(item.status, 'completed');
		assert.ok(byId.has(attempt.projectId)); return attempt;
	});
	assert.equal(new Set(attempts.map(value => value.id)).size, attempts.length);
	assert.deepEqual([...new Set(attempts.map(value => value.projectId))].sort(), [...byId.keys()].sort(), 'ACCEPTANCE_PORTFOLIO_INVENTORY: Partial selected portfolio');
	assert.ok(Array.isArray(graph.nodes) && Array.isArray(graph.edges));
	const nodes = graph.nodes.map(value => executionNodeSchema.parse(value)), edges = graph.edges.map(value => executionEdgeSchema.parse(value));
	assert.equal(new Set(nodes.map(value => value.id)).size, nodes.length); assert.equal(new Set(edges.map(value => value.id)).size, edges.length);
	const consumed = new Set(attempts.map(value => value.nodeId));
	for (const attempt of attempts) {
		const node = nodes.find(value => value.id === attempt.nodeId); assert.ok(node);
		assert.equal(node.teamId, attempt.teamId); assert.equal(node.projectId, attempt.projectId); assert.equal(node.workItemId, attempt.workItemId);
		assert.deepEqual(node.sourceRef, attempt.sourceRef); assert.equal(node.sourceRef.repository, byId.get(node.projectId)!.repository);
	}
	const actual: string[] = [];
	for (const edge of edges) {
		if (!consumed.has(edge.toNodeId)) continue;
		const from = nodes.find(value => value.id === edge.fromNodeId), to = nodes.find(value => value.id === edge.toNodeId); assert.ok(from && to);
		if (from.projectId === to.projectId) continue;
		assert.ok(consumed.has(from.id)); assert.equal(edge.teamId, graph.teamId);
		assert.equal(edge.provenance, 'treedx-link'); assert.equal(from.pairRole, 'reviewer'); assert.equal(to.pairRole, 'actor');
		assert.equal(edge.sourceRef?.store, 'treedx'); assert.equal(edge.sourceRef?.model, 'note');
		const source = byId.get(from.projectId), target = byId.get(to.projectId); assert.ok(source && target);
		actual.push(JSON.stringify({ from: { slug: source.slug, workItem: from.workItemId }, to: { slug: target.slug, workItem: to.workItemId } }));
	}
	assert.equal(new Set(actual).size, actual.length, 'ACCEPTANCE_PORTFOLIO_INVENTORY: Duplicate semantic dependency');
	assert.deepEqual(actual.sort(), expected.relations.map(value => JSON.stringify(value)).sort(), 'ACCEPTANCE_PORTFOLIO_INVENTORY: Missing or extra fixed dependency');
}
