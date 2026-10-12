import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { createDefaultHandlers, HandlerRegistry } from '@treeseed/agent';
import { parse } from 'yaml';
import { read, row, type Row } from '../../../acceptance-cli.ts';
import type { readPreRunCampaignFreeze } from '../../../freeze-integrity.ts';

const fail = 'ACCEPTANCE_CAMPAIGN_PROFILES: Exact complete governed definitions required';

/** Independently indexed source bytes versus the public API's resolved profiles.
 * Paths and revisions come from the existing frozen library base, never a
 * moving local TreeDX branch or the API definition being checked. */
function profileEntries(binding: Row, ref: string, paths: Row): Row[] {
	assert.match(ref, /^[a-f0-9]{40}$/u, fail);
	assert.equal(paths.ok, true, fail); assert.equal(paths.ref, ref, fail);
	assert.equal(paths.resolvedRef, ref, fail); assert.equal(paths.repoId, binding.repositoryId, fail);
	assert.equal(row(paths.page).hasMore, false, fail); assert.equal(row(paths.page).nextCursor, null, fail);
	assert.ok(Array.isArray(paths.entries) && paths.entries.length === 8, fail);
	const entries = paths.entries.map(row);
	assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length, fail);
	for (const entry of entries) {
		assert.ok(typeof entry.path === 'string' && /^agents\/[A-Za-z0-9._-]+\.mdx$/u.test(entry.path), fail);
		assert.equal(entry.kind, 'blob', fail); assert.equal(entry.mode, '100644', fail);
		assert.match(String(entry.objectId), /^[a-f0-9]{40}$/u, fail);
		assert.ok(typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size > 0, fail);
	}
	return entries;
}

export function verifyCampaignProjectProfiles(binding: Row, ref: string, paths: Row, files: Row[], inventory: Row): void {
	const entries = profileEntries(binding, ref, paths);
	const handlers = new HandlerRegistry(createDefaultHandlers());
	assert.equal(files.length, entries.length, fail);
	assert.equal(inventory.projectId, binding.projectId, fail);
	assert.ok(Array.isArray(inventory.agents) && inventory.agents.length === entries.length, fail);
	const agents = inventory.agents.map(row);
	assert.equal(new Set(agents.map(agent => agent.agentSlug)).size, agents.length, fail);
	const ids = new Set<string>();
	for (const entry of entries) {
		const matches = files.filter(file => Array.isArray(file.files) && row(file.files[0]).path === entry.path);
		assert.equal(matches.length, 1, fail);
		const observed = matches[0]!;
		assert.equal(observed.ok, true, fail); assert.equal(observed.ref, ref, fail);
		assert.equal(observed.resolvedRef, ref, fail); assert.equal(observed.repoId, binding.repositoryId, fail);
		assert.ok(Array.isArray(observed.files) && observed.files.length === 1, fail);
		const file = row(observed.files[0]); assert.equal(typeof file.content, 'string', fail);
		const bytes = Buffer.from(file.content as string, 'utf8');
		assert.equal(bytes.length, entry.size, fail);
		assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), entry.objectId, fail);
		const document = (file.content as string).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
		assert.ok(document, fail); const definition: unknown = parse(document[1]!);
		assert.deepEqual(definition, file.frontmatter, fail);
		const validated = validateAgentDefinitionModel(definition); assert.equal(validated.ok, true, fail);
		assert.deepEqual(validated.data, definition, fail);
		for (const configured of Object.values(row(row(definition).activityProfiles))) {
			const handler = row(configured).handler; assert.ok(typeof handler === 'string', fail);
			try { handlers.resolve(handler); } catch (cause) { throw new Error(`${fail}: Compiled handler unavailable`, { cause }); }
		}
		const id = row(definition).id; assert.ok(typeof id === 'string' && !ids.has(id), fail); ids.add(id);
		const slug = (entry.path as string).slice('agents/'.length, -'.mdx'.length);
		const resolved = agents.filter(agent => agent.agentSlug === slug); assert.equal(resolved.length, 1, fail);
		assert.equal(resolved[0]!.definitionRevision, ref, fail);
		assert.deepEqual(resolved[0]!.definition, definition, fail);
	}
}

export function readCampaignProfiles(freeze: ReturnType<typeof readPreRunCampaignFreeze>, bindings: Map<string, Row>, team: string) {
	try {
		const observations = new Map<string, { ref: string; paths: Row; files: Row[]; inventory: Row }>();
		assert.ok(Array.isArray(freeze.manifest.proposals), fail);
		for (const proposal of freeze.manifest.proposals.map(row)) {
			const slug = String(proposal.slug), binding = bindings.get(slug); assert.ok(binding, fail);
			const projects = freeze.projects.filter(project => project.slug === slug); assert.equal(projects.length, 1, fail);
			const repositories = freeze.repositories.filter(repository => repository.role === 'library'
				&& repository.key === projects[0]!.libraryRepository && repository.project === projects[0]!.key);
			assert.equal(repositories.length, 1, fail);
			const ref = row(freeze.manifest.repositoryBases)[repositories[0]!.key];
			assert.ok(typeof ref === 'string', fail);
			const paths = row(read(['library', 'paths', slug, '--ref', ref, '--prefix', 'agents', '--limit', '200'], team, true).result);
			const files = profileEntries(binding, ref, paths).map(entry => row(read(['library', 'read', slug, String(entry.path), '--ref', ref], team, true).result));
			const inventory = read(['agents', 'list', '--project', slug, '--server', 'local'], team, true);
			verifyCampaignProjectProfiles(binding, ref, paths, files, inventory);
			observations.set(slug, { ref, paths, files, inventory });
		}
		assert.equal(observations.size, bindings.size, fail);
		assert.equal(readFileSync(freeze.path, 'utf8'), freeze.bytes, `${fail}: Operator manifest changed`);
		return observations;
	} catch (cause) { throw new Error(fail, { cause }); }
}
