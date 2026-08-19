import { readdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { parse as parseYaml } from 'yaml';
import { describe,expect,it } from 'vitest';

describe('Agent shipped agent definitions', () => {
	it('remain compatible with the SDK authority and capacity-provider contract', () => {
		const root = resolve(process.cwd(),'docs/src/content/agents');
		const names = readdirSync(root).filter((entry) => entry.endsWith('.mdx')).sort();
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			const source = readFileSync(resolve(root,name),'utf8');
			const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
			expect(match,`${name} must contain YAML frontmatter`).not.toBeNull();
			expect(validateAgentDefinitionModel(parseYaml(match![1])),name).toMatchObject({ ok:true,diagnostics:[] });
		}
	});
});
