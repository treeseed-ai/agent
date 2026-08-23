import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CapacityProviderManifestV3 } from '@treeseed/sdk/capacity-provider';
import type { ProviderHostRuntimeConfig } from '../configuration/config.ts';
import type { AgentExecutionRequest, AgentExecutionResult, AgentExecutor, AgentExecutorObservation } from './contracts.ts';

type Adapter = CapacityProviderManifestV3['adapters'][number];
type Pending = { resolve(value: unknown): void; reject(error: Error): void; request?: AgentExecutionRequest };

function workerEntry() {
	const javascript = fileURLToPath(new URL('./process-executor-worker.js', import.meta.url));
	if (existsSync(javascript)) return { file: javascript, execArgv: [] as string[] };
	return { file: fileURLToPath(new URL('./process-executor-worker.ts', import.meta.url)), execArgv: ['--import', 'tsx'] };
}

function projectedEnvironment(config: ProviderHostRuntimeConfig, manifest: CapacityProviderManifestV3, adapter: Adapter) {
	const env: NodeJS.ProcessEnv = { NODE_ENV: config.environment, LANG: process.env.LANG, TZ: process.env.TZ };
	for (const profileId of adapter.credentialProfiles ?? []) {
		const profile = manifest.credentialProfiles?.find((candidate) => candidate.id === profileId);
		if (!profile) throw new Error(`Adapter ${adapter.id} references unknown credential profile ${profileId}.`);
		if (profile.source !== 'process-environment') throw new Error(`Adapter ${adapter.id} requires unsupported credential source ${profile.source}.`);
		const value = process.env[profile.reference];
		if (profile.required && !value) throw new Error(`Required credential profile ${profile.id} is unavailable.`);
		if (value) env[profile.reference] = value;
	}
	return env;
}

export function createProcessIsolatedExecutor(config: ProviderHostRuntimeConfig, manifest: CapacityProviderManifestV3, adapter: Adapter, module: string): AgentExecutor {
	const entry = workerEntry();
	const child = fork(entry.file, [], { env: projectedEnvironment(config, manifest, adapter), execArgv: entry.execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
	let sequence = 0;
	const pending = new Map<string, Pending>();
	const rejectAll = (message: string) => { for (const request of pending.values()) request.reject(new Error(message)); pending.clear(); };
	child.once('error', (error) => rejectAll(`Isolated executor failed: ${error.message}`));
	child.once('exit', (code, signal) => rejectAll(`Isolated executor exited (${code ?? signal ?? 'unknown'}).`));
	child.on('message', async (message: any) => {
		if (message?.type === 'treedx') {
			const request = pending.get(String(message.requestId))?.request;
			if (!request) return child.send({ type: 'treedx-result', callId: message.callId, ok: false, error: 'assignment_request_unavailable' });
			try {
				const value = await request.treeDx.invoke(String(message.operationId), message.input ?? {}, { idempotencyKey: message.idempotencyKey });
				child.send({ type: 'treedx-result', callId: message.callId, ok: true, value });
			} catch (error) { child.send({ type: 'treedx-result', callId: message.callId, ok: false, error: error instanceof Error ? error.message : String(error) }); }
			return;
		}
		const id = String(message?.id ?? '');
		const request = pending.get(id);
		if (!request) return;
		pending.delete(id);
		if (message.ok) request.resolve(message.value); else request.reject(new Error(String(message.error ?? 'Isolated executor request failed.')));
	});
	const invoke = <T>(type: 'observe' | 'execute', value?: AgentExecutionRequest) => new Promise<T>((resolve, reject) => {
		const id = `${adapter.id}:${++sequence}`;
		pending.set(id, { resolve: resolve as (value: unknown) => void, reject, request: value });
		child.send({ type, id, request: value ? { assignment: value.assignment, assignmentId: value.assignmentId, leaseToken: value.leaseToken, runnerId: value.runnerId,
			treeDx: { projectId: value.treeDx.projectId, repositoryId: value.treeDx.repositoryId, workspaceId: value.treeDx.workspaceId } } : undefined });
		if (value?.signal) value.signal.addEventListener('abort', () => child.send({ type: 'cancel', id }), { once: true });
	});
	child.send({ type: 'initialize', module, executionProviderId: adapter.id, environment: config.environment });
	const proxy = {
		id: adapter.id,
		observe: () => invoke<AgentExecutorObservation>('observe'),
		execute: (request: AgentExecutionRequest) => invoke<AgentExecutionResult>('execute', request),
		shutdown: () => { child.kill('SIGTERM'); },
	};
	return proxy;
}
