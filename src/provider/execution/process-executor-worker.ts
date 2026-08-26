import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import type { AgentExecutor, AgentExecutorModule, AssignmentTreeDxFacade } from './contracts.ts';

let executor: AgentExecutor | null = null;
let initializing: Promise<void> | null = null;
const controllers = new Map<string, AbortController>();
const calls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let callSequence = 0;

async function initialize(message: any) {
	const specifier = String(message.module);
	const key = isAbsolute(specifier) || specifier.startsWith('.') ? pathToFileURL(resolve(specifier)).href : specifier;
	const loaded = await import(key) as AgentExecutorModule;
	if (typeof loaded.createAgentExecutor !== 'function') throw new Error('Executor module must export createAgentExecutor().');
	executor = await loaded.createAgentExecutor({ executionProviderId: String(message.executionProviderId), environment: String(message.environment) });
}

function treeDx(requestId: string, snapshot: any): AssignmentTreeDxFacade {
	return {
		projectId: String(snapshot.projectId), repositoryId: snapshot.repositoryId ?? null,
		workspaceId: snapshot.workspaceId ?? null, baseRef: snapshot.baseRef ?? null,
		invoke(operationId, input, options) {
			return new Promise((resolve, reject) => {
				const callId = `${requestId}:${++callSequence}`;
				calls.set(callId, { resolve, reject });
				process.send?.({ type: 'treedx', requestId, callId, operationId, input, idempotencyKey: options?.idempotencyKey });
			});
		},
	};
}

process.on('message', async (message: any) => {
	if (message?.type === 'treedx-result') {
		const call = calls.get(String(message.callId));
		if (!call) return;
		calls.delete(String(message.callId));
		if (message.ok) call.resolve(message.value); else call.reject(new Error(String(message.error)));
		return;
	}
	if (message?.type === 'cancel') return controllers.get(String(message.id))?.abort();
	const id = String(message?.id ?? '');
	try {
		if (message.type === 'initialize') { initializing = initialize(message); return await initializing; }
		if (initializing) await initializing;
		if (!executor) throw new Error('Executor process is not initialized.');
		if (message.type === 'observe') return process.send?.({ id, ok: true, value: await executor.observe() });
		if (message.type === 'execute') {
			const controller = new AbortController(); controllers.set(id, controller);
			const request = message.request;
			const value = await executor.execute({ ...request, treeDx: treeDx(id, request.treeDx), signal: controller.signal });
			controllers.delete(id);
			return process.send?.({ id, ok: true, value });
		}
	} catch (error) { process.send?.({ id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
process.on('disconnect', () => process.exit(0));
