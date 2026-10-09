import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { ProviderConnectionRuntime } from '../../../../src/provider/coordination/coordinator.ts';
import type { ProviderHostRuntimeConfig } from '../../../../src/provider/configuration/config.ts';
import { recoverProviderLocalLeases } from '../../../../src/provider/coordination/lease-recovery.ts';
import { capacityFixture } from './capacity-fixture.ts';
import { publishProviderAvailability } from '../../../../src/provider/lifecycle/lifecycle.ts';

async function recoveryFixture() {
	const f = await capacityFixture();
	const requests: Array<{ method: string; path: string; body: unknown }> = [];
	let observed: unknown = { id: f.attempt.id, teamId: f.attempt.teamId, capacityProviderId: f.attempt.provider.providerId,
		status: 'running', assignmentAttempt: { ...f.attempt, status: 'running' } };
	let code = 200, fault = '', returnCode = 200, returnReply: unknown = { assignment: { id: f.attempt.id, status: 'returned' } };
	let availability: { status: number; code: string } | null = null;
	const server = createServer((request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
		request.on('end', () => {
			const path = new URL(request.url ?? '', 'http://127.0.0.1').pathname;
			requests.push({ method: request.method ?? '', path, body: body ? JSON.parse(body) : null });
			if (fault === 'reset') { request.socket.destroy(); return; }
			if (availability && path.startsWith('/v1/provider/availability-sessions')) {
				const status = request.method === 'POST' && availability.status === 409 && availability.code === 'provider_availability_refresh_conflict' ? 200 : availability.status;
				response.statusCode = status; response.setHeader('content-type', 'application/json');
				response.end(fault === 'json' ? '{' : JSON.stringify(status === 200
					? { data: { id: 'native-session', sequence: request.method === 'POST' ? 1 : 2, status: 'open' } }
					: { type: 'about:blank', title: 'Original publication failure', status: availability.status, code: availability.code })); return;
			}
			const returning = path.endsWith('/return'), status = returning ? returnCode : code;
			response.statusCode = status; response.setHeader('content-type', 'application/json');
			if (fault === 'json') response.end('{');
			else if (status !== 200) response.end(JSON.stringify({ type: 'about:blank', title: 'Controlled denial', status, code: 'fixture_denied' }));
			else response.end(JSON.stringify({ data: returning ? returnReply : observed }));
		});
	});
	try {
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Exact native recovery endpoint required');
		const url = `http://127.0.0.1:${address.port}`, token = 'isolated-recovery-token';
		const connection: ProviderConnectionRuntime = { connection: { id: 'team-a', teamId: f.attempt.teamId,
			providerId: f.attempt.provider.providerId, membershipId: 'membership-a', membershipCredentialId: 'credential-a',
			membershipCredentialRef: 'memory://fixture', offer: { capabilities: [f.attempt.provider.executionCapabilityId], maxConcurrentRunners: 1 } },
			controlPlaneUrl: url, controlPlaneAudience: url, teamId: f.attempt.teamId, providerId: f.attempt.provider.providerId,
			membershipId: 'membership-a', credentialId: 'credential-a', accessTokenProvider: async () => token,
			accessToken: { id: 'token-a', membershipId: 'membership-a', credentialId: 'credential-a', teamId: f.attempt.teamId,
				providerId: f.attempt.provider.providerId, status: 'active', scopes: [], identityVersion: 1, accessToken: token,
				issuedAt: f.attempt.createdAt, expiresAt: f.attempt.deadline } };
		const config: ProviderHostRuntimeConfig = { dataDir: f.directory, manifestPath: null, environment: 'local',
			maxConcurrentRunners: 1, maxConcurrentWorkdays: 1, budgetFile: null, dailyAgentSecondsLimit: null,
			monthlyAgentSecondsLimit: null, env: {}, redactedEnv: {} };
		const claim = await f.store.claim({ connectionId: connection.connection.id, globalLimit: 1, connectionLimit: 1 });
		if (!claim) throw new Error('Actual native recovery slot required');
		const lease = f.lease(); await f.store.attachLease(claim.id, lease); await f.store.claimDispatch(claim.id);
		observed = { id: f.attempt.id, teamId: f.attempt.teamId, capacityProviderId: f.attempt.provider.providerId,
			status: 'running', assignmentAttempt: { ...lease.dispatchEnvelope.assignment.assignmentAttempt, status: 'running' } };
		await f.store.recordCloseoutOutput(claim.id, { status: 'blocked', unfinishedWork: ['unchanged original assignment'] });
		await f.store.recordFailure(claim.id, 'original interrupted provider execution');
		return { ...f, claim, lease, connection, requests,
			setAvailability(status: number, problemCode = 'isolated_denial', error = '') { availability = { status, code: problemCode }; fault = error; },
			publish: () => publishProviderAvailability({ ...config, connectionId: connection.connection.id, controlPlaneUrl: url,
				controlPlaneAudience: url, teamId: connection.teamId, providerId: connection.providerId, membershipId: connection.membershipId,
				accessToken: token, adapters: [], lanes: [], providerCapacity: { maxConcurrentWorkers: 1 } },
				{ adapters: [], lanes: [], capacity: { maxConcurrentWorkers: 1 }, activeWorkers: 1 }, f.reopen()),
			setReturnReply(value: unknown) { returnReply = value; },
			setReply(value: unknown, status = 200, error = '', returnedStatus = 200) { observed = value; code = status; fault = error; returnCode = returnedStatus; },
			run: (connections = [connection]) => recoverProviderLocalLeases({ config, connections, store: f.reopen() }),
			close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); } };
	} catch (error) { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); throw error; }
}

