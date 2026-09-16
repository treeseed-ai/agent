import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ProviderAccessTokenIssue } from '@treeseed/sdk/capacity-provider/contracts';
import type { ProviderLocalNativeLimit } from './native-capacity-limits.ts';

export interface ProviderLocalSlotClaim {
	id: string;
	connectionId: string;
	runnerId: string;
	status: 'polling' | 'ready' | 'running' | 'recovery';
	assignmentId?: string;
	leaseToken?: string;
	leaseExpiresAt?: string;
	executionProviderId?: string;
	laneId?: string;
	requestedSeconds?: number;
	capabilityId?: string;
	modelConfigurationId?: string;
	activeStartedAt?: string;
	activeFinishedAt?: string;
	accountedThrough?: string;
	nativeUnit?: string;
	requestedNativeAmount?: number;
	dispatchEnvelope?: unknown;
	/** First runtime failure, retained across recovery attempts without replacing its cause. */
	failureMessage?: string;
	acquiredAt: string;
	updatedAt: string;
	expiresAt: string;
}

interface ProviderLocalCapacityState {
	schemaVersion: 1;
	revision: number;
	claims: ProviderLocalSlotClaim[];
	/** Settled active time only; outstanding claims retain their unconsumed reservation. */
	usage: Record<string, Record<string, number>>;
	sessions: Array<{ connectionId: string; id: string; sequence: number; updatedAt: string }>;
	tokens: Array<{ connectionId: string; token: ProviderAccessTokenIssue; updatedAt: string }>;
	connections: Array<{ connectionId: string; schedulable: boolean; reason?: string; updatedAt: string }>;
	events: Array<{ id: string; claimId: string; connectionId: string; assignmentId?: string; outcome: string; message?: string; recordedAt: string }>;
	updatedAt: string;
}

const emptyState = (): ProviderLocalCapacityState => ({ schemaVersion: 1, revision: 0, claims: [], usage: {}, sessions: [], tokens: [], connections: [], events: [], updatedAt: new Date(0).toISOString() });

function accountActiveTime(state: ProviderLocalCapacityState, claim: ProviderLocalSlotClaim, now: string) {
	if (!claim.activeStartedAt || !claim.modelConfigurationId || !claim.capabilityId) return;
	let cursor = Date.parse(claim.accountedThrough ?? claim.activeStartedAt);
	const end = Date.parse(claim.activeFinishedAt ?? now);
	while (cursor < end) {
		const day = new Date(cursor).toISOString().slice(0, 10);
		const next = Math.min(end, Date.parse(`${day}T00:00:00.000Z`) + 86_400_000);
		const usage = state.usage[day] ??= {};
		for (const key of [JSON.stringify([claim.modelConfigurationId]), JSON.stringify([claim.modelConfigurationId, claim.capabilityId])]) {
			usage[key] = (usage[key] ?? 0) + (next - cursor) / 1000;
		}
		cursor = next;
	}
	claim.accountedThrough = new Date(Math.max(cursor, Date.parse(claim.activeStartedAt))).toISOString();
}

