import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';

const profiles = ['architect', 'engineer', 'tester', 'releaser', 'reporter', 'researcher', 'reviewer', 'technical-writer'];

describe('first-party agent profiles', () => {
	for (const profile of profiles) {
		it(`${profile} uses the canonical minimal profile contract`, async () => {
			const source = await readFile(resolve('docs/src/content/agents', `${profile}.mdx`), 'utf8');
			const match = source.match(/^---\n([\s\S]*?)\n---/u);
			expect(match, `${profile} frontmatter`).not.toBeNull();
			const result = validateAgentDefinitionModel(parse(match![1]!));
			expect(result.diagnostics, profile).toEqual([]);
		});
	}

	it('enables reviewing only for the Reviewer', async () => {
		const enabled: string[] = [];
		for (const profile of profiles) {
			const source = await readFile(resolve('docs/src/content/agents', `${profile}.mdx`), 'utf8');
			const frontmatter = parse(source.match(/^---\n([\s\S]*?)\n---/u)![1]!);
			if (frontmatter.activityProfiles.reviewing) enabled.push(profile);
		}
		expect(enabled).toEqual(['reviewer']);
	});
});
