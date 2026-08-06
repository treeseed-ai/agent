import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverOrphanedAcceptanceClaims, resolveLiveAcceptanceExecutionProvider, runWithAcceptanceAvailabilityHeartbeat, waitForAcceptanceDispatches } from '../../../src/provider-acceptance.ts';
import { ProviderLocalCapacityStore } from '../../../src/provider/capacity/capacity-core/local-capacity-store.ts';

describe('live capacity acceptance provider compilation', () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	async function manifest(sourcePolicy = true) {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-provider-acceptance-test-'));
		roots.push(root);
		await writeFile(join(root, 'treeseed.capacity-provider.yaml'), [
			'schemaVersion: 2',
			'identity:',
			'  privateKeyRef: data://identity.json',
			'  displayName: Acceptance test provider',
			'executionProviders:',
			'  - id: codex',
			'    adapter: codex',
			...(sourcePolicy ? [
				'    researchSourcePolicy:',
				'      schemaVersion: 1',
				'      allowedDomains: [example.com, iana.org]',
				'      requestTimeoutMs: 20000',
				'      maxResponseBytes: 1000000',
				'      maxRedirects: 3',
				'      allowedContentTypes: [text/html, text/plain]',
			] : []),
			'    nativeLimits: { maxConcurrentRunners: 4, availableAgentSeconds: 3600 }',
			'    capabilities: [engineering, research]',
			'connections: []',
		].join('\n'));
		return root;
	}

	it('preserves the canonical research source policy in the isolated acceptance provider', async () => {
		const cwd = await manifest();
		const provider = await resolveLiveAcceptanceExecutionProvider({
			cwd,
			env: {},
			executionProviderId: 'codex',
			capabilities: ['planning', 'research'],
		});

		expect(provider.researchSourcePolicy).toMatchObject({
			allowedDomains: ['example.com', 'iana.org'],
			requestTimeoutMs: 20000,
		});
		expect(provider.nativeLimits).toEqual({ maxConcurrentRunners: 1, availableAgentSeconds: 3_600 });
		expect(provider.capabilities).toEqual(['planning', 'research']);
	});

	it('fails closed when a research acceptance provider has no source policy', async () => {
		const cwd = await manifest(false);
		await expect(resolveLiveAcceptanceExecutionProvider({
			cwd,
			env: {},
			executionProviderId: 'codex',
			capabilities: ['research'],
		})).rejects.toThrow('requires researchSourcePolicy');
	});

	it('bounds the isolated provider to the explicitly requested two-runner concurrency', async () => {
		const cwd = await manifest();
		const provider = await resolveLiveAcceptanceExecutionProvider({
			cwd, env: {}, executionProviderId: 'codex', capabilities: ['planning'], maxConcurrentRunners: 2,
		});
		expect(provider.nativeLimits).toEqual({ maxConcurrentRunners: 2, availableAgentSeconds: 3_600 });
	});

	it('retries the production manager cycle until delayed demand becomes dispatchable', async () => {
		let calls = 0;
		const result = await waitForAcceptanceDispatches({
			expectedAssignmentIds: ['assignment-delayed'],
			expectedDispatchCount: 1,
			attempts: 3,
			intervalMs: 0,
			runManager: async () => {
				calls += 1;
				return {
					ok: true,
					role: 'manager',
					mode: 'multi-team',
					connections: [],
					scheduler: {},
					dispatches: calls === 1
						? [{ connectionId: 'acceptance', assigned: 0 }]
						: [{ connectionId: 'acceptance', assignmentId: 'assignment-delayed', status: 'ready' }],
				};
			},
		});
		expect(calls).toBe(2);
		expect(result.dispatches).toEqual([
			{ connectionId: 'acceptance', assigned: 0 },
			{ connectionId: 'acceptance', assignmentId: 'assignment-delayed', status: 'ready' },
		]);
	});

	it('uses a refresh-only heartbeat instead of leaving a background manager free to pre-lease the next assignment', async () => {
		const source = await readFile(new URL('../../../src/provider-acceptance.ts', import.meta.url), 'utf8');
		expect(source).not.toContain('setInterval(');
		expect(source).not.toContain('managerRefresh');
		expect(source).toContain('heartbeatOnly: true');
	});

	it('keeps availability fresh during execution and stops heartbeats before returning', async () => {
		let heartbeats = 0;
		const result = await runWithAcceptanceAvailabilityHeartbeat({
			intervalMs: 2,
			heartbeat: async () => { heartbeats += 1; },
			operation: async () => {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 12));
				return 'completed';
			},
		});
		const stoppedAt = heartbeats;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 8));
		expect(result).toBe('completed');
		expect(stoppedAt).toBeGreaterThan(0);
		expect(heartbeats).toBe(stoppedAt);
	});

	it('recovers only claims orphaned by prior isolated acceptance connections', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-provider-acceptance-claims-'));
		roots.push(root);
		const store = new ProviderLocalCapacityStore(root);
		const stale = await store.claim({ connectionId: 'acceptance-prior-run', globalLimit: 3, connectionLimit: 1 });
		const active = await store.claim({ connectionId: 'acceptance-current-run', globalLimit: 3, connectionLimit: 1 });
		const durable = await store.claim({ connectionId: 'primary-team', globalLimit: 3, connectionLimit: 1 });
		expect(await recoverOrphanedAcceptanceClaims(store, ['acceptance-current-run'])).toEqual([stale?.id]);
		expect((await store.snapshot()).claims.map((claim) => claim.id).sort()).toEqual([active?.id, durable?.id].sort());
	});

	it('retains a claim from another executor in the same live run family', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-provider-acceptance-family-'));
		roots.push(root);
		const store = new ProviderLocalCapacityStore(root);
		const sameRun = await store.claim({ connectionId: 'acceptance-20260722020032-engineering-graph-6', globalLimit: 2, connectionLimit: 1 });
		const priorRun = await store.claim({ connectionId: 'acceptance-20260721231723-engineering-graph-6', globalLimit: 2, connectionLimit: 1 });
		expect(await recoverOrphanedAcceptanceClaims(store, ['acceptance-20260722020032-engineering-graph-7'])).toEqual([priorRun?.id]);
		expect((await store.snapshot()).claims.map((claim) => claim.id)).toEqual([sameRun?.id]);
	});
});
