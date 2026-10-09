import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertPredecessorSynthesis, clockReading, timingAwarenessContract } from '@treeseed/agent';
import { resolveProviderConfig, orderConnectionsForFairPolling, loadProviderManifest, loadCapacityProviderIdentity } from '@treeseed/agent/provider-governance';

assert.equal(fileURLToPath(import.meta.resolve('@treeseed/agent')), resolve('node_modules/@treeseed/agent/dist/index.js'));
assert.equal(fileURLToPath(import.meta.resolve('@treeseed/agent/provider-governance')), resolve('node_modules/@treeseed/agent/dist/provider-governance.js'));
assert.equal(typeof loadProviderManifest, 'function');
assert.equal(typeof loadCapacityProviderIdentity, 'function');
const configuration = resolveProviderConfig({ env: { TREESEED_PROVIDER_DATA_DIR: '/isolated', TREESEED_CAPACITY_PROVIDER_MANIFEST: '/isolated/manifest.yaml' } });
assert.equal(configuration.dataDir, '/isolated');
assert.equal(configuration.manifestPath, '/isolated/manifest.yaml');
assert.equal(configuration.maxConcurrentRunners, 1);
const connections = [{ connection: { id: 'one' }, teamId: 'team-one' }], held = structuredClone(connections);
assert.deepEqual(orderConnectionsForFairPolling(connections, { claims: [], events: [] }), held);
assert.deepEqual(connections, held);
const context = { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'planning' } }, predecessorResults: [{ id: 'prior-one' }, { id: 'prior-two' }] } };
assertPredecessorSynthesis(context, { summary: '- prior-one: incorporated boundary\n- prior-two: incorporated failure model' });
assert.throws(() => assertPredecessorSynthesis(context, { summary: '- prior-one: incorporated boundary' }), /predecessor_result_citation_missing/u);
assert.equal(clockReading({}), undefined);
const clock = { startedAt: '2026-10-09T12:00:00.000Z', deadlineAt: '2026-10-09T12:01:00.000Z', observedAt: '2026-10-09T12:00:01.000Z', remainingSeconds: 59 };
assert.deepEqual(clockReading({ content: [{ type: 'text', text: JSON.stringify(clock) }] }), clock);
assert.equal(clockReading({ content: [{ type: 'text', text: JSON.stringify({ ...clock, remainingSeconds: 60 }) }] }), undefined);
assert.deepEqual(timingAwarenessContract([]), { requiredChecks: 2, completedChecks: 0, firstTool: null, firstToolSucceeded: false, lastTool: null, lastToolSucceeded: false,
 schemaVersion: 'treeseed.assignment-timing-awareness/v1', firstToolCompliant: false, finalToolCompliant: false });
console.log(JSON.stringify({ installedPublicContracts: 'passed' }));
