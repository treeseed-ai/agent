import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as preparation from '../../../../acceptance/prepare-campaign.ts';
import { nativeExternalFixture } from './external-native-fixture.ts';

afterEach(() => vi.unstubAllEnvs());
const { captureSdkExternalState, verifySdkExternalState } = preparation;

it('native Git GitHub registry and mutual TLS manager reads retain every seed-owned external boundary and original failures before exact retry', async () => {
	const f = await nativeExternalFixture(); let originalFailure: unknown;
	try {
		for (const [key, value] of Object.entries(f.environment)) vi.stubEnv(key, value);
		const receipts: Record<string, string> = {}, captures = new Map<string, string>();
		await captureSdkExternalState(f.root, (name, bytes) => { const path = join(f.root, name); writeFileSync(path, bytes); receipts[path] = f.archiveDigest(path); captures.set(name, bytes); });
		expect(captures.size).toBe(172); expect(captures.has('sdk-dist-tags.json')).toBe(false);
		for (const repository of f.repositories) {
			const refs = captures.get(encodeURIComponent(repository.key) + '-remote-refs.txt')!; expect(refs).toContain(f.base + '\trefs/heads/staging'); expect(refs).toContain(f.base + '\trefs/tags/original');
			for (const kind of ['releases', 'issues', 'pull-requests', 'deployments']) expect(JSON.parse(captures.get(encodeURIComponent(repository.key) + '-' + kind + '.json')!)).toHaveLength(2);
		}
		const freeze = { receipts }, frozen = structuredClone({ receipts, captures }); await verifySdkExternalState(freeze);
		const failures: Array<{ mode: string; message: string }> = [];
		for (const fault of ['denied', 'malformed', 'duplicate', 'interrupted']) {
			await f.control({ fault }); let message = ''; try { await verifySdkExternalState(freeze); } catch (error) { message = error instanceof Error ? error.message : String(error); }
			failures.push({ mode: fault, message }); expect(message, fault).not.toBe(''); expect({ receipts, captures }).toEqual(frozen);
		}
		await f.control({ fault: '' });
		const repository = f.repositories[0]!, path = join(f.root, 'repositories', repository.key);
		f.git(['-C', path, 'update-ref', 'refs/heads/staging', f.advanced]); f.git(['-C', path, 'update-server-info']);
		await expect(async () => verifySdkExternalState(freeze)).rejects.toThrow('ACCEPTANCE_EXTERNAL_CHANGED');
		failures.push({ mode: 'native-upstream-ref', message: readFileSync(join(path, 'info/refs'), 'utf8') });
		f.git(['-C', path, 'update-ref', 'refs/heads/staging', f.base]); f.git(['-C', path, 'update-server-info']);
		const originalFailures = structuredClone(failures); await verifySdkExternalState(freeze); expect(failures).toEqual(originalFailures);
		const reader: unknown = Reflect.get(preparation, 'readCampaignDevelopmentSelections'); expect(reader).toBeTypeOf('function');
		if (typeof reader !== 'function') throw new Error('Original owning manager selection reader missing');
		const readSelection = (): string => { const value: unknown = reader(); if (typeof value !== 'string') throw new Error('Original native selection bytes missing'); return value; };
		const originalSelection = readSelection();
		await f.control({ mode: 'released' }); const changed = readSelection(); expect(changed).not.toBe(originalSelection);
		failures.push({ mode: 'native-manager-selection', message: changed }); const retained = structuredClone(failures);
		await f.control({ mode: 'live' });
		// Native setMode followed by markReady advances the restored generation;
		// retain that changed owning history rather than fabricate an identical reset.
		expect(readSelection()).not.toBe(originalSelection);
		const snapshot = await f.control({ snapshot: true }); expect(Array.isArray(snapshot.requests)).toBe(true);
		expect(failures).toEqual(retained); expect({ receipts, captures }).toEqual(frozen); expect(failures).toHaveLength(6);
		// Controlled upstream records/native owner configuration; no current
		// governed portfolio, model execution or managed passing receipt is claimed.
	} catch (error) { originalFailure = error; throw error; }
	finally { try { await f.close(); } catch (cleanup) { throw originalFailure ? new AggregateError([originalFailure, cleanup], 'Native observation and scoped cleanup failed') : cleanup; } }
}, 30_000);
