import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { verifyCampaignProjectProfiles } from '../../../acceptance/workday/support/preflight/campaign-profiles.ts';
import { campaignProfiles } from './campaign-freeze-fixture.ts';

it('denies consistently rehashed declared handlers absent from the original compiled production registry without dispatch or input mutation', () => {
	const ref = 'a'.repeat(40), binding = { projectId: 'project-configured', repositoryId: 'library-configured' };
	const original = campaignProfiles('configured', ref, binding.repositoryId);
	for (const index of [0, 7]) {
		const denied = structuredClone(original), definition = denied.inventory.agents[index]!.definition;
		definition.activityProfiles.chat.handler = 'unregistered-handler';
		const file = denied.files[index]!.files[0]!; file.frontmatter = definition;
		file.content = `---\n${stringify(definition)}---\n\nControlled unchanged unknown-handler observation.\n`;
		const bytes = Buffer.from(file.content), entry = denied.paths.entries[index]!;
		entry.size = bytes.length; entry.objectId = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
		const held = structuredClone(denied);
		expect.soft(() => verifyCampaignProjectProfiles(binding, ref, denied.paths, denied.files, denied.inventory)).toThrow();
		expect(denied).toEqual(held);
	}
	const held = structuredClone(original);
	verifyCampaignProjectProfiles(binding, ref, original.paths, original.files, original.inventory); expect(original).toEqual(held);
});

it('retains exact configured profile bytes and denies incomplete stale foreign or contradictory profile inventories', () => {
	const ref = 'a'.repeat(40), binding = { projectId: 'project-renamed', repositoryId: 'library-renamed' };
	const original = campaignProfiles('renamed', ref, binding.repositoryId, Array.from({ length: 8 }, (_, i) => `configured-${i}`));
	const inspect = (value: typeof original) => verifyCampaignProjectProfiles(binding, ref, value.paths, value.files, value.inventory);
	const held = structuredClone(original); inspect(original); expect(original).toEqual(held);
	const mutations: Array<(value: typeof original) => void> = [
		value => { value.paths.ok = false; }, value => { value.paths.ref = 'staging'; },
		value => { value.paths.resolvedRef = 'b'.repeat(40); }, value => { value.paths.repoId = 'foreign'; },
		value => { value.paths.page.hasMore = true; }, value => { Object.assign(value.paths.page, { nextCursor: 'omitted-tail' }); },
		value => { value.paths.entries.pop(); }, value => { value.paths.entries.push(value.paths.entries[0]!); },
		value => { value.files.pop(); }, value => { value.files.push(value.files[0]!); },
		value => { value.inventory.projectId = 'foreign'; }, value => { value.inventory.agents.pop(); },
		value => { value.inventory.agents.push(value.inventory.agents[0]!); },
	];
	for (let index = 0; index < 8; index++) mutations.push(
		value => { value.paths.entries[index]!.path = '../outside.mdx'; },
		value => { value.paths.entries[index]!.mode = '120000'; }, value => { value.paths.entries[index]!.kind = 'tree'; },
		value => { value.paths.entries[index]!.size++; }, value => { value.paths.entries[index]!.objectId = 'b'.repeat(40); },
		value => { value.files[index]!.ok = false; }, value => { value.files[index]!.ref = 'b'.repeat(40); },
		value => { value.files[index]!.resolvedRef = 'staging'; }, value => { value.files[index]!.repoId = 'foreign'; },
		value => { value.files[index]!.files[0]!.path = 'agents/foreign.mdx'; },
		value => { value.files[index]!.files[0]!.content += 'Altered bytes'; },
		value => { value.files[index]!.files[0]!.frontmatter.purpose = 'Contradictory parsed authority'; },
		value => { value.inventory.agents[index]!.agentSlug = 'foreign'; },
		value => { value.inventory.agents[index]!.definitionRevision = 'b'.repeat(40); },
		value => { value.inventory.agents[index]!.definition.activityProfiles.chat.handler = 'unreviewed'; },
		value => { value.inventory.agents[index]!.definition.activityProfiles.chat.prompt.system = 'Unreviewed configured prompt'; },
		value => { value.inventory.agents[index]!.definition.activityProfiles.chat.permissions.tools.push('discussion'); },
	);
	const observations = mutations.map(mutate => {
		const changed = structuredClone(original); mutate(changed); const before = structuredClone(changed);
		let failure = ''; try { inspect(changed); } catch (error) { failure = String(error); }
		expect(failure).toContain('ACCEPTANCE_CAMPAIGN_PROFILES'); expect(changed).toEqual(before); return failure;
	});
	expect(observations).toHaveLength(149); inspect(original); expect(original).toEqual(held);
	// Even matching API/source claims and correct Git hashes cannot authorize
	// malformed governed YAML or duplicate configured identities.
	for (let index = 0; index < 8; index++) for (const defect of ['schema', 'handler', 'prompt', 'permissions', 'capabilities', 'duplicate-id']) {
		const changed = structuredClone(original), definition = changed.inventory.agents[index]!.definition;
		if (defect === 'schema') definition.schemaVersion = 'treeseed.agent/v0';
		if (defect === 'handler') definition.activityProfiles.chat.handler = '';
		if (defect === 'prompt') definition.activityProfiles.chat.prompt.system = 'Too short';
		if (defect === 'permissions') definition.activityProfiles.chat.permissions.tools.push('prohibited-tool');
		if (defect === 'capabilities') definition.capabilities = [];
		if (defect === 'duplicate-id') definition.id = changed.inventory.agents[(index + 1) % 8]!.definition.id;
		const file = changed.files[index]!.files[0]!;
		file.frontmatter = definition; file.content = `---\n${stringify(definition)}---\n\nControlled invalid definition.\n`;
		const bytes = Buffer.from(file.content), entry = changed.paths.entries[index]!;
		entry.size = bytes.length; entry.objectId = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
		const before = structuredClone(changed); expect(() => inspect(changed)).toThrow('ACCEPTANCE_CAMPAIGN_PROFILES'); expect(changed).toEqual(before);
	}
});