function delay(milliseconds: number) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export class ProviderLocalCapacityStore {
	private readonly path: string;
	private readonly lockPath: string;

	constructor(dataDirectory: string) {
		this.path = resolve(dataDirectory, 'runtime', 'capacity-state.json');
		this.lockPath = `${this.path}.lock`;
	}

	private async read(): Promise<ProviderLocalCapacityState> {
		try {
			const parsed = JSON.parse(await readFile(this.path, 'utf8')) as ProviderLocalCapacityState;
			if (parsed.schemaVersion !== 1 || !Number.isInteger(parsed.revision) || !Array.isArray(parsed.claims)) throw new Error('Provider-local capacity state is invalid.');
			parsed.sessions ??= [];
			parsed.tokens ??= [];
			parsed.events ??= [];
			parsed.connections ??= [];
			parsed.usage ??= {};
			if (!parsed.usage || typeof parsed.usage !== 'object' || Array.isArray(parsed.usage)
				|| Object.values(parsed.usage).some(day => !day || typeof day !== 'object'
					|| Object.values(day).some(amount => !Number.isFinite(amount) || amount < 0))) throw new Error('Provider-local active-time accounting is invalid.');
			if (!Array.isArray(parsed.sessions)) throw new Error('Provider-local availability-session state is invalid.');
			if (!Array.isArray(parsed.tokens)) throw new Error('Provider-local access-token state is invalid.');
			if (!Array.isArray(parsed.events)) throw new Error('Provider-local lifecycle evidence is invalid.');
			if (!Array.isArray(parsed.connections)) throw new Error('Provider-local connection status is invalid.');
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
			throw error;
		}
	}

	private async lock() {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		for (let attempt = 0; attempt < 250; attempt += 1) {
			try {
				await mkdir(this.lockPath, { mode: 0o700 });
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
				const age = await stat(this.lockPath).then((entry) => Date.now() - entry.mtimeMs).catch(() => 0);
				if (age > 30_000) await rm(this.lockPath, { recursive: true, force: true });
				else await delay(20);
			}
		}
		throw new Error('Provider-local capacity state lock timed out.');
	}

	private async update<T>(mutation: (state: ProviderLocalCapacityState, now: string) => T | Promise<T>): Promise<T> {
		await this.lock();
		try {
			const state = await this.read();
			const now = new Date().toISOString();
			for (const claim of state.claims) accountActiveTime(state, claim, now);
			const expired = state.claims.filter((claim) => claim.status !== 'recovery' && Date.parse(claim.expiresAt) <= Date.parse(now));
			const expiredIds = new Set(expired.map((claim) => claim.id));
			state.claims = state.claims.flatMap((claim) => {
				if (!expiredIds.has(claim.id)) return [claim];
				if (claim.status === 'polling') return [];
				return [{ ...claim, status: 'recovery' as const, updatedAt: now }];
			});
			for (const claim of expired) state.events.push({
				id: randomUUID(), claimId: claim.id, connectionId: claim.connectionId,
				...(claim.assignmentId ? { assignmentId: claim.assignmentId } : {}),
				outcome: claim.status === 'polling' ? 'poll-expired' : 'lease-expired-recovery-required', recordedAt: now,
			});
			state.events = state.events.slice(-100);
			const result = await mutation(state, now);
			state.revision += 1;
			state.updatedAt = now;
			const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
			await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			await rename(temporary, this.path);
			return result;
		} finally {
			await rm(this.lockPath, { recursive: true, force: true });
		}
	}

	async claim(input: { connectionId: string; globalLimit: number; connectionLimit: number; pollingTtlMs?: number }): Promise<ProviderLocalSlotClaim | null> {
		return this.update((state, now) => {
			if (state.claims.length >= input.globalLimit || state.claims.filter((claim) => claim.connectionId === input.connectionId).length >= input.connectionLimit) return null;
			const id = randomUUID();
			const claim: ProviderLocalSlotClaim = {
				id, connectionId: input.connectionId, runnerId: `provider-runner-${id}`, status: 'polling', acquiredAt: now, updatedAt: now,
				expiresAt: new Date(Date.parse(now) + (input.pollingTtlMs ?? 60_000)).toISOString(),
			};
			state.claims.push(claim);
			return claim;
		});
	}

	async attachLease(claimId: string, input: {
		assignmentId: string; leaseToken: string; leaseExpiresAt: string; executionProviderId?: string; laneId?: string; requestedSeconds?: number; nativeUnit?: string; requestedNativeAmount?: number;
		dispatchEnvelope: unknown;
		accounting?: { capabilityId: string; modelConfigurationId: string; dailyActiveSecondsLimit: number;
			capabilityDailyActiveSecondsLimit: number; minimumAssignmentSeconds?: number; maximumAssignmentSeconds?: number };
		executionProviderLimit?: ProviderLocalNativeLimit;
		laneLimit?: ProviderLocalNativeLimit;
	}) {
		return this.update((state, now) => {
			const claim = state.claims.find((entry) => entry.id === claimId);
			if (!claim) throw new Error(`Provider-local slot claim ${claimId} expired before lease persistence.`);
			if (claim.status !== 'polling') {
				if (claim.assignmentId === input.assignmentId && claim.leaseToken === input.leaseToken
					&& claim.requestedSeconds === input.requestedSeconds
					&& claim.capabilityId === input.accounting?.capabilityId
					&& claim.modelConfigurationId === input.accounting?.modelConfigurationId) return { ...claim };
				throw new Error('Provider-local lease reservation cannot be replaced or resized.');
			}
			const peers = state.claims.filter((entry) => entry.id !== claimId && entry.status !== 'polling');
			if (input.accounting) {
				const seconds = input.requestedSeconds;
				const bounds = input.accounting;
				if (!bounds.capabilityId || !bounds.modelConfigurationId || !Number.isFinite(seconds) || seconds! <= 0
					|| [bounds.dailyActiveSecondsLimit, bounds.capabilityDailyActiveSecondsLimit].some(value => !Number.isFinite(value) || value < 0)
					|| seconds! < (bounds.minimumAssignmentSeconds ?? 1) || seconds! > (bounds.maximumAssignmentSeconds ?? Infinity)) throw new Error('Provider-local assignment accounting bounds are invalid.');
				const dayUsage = state.usage[now.slice(0, 10)] ?? {};
				for (const [key, cap, capability] of [[JSON.stringify([bounds.modelConfigurationId]), bounds.dailyActiveSecondsLimit, undefined],
					[JSON.stringify([bounds.modelConfigurationId, bounds.capabilityId]), bounds.capabilityDailyActiveSecondsLimit, bounds.capabilityId]] as const) {
					const reserved = peers.filter(peer => peer.modelConfigurationId === bounds.modelConfigurationId
						&& (!capability || peer.capabilityId === capability)).reduce((sum, peer) => sum + Math.max(0,
							(peer.requestedSeconds ?? 0) - (peer.activeStartedAt ? (Date.parse(peer.accountedThrough ?? peer.activeStartedAt) - Date.parse(peer.activeStartedAt)) / 1000 : 0)), 0);
					if ((dayUsage[key] ?? 0) + reserved + seconds! > cap) throw new Error('Provider-local daily active-time capacity is exhausted.');
				}
				Object.assign(claim, { capabilityId: bounds.capabilityId, modelConfigurationId: bounds.modelConfigurationId });
			}
			const assertLimit = (label: string, selected: string | undefined, limit: ProviderLocalNativeLimit | undefined, field: 'executionProviderId' | 'laneId') => {
				if (!selected || !limit) return;
				const selectedPeers = peers.filter((entry) => entry[field] === selected);
				if (limit.maxConcurrentRunners !== undefined && selectedPeers.length >= limit.maxConcurrentRunners) throw new Error(`Provider-local ${label} concurrency is exhausted for ${selected}.`);
				const committed = selectedPeers.reduce((total, entry) => total + (entry.requestedSeconds ?? 0), 0);
				if (limit.availableAgentSeconds !== undefined && committed + (input.requestedSeconds ?? 0) > limit.availableAgentSeconds) throw new Error(`Provider-local ${label} agent-time allowance is exhausted for ${selected}.`);
				if (input.nativeUnit && input.requestedNativeAmount !== undefined && limit.nativeAllowances?.[input.nativeUnit] !== undefined) {
					const nativeCommitted = selectedPeers.filter((entry) => entry.nativeUnit === input.nativeUnit).reduce((total, entry) => total + (entry.requestedNativeAmount ?? 0), 0);
					if (nativeCommitted + input.requestedNativeAmount > limit.nativeAllowances[input.nativeUnit]) throw new Error(`Provider-local ${label} ${input.nativeUnit} allowance is exhausted for ${selected}.`);
				}
			};
			assertLimit('execution-provider', input.executionProviderId, input.executionProviderLimit, 'executionProviderId');
			assertLimit('lane', input.laneId, input.laneLimit, 'laneId');
			const { executionProviderLimit: _executionProviderLimit, laneLimit: _laneLimit, accounting: _accounting, ...lease } = input;
			Object.assign(claim, { status: 'ready' as const, ...lease, updatedAt: now, expiresAt: input.leaseExpiresAt });
			return { ...claim };
		});
	}

	async retainLease(claimId: string, input: { assignmentId: string; leaseToken: string; leaseExpiresAt: string; dispatchEnvelope: unknown }) {
		return this.update((state, now) => {
			const claim = state.claims.find((entry) => entry.id === claimId);
			if (!claim) throw new Error(`Provider-local slot claim ${claimId} expired before rejected lease recovery was persisted.`);
			Object.assign(claim, { ...input, status: 'running' as const, updatedAt: now, expiresAt: input.leaseExpiresAt });
			return { ...claim };
		});
	}

	async renewLease(claimId: string, input: { assignmentId: string; leaseExpiresAt: string }) {
		return this.update((state, now) => {
			const claim = state.claims.find((entry) => entry.id === claimId);
			if (!claim || claim.assignmentId !== input.assignmentId || !['ready', 'running'].includes(claim.status)) {
				throw new Error(`Provider-local slot claim ${claimId} cannot renew assignment ${input.assignmentId}.`);
			}
			claim.leaseExpiresAt = input.leaseExpiresAt;
			claim.expiresAt = input.leaseExpiresAt;
			claim.updatedAt = now;
			return { ...claim };
		});
	}

	async claimDispatch(connectionIds?: string[]) {
		return this.update((state, now) => {
			const eligible = connectionIds ? new Set(connectionIds) : null;
			const claim = state.claims
				.filter((entry) => entry.status === 'ready' && (!eligible || eligible.has(entry.connectionId)))
				.sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt) || left.id.localeCompare(right.id))[0];
			if (!claim) return null;
			claim.status = 'running';
			claim.updatedAt = now;
			return { ...claim };
		});
	}

	async finalize(claimId: string, outcome: string) {
		return this.update((state, now) => {
			const claim = state.claims.find((entry) => entry.id === claimId);
			if (!claim) return false;
			state.events.push({ id: randomUUID(), claimId, connectionId: claim.connectionId, ...(claim.assignmentId ? { assignmentId: claim.assignmentId } : {}), outcome, recordedAt: now });
			state.events = state.events.slice(-100);
			state.claims = state.claims.filter((entry) => entry.id !== claimId);
			return true;
		});
	}

	async beginActiveExecution(claimId: string) {
		return this.update((state, now) => {
			const claim = state.claims.find(entry => entry.id === claimId);
			if (!claim || claim.status !== 'running') throw new Error('Provider-local active execution requires a running lease.');
			claim.activeStartedAt ??= now;
			claim.accountedThrough ??= claim.activeStartedAt;
		});
	}

	async finishActiveExecution(claimId: string) {
		return this.update((state, now) => {
			const claim = state.claims.find(entry => entry.id === claimId);
			if (!claim) throw new Error('Provider-local execution accounting lost its lease.');
			claim.activeFinishedAt ??= now;
		});
	}

	async recordFailure(claimId: string, message: string) {
		return this.update((state, now) => {
			const claim = state.claims.find((entry) => entry.id === claimId);
			if (!claim) return false;
			claim.status = 'recovery';
			claim.failureMessage ??= message.slice(0, 500);
			claim.updatedAt = now;
			state.events.push({ id: randomUUID(), claimId, connectionId: claim.connectionId, ...(claim.assignmentId ? { assignmentId: claim.assignmentId } : {}), outcome: 'lifecycle-unconfirmed', message: message.slice(0, 500), recordedAt: now });
			state.events = state.events.slice(-100);
			return true;
		});
	}

	async release(claimId: string) {
		return this.update((state) => {
			const before = state.claims.length;
			state.claims = state.claims.filter((claim) => claim.id !== claimId);
			return state.claims.length !== before;
		});
	}

	async snapshot() {
		return this.update((state) => ({ revision: state.revision + 1, claims: state.claims.map(({ dispatchEnvelope: _dispatchEnvelope, ...claim }) => ({ ...claim, leaseToken: claim.leaseToken ? '<redacted>' : undefined })), events: state.events.map((event) => ({ ...event })) }));
	}

	async activeTimeObservation(modelConfigurationId: string, capabilityIds: string[]) {
		return this.update((state, now) => {
			const day = now.slice(0, 10);
			const usage = state.usage[day] ?? {};
			const observation = (capabilityId?: string) => ({ day,
				activeSeconds: usage[JSON.stringify(capabilityId ? [modelConfigurationId, capabilityId] : [modelConfigurationId])] ?? 0,
				reservedSeconds: state.claims.filter(claim => claim.modelConfigurationId === modelConfigurationId
					&& (!capabilityId || claim.capabilityId === capabilityId)).reduce((sum, claim) => sum + Math.max(0,
					(claim.requestedSeconds ?? 0) - (claim.activeStartedAt ? (Date.parse(claim.accountedThrough ?? claim.activeStartedAt)
						- Date.parse(claim.activeStartedAt)) / 1000 : 0)), 0),
			});
			return { observedAt: now, modelUsage: observation(), capabilityUsage: Object.fromEntries(capabilityIds.map(id => [id, observation(id)])) };
		});
	}

	async claimsForRecovery(includeRunning = true) {
		return this.update((state) => state.claims.filter((claim) => claim.status === 'recovery'
			|| claim.status === 'ready'
			|| (includeRunning && claim.status === 'running')).map((claim) => ({ ...claim })));
	}

	async session(connectionId: string) {
		return this.update((state) => state.sessions.find((session) => session.connectionId === connectionId) ?? null);
	}

	async saveSession(connectionId: string, session: { id: string; sequence: number }) {
		return this.update((state, now) => {
			state.sessions = state.sessions.filter((entry) => entry.connectionId !== connectionId);
			state.sessions.push({ connectionId, ...session, updatedAt: now });
			return session;
		});
	}

	async removeSession(connectionId: string) {
		return this.update((state) => { state.sessions = state.sessions.filter((session) => session.connectionId !== connectionId); });
	}

	async token(connectionId: string) {
		return this.update((state) => state.tokens.find((entry) => entry.connectionId === connectionId)?.token ?? null);
	}

	async saveToken(connectionId: string, token: ProviderAccessTokenIssue) {
		return this.update((state, now) => {
			state.tokens = state.tokens.filter((entry) => entry.connectionId !== connectionId);
			state.tokens.push({ connectionId, token, updatedAt: now });
			return token;
		});
	}

	async removeToken(connectionId: string) {
		return this.update((state) => { state.tokens = state.tokens.filter((entry) => entry.connectionId !== connectionId); });
	}

	async clearTokens() {
		return this.update((state) => { state.tokens = []; });
	}

	async setConnectionStatus(connectionId: string, schedulable: boolean, reason?: string) {
		return this.update((state, now) => {
			state.connections = state.connections.filter((entry) => entry.connectionId !== connectionId);
			state.connections.push({ connectionId, schedulable, ...(reason ? { reason: reason.slice(0, 500) } : {}), updatedAt: now });
		});
	}

	async removeConnection(connectionId: string) {
		return this.update((state) => { state.connections = state.connections.filter((entry) => entry.connectionId !== connectionId); });
	}

	async schedulableConnections() {
		return this.update((state) => state.connections.filter((entry) => entry.schedulable).map((entry) => entry.connectionId).sort());
	}
}