// Owning recovery + official public SDK client + controlled native HTTP +
// real durable local files. Upstream JSON and principal/token are INPUTS,
// NOT native API settlement, independent authentication or remote cleanup.
describe('document-wide native provider recovery boundary', () => {
	it('native terminal recovery retains original failed custody across repeated API-generated unmeasured performance observations', async () => {
		const outcomes = [];
		for (const status of ['failed', 'cancelled', 'expired']) {
			const f = await recoveryFixture(); try {
				const prior = (await f.reopen().claimsForRecovery())[0]!, frozen = f.lease.dispatchEnvelope.assignment.assignmentAttempt;
				const accounting = await f.reopen().activeTimeObservation(frozen.provider.modelConfigurationId, [frozen.provider.executionCapabilityId]);
				const value = { id: frozen.id, teamId: frozen.teamId, capacityProviderId: frozen.provider.providerId, status,
					assignmentAttempt: { ...frozen, status, finishedAt: frozen.deadline }, lifecycleOutput: { performance: {
						actual: { activeSeconds: 0, elapsedSeconds: 0 }, systemAssessment: { generatedBy: 'api-recovery' } } } };
				const held = structuredClone(value); f.setReply(value);
				for (let read = 0; read < 2; read++) {
					outcomes.push((await f.run())[0]?.status);
					const claim = (await f.reopen().claimsForRecovery())[0];
					expect(claim).toEqual({ ...prior, updatedAt: claim?.updatedAt });
				}
				const after = await f.reopen().activeTimeObservation(frozen.provider.modelConfigurationId, [frozen.provider.executionCapabilityId]);
				expect(after.modelUsage).toEqual(accounting.modelUsage); expect(after.capabilityUsage).toEqual(accounting.capabilityUsage);
				expect(f.requests).toEqual(Array.from({ length: 2 }, () => ({ method: 'GET', path: `/v1/provider/assignments/${frozen.id}`, body: null })));
				expect(value).toEqual(held); expect(await f.entries()).toEqual(['capacity-state.json']);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(Array.from({ length: 6 }, () => 'retained'));
	});
	it('native recovery consumes the public capacityProviderId through the original client and retains foreign or legacy-only authority without replacing failed custody', async () => {
		const variants = ['valid', 'valid-with-foreign-alias', 'missing', 'empty', 'null', 'foreign', 'legacy-only', 'foreign-canonical'] as const;
		const outcomes: Array<{ variant: string; status: unknown; claimStatus: string }> = [];
		for (const variant of variants) {
			const f = await recoveryFixture(); try {
				const prior = (await f.reopen().claimsForRecovery())[0]!, frozen = f.lease.dispatchEnvelope.assignment.assignmentAttempt;
				const value: Record<string, unknown> = { id: frozen.id, teamId: frozen.teamId, capacityProviderId: frozen.provider.providerId,
					status: 'expired', stateVersion: 7, metadata: { leaseRecovery: { disposition: 'operator-action' } },
					assignmentAttempt: { ...frozen, status: 'expired', finishedAt: frozen.deadline },
					unresolvedUsageRecovery: { assignmentId: frozen.id, reservationId: frozen.reservationId, usageStatus: 'unresolved',
						settled: false, expectedStateVersion: 7, actorId: 'operator', reason: 'Original active clock absent', recoveredAt: frozen.deadline } };
				if (variant === 'valid-with-foreign-alias') value.providerId = 'non-authoritative-foreign-alias';
				if (variant === 'missing' || variant === 'legacy-only') delete value.capacityProviderId;
				if (variant === 'empty') value.capacityProviderId = '';
				if (variant === 'null') value.capacityProviderId = null;
				if (variant === 'foreign') value.capacityProviderId = 'foreign-provider';
				if (variant === 'legacy-only' || variant === 'foreign' || variant === 'empty' || variant === 'null') value.providerId = frozen.provider.providerId;
				if (variant === 'foreign-canonical') value.assignmentAttempt = { ...frozen, status: 'expired', finishedAt: frozen.deadline,
					provider: { ...frozen.provider, providerId: 'foreign-canonical-provider' } };
				const before = structuredClone(value), accounting = await f.reopen().activeTimeObservation(frozen.provider.modelConfigurationId, [frozen.provider.executionCapabilityId]);
				f.setReply(value); const result = await f.run();
				const state: { claims: Array<typeof prior> } = JSON.parse(await f.bytes()); expect(state.claims).toHaveLength(1);
				const held = state.claims[0]!; outcomes.push({ variant, status: result[0]?.status, claimStatus: held.status });
				expect(held).toEqual({ ...prior, status: held.status, updatedAt: held.updatedAt });
				const after = await f.reopen().activeTimeObservation(frozen.provider.modelConfigurationId, [frozen.provider.executionCapabilityId]);
				expect(after.modelUsage).toEqual(accounting.modelUsage); expect(after.capabilityUsage).toEqual(accounting.capabilityUsage);
				expect(f.requests).toEqual([{ method: 'GET', path: `/v1/provider/assignments/${frozen.id}`, body: null }]);
				expect(value).toEqual(before); expect(await f.entries()).toEqual(['capacity-state.json']);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(variants.map(variant => ({ variant,
			status: variant.startsWith('valid') ? 'released' : 'retained', claimStatus: variant.startsWith('valid') ? 'unresolved' : 'recovery' })));
	});
	it('native operator-held terminal recovery retains missing denied or malformed audit authority without returning or deleting failed custody', async () => {
		for (const recovery of [undefined, null, {}, { usageStatus: 'unresolved', settled: true }]) {
			const f = await recoveryFixture(); try {
				const prior = (await f.reopen().claimsForRecovery())[0]!;
				f.setReply({ id: f.attempt.id, teamId: f.attempt.teamId, capacityProviderId: f.attempt.provider.providerId,
					status: 'expired', stateVersion: 7, metadata: { leaseRecovery: { disposition: 'operator-action' } },
					assignmentAttempt: f.lease.dispatchEnvelope.assignment.assignmentAttempt, unresolvedUsageRecovery: recovery });
				expect((await f.run())[0]).toMatchObject({ status: 'retained' });
				const held = (await f.reopen().claimsForRecovery())[0]!;
				expect(held).toEqual({ ...prior, updatedAt: held.updatedAt });
				expect(await f.reopen().claim({ connectionId: f.connection.connection.id, globalLimit: 1, connectionLimit: 1 })).toBeNull();
				expect(f.requests).toHaveLength(1); expect(f.requests[0]?.method).toBe('GET');
			} finally { await f.close(); }
		}
	});
	it('native unresolved operator recovery frees only concurrency while preserving exact failed output and unknown period reservation across reopened stores', async () => {
		const f = await recoveryFixture(); try {
			const prior = (await f.reopen().claimsForRecovery())[0]!;
			const frozen = f.lease.dispatchEnvelope.assignment.assignmentAttempt;
			const accounting = await f.reopen().activeTimeObservation(frozen.provider.modelConfigurationId, [frozen.provider.executionCapabilityId]);
			const value = { id: frozen.id, teamId: frozen.teamId, capacityProviderId: frozen.provider.providerId,
				status: 'expired', stateVersion: 7, assignmentAttempt: { ...frozen, status: 'expired', finishedAt: frozen.deadline },
				unresolvedUsageRecovery: { assignmentId: frozen.id, reservationId: frozen.reservationId, usageStatus: 'unresolved',
					settled: false, expectedStateVersion: 7, actorId: 'operator', reason: 'Active measurement unavailable', recoveredAt: frozen.deadline } };
			const before = structuredClone(value); f.setReply(value);
			expect((await f.run())[0]).toMatchObject({ status: 'released', usageStatus: 'unresolved', settled: false });
			expect(await f.run()).toEqual([]); expect(f.requests).toHaveLength(1); expect(f.requests[0]?.method).toBe('GET');
			const state: { claims: Array<typeof prior>; events: Array<{ outcome: string }> } = JSON.parse(await f.bytes());
			expect(state.claims).toHaveLength(1);
			expect(state.claims[0]).toEqual({ ...prior, status: 'unresolved', updatedAt: state.claims[0]!.updatedAt });
			expect(state.events.filter(event => event.outcome === 'operator-usage-unresolved')).toHaveLength(1);
			const after = await f.reopen().activeTimeObservation(frozen.provider.modelConfigurationId, [frozen.provider.executionCapabilityId]);
			expect(after.modelUsage).toEqual(accounting.modelUsage); expect(after.capabilityUsage).toEqual(accounting.capabilityUsage);
			const slot = await f.reopen().claim({ connectionId: f.connection.connection.id, globalLimit: 1, connectionLimit: 1 });
			expect(slot).not.toBeNull();
			const lease = f.lease;
			await expect(f.reopen().attachLease(slot!.id, { ...lease, accounting: { ...lease.accounting,
				dailyActiveSecondsLimit: prior.requestedSeconds!, capabilityDailyActiveSecondsLimit: prior.requestedSeconds! } }))
				.rejects.toThrow('daily active-time capacity');
			expect(value).toEqual(before); expect(await f.entries()).toEqual(['capacity-state.json']);
		} finally { await f.close(); }
	});
	it('native denied unavailable malformed and disconnected availability refresh retains the original session and failed assignment for exact retry instead of creating replacement authority', async () => {
		const outcomes = [];
		for (const failure of [{ status: 401 }, { status: 403 }, { status: 503 }, { status: 400 },
			{ status: 409 }, { status: 200, fault: 'reset' }, { status: 200, fault: 'json' }]) {
			const f = await recoveryFixture();
			try {
				f.setAvailability(200); await f.publish(); const key = `${f.connection.connection.id}|${f.connection.teamId}|${f.connection.providerId}`;
				const prior = await f.reopen().session(key), claims = await f.reopen().claimsForRecovery();
				f.setAvailability(failure.status, 'isolated_denial', failure.fault ?? ''); let cause: unknown;
				try { await f.publish(); } catch (error) { cause = error; }
				const retained = await f.reopen().session(key), attempted = f.requests.slice(1);
				outcomes.push({ failed: cause instanceof Error, retained: retained?.id === prior?.id && retained?.sequence === prior?.sequence,
					methods: attempted.map(value => value.method) });
				expect(await f.reopen().claimsForRecovery()).toEqual(claims);
				f.setAvailability(200); await f.publish();
				const retry = f.requests.at(-1)!; expect(retry.method).toBe('PUT'); expect(retry.body).toEqual(attempted[0]?.body);
				expect((await f.reopen().session(key))?.sequence).toBe(2);
				expect(await f.reopen().claimsForRecovery()).toEqual(claims);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(Array.from({ length: 7 }, () => ({ failed: true, retained: true, methods: ['PUT'] })));
		const f = await recoveryFixture();
		try {
			f.setAvailability(200); await f.publish(); const claims = await f.reopen().claimsForRecovery();
			f.setAvailability(409, 'provider_availability_refresh_conflict'); await f.publish();
			expect(f.requests.map(value => value.method)).toEqual(['POST', 'PUT', 'POST']);
			expect(f.requests[1]?.body).toMatchObject({ expectedSequence: 1 });
			const { expectedSequence: _sequence, ...input } = Object.fromEntries(Object.entries(f.requests[1]!.body ?? {}));
			expect(f.requests[2]?.body).toEqual(input);
			expect(await f.reopen().claimsForRecovery()).toEqual(claims);
		} finally { await f.close(); }
	});
	it('native recovery retains exact failed lease and output after malformed successful return receipts and releases only the unchanged confirmed retry', async () => {
		for (const reply of [null, {}, { assignment: {} }, { assignment: { id: 'foreign', status: 'returned' } },
			{ assignment: { id: 'assignment-1', status: 'running' } }]) {
			const f = await recoveryFixture();
			try {
				const prior = (await f.reopen().claimsForRecovery())[0]!, before = structuredClone(reply);
				f.setReturnReply(reply); expect((await f.run())[0]?.status).toBe('retained');
				const retained = (await f.reopen().claimsForRecovery())[0]!;
				expect(retained.dispatchEnvelope).toEqual(prior.dispatchEnvelope); expect(retained.closeoutOutput).toEqual(prior.closeoutOutput);
				expect(retained.leaseToken).toBe(prior.leaseToken); expect(retained.failureMessage).toBe(prior.failureMessage);
				expect(reply).toEqual(before); expect((await f.reopen().snapshot()).events.some(event => event.outcome === 'restart-return-confirmed')).toBe(false);
				f.setReturnReply({ assignment: { id: f.attempt.id, status: 'returned' } }); expect((await f.run())[0]?.status).toBe('released');
				expect(await f.reopen().claimsForRecovery()).toEqual([]); expect(await f.run()).toEqual([]);
				const requests = f.requests.filter(item => item.method === 'POST'); expect(requests).toHaveLength(2);
				expect(requests[1]).toEqual(requests[0]); expect((await f.reopen().snapshot()).events.filter(event => event.outcome === 'restart-return-confirmed')).toHaveLength(1);
			} finally { await f.close(); }
		}
	});
	it('retains missing malformed unknown foreign and stale terminal readback rather than releasing original lease authority', async () => {
		const mutations = [{}, { id: 'foreign', status: 'completed' }, { id: 'assignment-1', status: 'unknown' },
			{ id: 'assignment-1', status: 'completed', teamId: 'foreign-team' },
			{ id: 'assignment-1', status: 'completed', assignmentAttempt: { attempt: 2 } }];
		const outcomes = [];
		for (const mutation of mutations) {
			const f = await recoveryFixture();
			try {
				f.setReply(mutation); const result = await f.run(); const held = await f.reopen().claimsForRecovery();
				outcomes.push({ retained: held.length === 1, disposition: result[0]?.status,
					original: held[0]?.leaseToken === f.lease.leaseToken, returned: f.requests.some(item => item.method === 'POST') });
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(mutations.map(() => ({ retained: true, disposition: 'retained', original: true, returned: false })));
		const f = await recoveryFixture(); try {
			const frozen = f.lease.dispatchEnvelope.assignment.assignmentAttempt;
			f.setReply({ id: frozen.id, teamId: frozen.teamId, capacityProviderId: frozen.provider.providerId,
				status: 'running', assignmentAttempt: { ...frozen, status: 'running', finishedAt: frozen.deadline } });
			expect((await f.run())[0]?.status).toBe('retained');
			expect(await f.reopen().claimsForRecovery()).toHaveLength(1);
			expect(f.requests).toHaveLength(1); expect(f.requests[0]?.method).toBe('GET');
			f.setReply({ id: frozen.id, teamId: frozen.teamId, capacityProviderId: frozen.provider.providerId,
				status: 'completed', assignmentAttempt: { ...frozen, status: 'running', finishedAt: frozen.deadline } });
			expect((await f.run())[0]?.status).toBe('retained');
			expect(await f.reopen().claimsForRecovery()).toHaveLength(1);
			expect(f.requests).toHaveLength(2); expect(f.requests[1]?.method).toBe('GET');
		} finally { await f.close(); }
	});
	it('retains custody on denied unavailable reset malformed and rejected return transports then retries the original output without duplicate return', async () => {
		const outcomes = [];
		for (const failure of [{ status: 403, fault: '', returned: 200 }, { status: 503, fault: '', returned: 200 },
			{ status: 200, fault: 'reset', returned: 200 }, { status: 200, fault: 'json', returned: 200 }, { status: 200, fault: '', returned: 403 }]) {
			const f = await recoveryFixture();
			try {
				const current = { id: f.attempt.id, teamId: f.attempt.teamId, capacityProviderId: f.attempt.provider.providerId,
					status: 'running', assignmentAttempt: { ...f.lease.dispatchEnvelope.assignment.assignmentAttempt, status: 'running' } };
				f.setReply(current, failure.status, failure.fault, failure.returned);
				const failed = await f.run(), held = (await f.reopen().claimsForRecovery())[0];
				outcomes.push({ retained: failed[0]?.status === 'retained' && held?.leaseToken === f.lease.leaseToken,
					output: held?.closeoutOutput, cause: held?.failureMessage });
				const priorReturns = f.requests.filter(item => item.method === 'POST').length;
				f.setReply(current); expect((await f.run())[0]?.status).toBe('released');
				expect(await f.reopen().claimsForRecovery()).toEqual([]); expect(await f.run()).toEqual([]);
				const returns = f.requests.filter(item => item.method === 'POST'); expect(returns).toHaveLength(priorReturns + 1);
				expect(returns.at(-1)?.body).toMatchObject({ leaseToken: f.lease.leaseToken, runnerId: f.claim.runnerId,
					output: { status: 'blocked', unfinishedWork: ['unchanged original assignment'] } });
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(Array.from({ length: 5 }, () => ({ retained: true,
			output: { status: 'blocked', unfinishedWork: ['unchanged original assignment'] }, cause: 'original interrupted provider execution' })));
	});
	it('never borrows another team connection or reads remote assignment authority when the exact owning connection is unavailable', async () => {
		const f = await recoveryFixture();
		try {
			const original = await f.reopen().claimsForRecovery();
			const result = await f.run([{ ...f.connection, connection: { ...f.connection.connection, id: 'foreign-connection' }, teamId: 'foreign-team' }]);
			expect(result[0]).toMatchObject({ status: 'retained', reason: 'lease_authority_unavailable' });
			expect(f.requests).toEqual([]);
			const held = (await f.reopen().claimsForRecovery())[0]; expect(held?.dispatchEnvelope).toEqual(original[0]?.dispatchEnvelope);
			expect(held?.failureMessage).toBe('original interrupted provider execution');
			expect(held?.leaseToken).toBe(f.lease.leaseToken);
		} finally { await f.close(); }
	});
	it('releases an exact confirmed terminal observation once without a new productive turn or replacing historical executor attribution', async () => {
		const f = await recoveryFixture();
		try {
			f.setReply({ id: f.attempt.id, teamId: f.attempt.teamId, capacityProviderId: f.attempt.provider.providerId,
				status: 'completed', runnerId: f.claim.runnerId, assignmentAttempt: {
					...f.lease.dispatchEnvelope.assignment.assignmentAttempt, status: 'completed', finishedAt: f.attempt.deadline } });
			expect((await f.run())[0]).toMatchObject({ status: 'released', observedStatus: 'completed' });
			expect(await f.run()).toEqual([]); expect(f.requests).toHaveLength(1); expect(f.requests[0]?.method).toBe('GET');
			expect((await f.reopen().snapshot()).events.filter(item => item.outcome === 'authoritative-completed')).toHaveLength(1);
			expect(await f.entries()).toEqual(['capacity-state.json']);
		} finally { await f.close(); }
	});
});
