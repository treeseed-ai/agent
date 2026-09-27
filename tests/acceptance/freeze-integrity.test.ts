import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyFreezeIntegrity } from './freeze-integrity.ts';

test('Golden freeze evidence retains exact receipt and runtime integrity', () => {
	const path = process.env.TREESEED_ACCEPTANCE_FREEZE_PATH;
	assert.ok(path, 'ACCEPTANCE_FREEZE_REQUIRED: An explicit existing freeze path is required');
	verifyFreezeIntegrity(JSON.parse(readFileSync(path, 'utf8')), readFileSync);
});
