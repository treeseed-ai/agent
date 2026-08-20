import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Agent contribution policy', () => {
	it('does not impose the AGPL commercial-license approval process', () => {
		const root = process.cwd();
		const template = readFileSync(resolve(root, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8');
		const guidance = readFileSync(resolve(root, 'CONTRIBUTING.md'), 'utf8');
		expect(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).license).toBe('Apache-2.0');
		expect(existsSync(resolve(root, '.github/workflows/contributor-license.yml'))).toBe(false);
		expect(existsSync(resolve(root, '.github/approved-committers.json'))).toBe(false);
		expect(template).not.toMatch(/Contribution grant|contribution-attestation/u);
		expect(guidance).toMatch(/does not require a separate contributor-grant checkbox/u);
	});
});
