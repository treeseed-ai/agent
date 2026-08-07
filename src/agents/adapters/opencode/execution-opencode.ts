import type { ExecutionProviderObservation, ExecutionRunRef, ExecutionRunSnapshot, ExecutionUsageActual } from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../../runtime/runtime-types.ts';

type Row = Record<string, unknown>;
export interface OpenCodeExecutionProviderOptions { baseUrl?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; providerId?: string; model?: string; }
function record(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function array(value: unknown): Row[] { return Array.isArray(value) ? value.map(record) : []; }
function text(...values: unknown[]) { return String(values.find((value) => typeof value === 'string' && value.trim()) ?? '').trim(); }
function number(...values: unknown[]) { const value = values.map(Number).find(Number.isFinite); return value ?? 0; }

export class OpenCodeExecutionProviderAdapter implements ExecutionProviderAdapter {
	private readonly snapshots = new Map<string, ExecutionRunSnapshot>();
	constructor(private readonly options: OpenCodeExecutionProviderOptions = {}) {}
	private env() { return this.options.env ?? process.env; }
	private baseUrl() { return text(this.options.baseUrl, this.env().TREESEED_OPENCODE_SERVER_URL, 'http://127.0.0.1:4096').replace(/\/$/u, ''); }
	private headers() {
		const username = text(this.env().TREESEED_OPENCODE_SERVER_USERNAME, 'opencode');
		const password = text(this.env().TREESEED_OPENCODE_SERVER_PASSWORD);
		return { accept: 'application/json', 'content-type': 'application/json', ...(password ? { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` } : {}) };
	}
	private async request(path: string, init: RequestInit = {}) {
		const response = await (this.options.fetchImpl ?? fetch)(`${this.baseUrl()}${path}`, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(`OpenCode ${init.method ?? 'GET'} ${path} failed (${response.status}): ${text(record(payload).error, record(payload).message, response.statusText)}`);
		return record(payload);
	}
	async describe() { return { id: 'opencode', kind: 'ai_model' as const, capabilities: ['planning', 'implementation', 'repo_read', 'repo_write', 'streaming', 'usage'], nativeUnit: 'token', quotaVisibility: 'exact' as const, maxConcurrentAssignments: 1, supportsAsync: true, supportsCancel: true, supportsResume: true, supportsUsage: true, supportsArtifacts: true, metadata: { serverUrl: this.baseUrl(), credentialMode: 'environment_brokered' } }; }
	async observe(): Promise<ExecutionProviderObservation> {
		try { await this.request('/global/health'); return { descriptor: await this.describe(), available: true, pressure: 'normal', activeAssignmentCount: 0, metadata: { configured: true, openRouterCredentialBrokered: Boolean(this.env().TREESEED_OPENROUTER_API_KEY) } }; }
		catch (error) { return { descriptor: await this.describe(), available: false, pressure: 'exhausted', blockedReason: error instanceof Error ? error.message : String(error), metadata: { configured: false } }; }
	}
	async prepare() { const observed = await this.observe(); return { accepted: observed.available === true, summary: observed.available ? 'OpenCode server is ready.' : observed.blockedReason ?? 'OpenCode is unavailable.', retryable: true, code: observed.available ? null : 'opencode_unavailable' }; }
	async start(input: ExecutionProviderInvocation): Promise<ExecutionRunSnapshot> {
		const session = await this.request('/session', { method: 'POST', body: JSON.stringify({ title: `TreeSeed ${input.assignment.id}` }) });
		const sessionId = text(session.id, record(session.session).id);
		if (!sessionId) throw new Error('OpenCode did not return a session id.');
		const configuredModel = text(input.agent.cli.model, input.agent.execution.model);
		const providerID = text(this.options.providerId, record(input.metadata?.executionProvider).providerId, this.env().TREESEED_OPENCODE_PROVIDER_ID, 'openrouter');
		const modelID = text(this.options.model, record(input.metadata?.executionProvider).model, configuredModel);
		const prompt = [input.agent.systemPrompt, input.workPackage.instructions, 'Assignment envelope:', JSON.stringify({ capacity: input.capacityEnvelope, workspace: input.workspace, tools: input.tools ?? [] }, null, 2)].join('\n\n');
		const message = await this.request(`/session/${encodeURIComponent(sessionId)}/message`, { method: 'POST', body: JSON.stringify({ model: { providerID, modelID }, parts: [{ type: 'text', text: prompt }] }) });
		const parts = array(message.parts ?? record(message.message).parts);
		const output = parts.filter((part) => part.type === 'text').map((part) => text(part.text)).filter(Boolean).join('\n');
		const usage = this.usageFromMessage(message);
		const snapshot: ExecutionRunSnapshot = { status: 'completed', summary: output || 'OpenCode completed the assignment.', runId: sessionId, externalRef: sessionId, outputs: { message, text: output }, usage, artifacts: [{ kind: 'opencode_session', name: sessionId, uri: `${this.baseUrl()}/session/${sessionId}` }], metadata: { provider: 'opencode', providerID, modelID, credentialMode: 'environment_brokered', sessionId } };
		this.snapshots.set(sessionId, snapshot); return snapshot;
	}
	async poll(input: ExecutionRunRef) { return this.snapshots.get(input.runId) ?? { status: 'running' as const, summary: 'OpenCode session is running.', runId: input.runId, externalRef: input.externalRef ?? input.runId, metadata: { provider: 'opencode' } }; }
	resume(input: ExecutionRunRef) { return this.poll(input); }
	async cancel(input: ExecutionRunRef & { reason: string }) { await this.request(`/session/${encodeURIComponent(input.externalRef ?? input.runId)}/abort`, { method: 'POST', body: JSON.stringify({ reason: input.reason }) }); const snapshot = { status: 'cancelled' as const, summary: `OpenCode session aborted: ${input.reason}`, runId: input.runId, externalRef: input.externalRef ?? input.runId, code: 'opencode_aborted', retryable: false }; this.snapshots.set(input.runId, snapshot); return snapshot; }
	async collectUsage(input: ExecutionRunRef) { return this.snapshots.get(input.runId)?.usage ?? []; }
	async collectArtifacts(input: ExecutionRunRef) { const payload = await this.request(`/session/${encodeURIComponent(input.externalRef ?? input.runId)}/diff`).catch(() => ({})); return [{ kind: 'opencode_diff', name: `${input.runId}.diff`, metadata: { provider: 'opencode', diff: payload } }]; }
	private usageFromMessage(message: Row): ExecutionUsageActual[] {
		const info = record(message.info ?? record(message.message).info); const tokens = record(info.tokens ?? message.tokens); const cost = number(info.cost, message.cost);
		return [
			{ kind: 'input_tokens', unit: 'token', amount: number(tokens.input, tokens.prompt), source: 'opencode' },
			{ kind: 'output_tokens', unit: 'token', amount: number(tokens.output, tokens.completion), source: 'opencode' },
			{ kind: 'reasoning_tokens', unit: 'token', amount: number(tokens.reasoning), source: 'opencode' },
			{ kind: 'cached_input_tokens', unit: 'token', amount: number(record(tokens.cache).read, tokens.cached), source: 'opencode' },
			...(cost > 0 ? [{ kind: 'provider_cost', unit: 'USD', amount: cost, source: 'openrouter' }] : []),
		];
	}
}
