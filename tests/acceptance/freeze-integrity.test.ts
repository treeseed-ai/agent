import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readCampaignProjectLibraries, readPreRunCampaignFreeze, verifyFreezeIntegrity } from './freeze-integrity.ts';

test('Golden pre-run campaign freeze retains every schema-valid expanded input and original manifest bytes before SDK execution', () => {
	const original = readPreRunCampaignFreeze();
	const held = readFileSync(original.path);
	assert.equal(held.toString('utf8'), original.bytes);
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	const bindings = readCampaignProjectLibraries(original.manifest, team);
	assert.deepEqual(readCampaignProjectLibraries(original.manifest, team), bindings);
	const independentlyRead = readPreRunCampaignFreeze();
	assert.deepEqual(independentlyRead, original);
	assert.deepEqual(readFileSync(original.path), held);
});

test('Golden freeze evidence retains exact receipt and runtime integrity', () => {
	const path = process.env.TREESEED_ACCEPTANCE_FREEZE_PATH;
	assert.ok(path, 'ACCEPTANCE_FREEZE_REQUIRED: An explicit existing freeze path is required');
	verifyFreezeIntegrity(JSON.parse(readFileSync(path, 'utf8')), readFileSync);
});
