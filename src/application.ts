import { AgentSchemas, AgentContractBinding, AgentContractError, CanonicalJson, type AgentExecutionRequest, type AgentExecutionResult, type AgentAuthorityBinding, type AgentBlocker } from '@treeseed-cordis/sdk';
import { CordisScope, CompositionError, type ProviderRegistration, type CompositionDescriptor, type ProviderLease, type ScopeReplacement } from '@treeseed-cordis/sdk/runtime';
import { AgentTokens, type AgentHost } from './contracts.js';
import { AgentPrivateFile, AgentFileGrantPlugin } from './authority.js';
import { AgentContextPlugin, AgentEchoToolPlugin, AgentEchoHandlerPlugin, AgentReporterPlugin, AgentExecutionPlugin } from './providers.js';
import { AgentHostPlugin } from './execution.js';
export * from './contracts.js';
export { AgentPrivateFile } from './authority.js';
export interface AgentConfiguration {
    binding: AgentAuthorityBinding;
    authorityFile: string;
    handler?: ProviderRegistration;
    overrides?: readonly ProviderRegistration[];
    hostArtifact?: string;
}
export interface AgentStatus {
    generation: string;
    providerId: string;
    ready: boolean;
    activeExecutions: number;
    disposedChildren: number;
}
export interface AgentReplacement {
    state: 'pending' | 'active';
    generation: string;
}
class CancellationRelay {
    private readonly listener: () => void;
    constructor(private readonly signal: AbortSignal | undefined, private readonly controller: AbortController) { this.listener = this.abort.bind(this); if (signal?.aborted)
        this.abort();
    else
        signal?.addEventListener('abort', this.listener, { once: true }); }
    private abort(): void { this.controller.abort(); }
    dispose(): void { this.signal?.removeEventListener('abort', this.listener); }
}
export class AgentApplication {
    private readonly running = new Map<string, {
        controller: AbortController;
        job: Promise<AgentExecutionResult>;
    }>();
    private closing = false;
    private failed = false;
    private transitioning = false;
    private pendingHandler: ProviderRegistration | null = null;
    private children = 0;
    private disposal: Promise<void> | null = null;
    private constructor(private readonly configuration: AgentConfiguration, private readonly scope: CordisScope, private handler: ProviderRegistration) { }
    static async start(input: AgentConfiguration): Promise<AgentApplication> { const binding = AgentSchemas.authority.parse(input.binding), file = AgentSchemas.authority.parse(AgentPrivateFile.read(input.authorityFile)); if (file.state !== 'granted')
        throw new AgentContractError('AGENT_GRANT_REVOKED'); if (CanonicalJson.stringify(binding) !== CanonicalJson.stringify(file))
        throw new AgentContractError('AGENT_SCOPE_MISMATCH'); const configuration = { ...input, binding }, handler = input.handler ?? this.defaultHandler(), descriptor = this.descriptor(configuration, handler), scope = await CordisScope.start(descriptor, { scopeId: binding.scopeId, target: 'agent', principalId: binding.principalId, resourceScope: binding.resourceScope }); return new AgentApplication(configuration, scope, handler); }
    private static defaultHandler(): ProviderRegistration { return { token: AgentTokens.handler, plugin: AgentEchoHandlerPlugin, declaration: AgentEchoHandlerPlugin.declaration, configuration: {}, artifact: { kind: 'bundled', identity: '@treeseed-cordis/agent@0.0.0-cordis.1' } }; }
    private static descriptor(configuration: AgentConfiguration, handler: ProviderRegistration): CompositionDescriptor {
        const artifact = { kind: 'bundled' as const, identity: configuration.hostArtifact ?? '@treeseed-cordis/agent@0.0.0-cordis.1' }, registrations: ProviderRegistration[] = [
            { token: AgentTokens.authority, plugin: AgentFileGrantPlugin, declaration: AgentFileGrantPlugin.declaration, configuration: { file: configuration.authorityFile, binding: configuration.binding }, artifact },
            { token: AgentTokens.context, plugin: AgentContextPlugin, declaration: AgentContextPlugin.declaration, configuration: {}, artifact },
            { token: AgentTokens.tool, plugin: AgentEchoToolPlugin, declaration: AgentEchoToolPlugin.declaration, configuration: {}, artifact },
            { token: AgentTokens.reporting, plugin: AgentReporterPlugin, declaration: AgentReporterPlugin.declaration, configuration: {}, artifact },
            { token: AgentTokens.execution, plugin: AgentExecutionPlugin, declaration: AgentExecutionPlugin.declaration, configuration: {}, artifact },
            { token: AgentTokens.host, plugin: AgentHostPlugin, declaration: AgentHostPlugin.declaration, configuration: {}, artifact }, handler
        ];
        const replaced = new Set<string>();
        for (const override of configuration.overrides ?? []) {
            if (replaced.has(override.token.id))
                throw new CompositionError('DUPLICATE_SELECTION');
            replaced.add(override.token.id);
            const index = registrations.findIndex(AgentApplication.capability.bind(null, override.token.id));
            if (index < 0)
                throw new CompositionError('UNKNOWN_AGENT_SEAM');
            registrations[index] = override;
        }
        const selections = [];
        for (const registration of registrations) {
            const declaration = registration.declaration as {
                id: string;
            };
            selections.push({ scopeId: configuration.binding.scopeId, capability: registration.token.id, providerId: declaration.id });
        }
        return { registrations, selections };
    }
    private static capability(id: string, registration: ProviderRegistration): boolean { return registration.token.id === id; }
    status(): AgentStatus { return { generation: this.scope.generation, providerId: (this.handler.declaration as {
            id: string;
        }).id, ready: !this.closing && !this.failed && !this.transitioning, activeExecutions: this.running.size, disposedChildren: this.children }; }
    async execute(input: unknown, signal?: AbortSignal): Promise<AgentExecutionResult> { if (this.closing || this.failed)
        throw new Error('AGENT_ADMISSION_CLOSED'); const request = Object.freeze(AgentContractBinding.assert(input, this.configuration.binding, this.scope.generation)), lease = await this.scope.acquire(AgentTokens.host); if (this.running.has(request.executionId)) {
        await lease.release();
        throw new Error('AGENT_EXECUTION_BUSY');
    } const controller = new AbortController(), relay = new CancellationRelay(signal, controller), job = this.perform(request, lease, controller.signal, relay); this.running.set(request.executionId, { controller, job }); try {
        return await job;
    }
    finally {
        this.running.delete(request.executionId);
    } }
    private static code(error: unknown): string | null { if (error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string')
        return Reflect.get(error, 'code') as string; return error instanceof Error ? error.message : null; }
    private static blocker(code: string): AgentBlocker { const messages: Record<string, string> = { INVALID_AGENT_CONTRACT: 'The Agent execution contract is invalid.', AGENT_GRANT_REVOKED: 'The Agent execution grant is revoked.', AGENT_SCOPE_MISMATCH: 'The Agent execution authority does not match.', STALE_AGENT_GENERATION: 'The Agent execution generation is stale.', AGENT_PROVIDER_FAILURE: 'The Agent provider failed.', AGENT_CANCELLED: 'The Agent execution was cancelled.', AGENT_CLEANUP_FAILED: 'The Agent execution cleanup failed.' }; return AgentSchemas.blocker.parse({ code, message: messages[code] }); }
    private async perform(request: AgentExecutionRequest, lease: ProviderLease<AgentHost>, signal: AbortSignal, relay: CancellationRelay): Promise<AgentExecutionResult> {
        let output: string | null = null, state: 'completed' | 'cancelled' | 'blocked' | 'recovery-required' = 'completed', blockers: AgentBlocker[] = [], cleanup: 'disposed' | 'failed' = 'disposed';
        try {
            output = await lease.value.execute(request, signal);
            lease.assertOpen();
        }
        catch (error) {
            const code = AgentApplication.code(error);
            if (code === 'PROVIDER_LIFECYCLE') {
                state = 'recovery-required';
                cleanup = 'failed';
                blockers = [AgentApplication.blocker('AGENT_CLEANUP_FAILED')];
                this.failed = true;
                this.scope.fence();
            }
            else {
                state = signal.aborted ? 'cancelled' : 'blocked';
                blockers = [AgentApplication.blocker(state === 'cancelled' ? 'AGENT_CANCELLED' : ['INVALID_AGENT_CONTRACT', 'AGENT_GRANT_REVOKED', 'AGENT_SCOPE_MISMATCH', 'STALE_AGENT_GENERATION'].includes(code ?? '') ? code! : 'AGENT_PROVIDER_FAILURE')];
            }
            output = null;
        }
        finally {
            relay.dispose();
            try {
                await lease.release();
            }
            catch {
                state = 'recovery-required';
                cleanup = 'failed';
                output = null;
                blockers = [AgentApplication.blocker('AGENT_CLEANUP_FAILED')];
                this.failed = true;
                this.scope.fence();
            }
            if (cleanup === 'disposed')
                this.children++;
        }
        const { operation: _operation, expectedGeneration, text: _text, ...identity } = request;
        let result: unknown = { ...identity, generation: expectedGeneration, state, output, blockers, cleanup };
        if (!AgentSchemas.result.safeParse(result).success)
            result = { ...identity, generation: expectedGeneration, state: 'blocked', output: null, blockers: [AgentApplication.blocker('AGENT_PROVIDER_FAILURE')], cleanup: 'disposed' };
        return AgentSchemas.result.parse(result);
    }
    cancel(executionId: string): boolean { AgentSchemas.key.parse(executionId); const execution = this.running.get(executionId); if (!execution)
        return false; execution.controller.abort(); return true; }
    async replace(handler: ProviderRegistration, expectedGeneration: string, timeoutMs = 30000): Promise<AgentReplacement> { try {
        const result = await this.scope.beginReplacement(AgentApplication.descriptor(this.configuration, handler), expectedGeneration, timeoutMs);
        this.transitioning = true;
        this.pendingHandler = handler;
        return await this.accept(result);
    }
    catch (error) {
        if (AgentApplication.code(error) === 'PROVIDER_LIFECYCLE') {
            this.failed = true;
            this.scope.fence();
        }
        throw error;
    } }
    async continueReplacement(timeoutMs = 30000): Promise<AgentReplacement> { try {
        return await this.accept(await this.scope.continueReplacement(timeoutMs));
    }
    catch (error) {
        this.failed = true;
        this.scope.fence();
        throw error;
    } }
    private async accept(result: ScopeReplacement): Promise<AgentReplacement> { if (result.state === 'pending')
        return { state: 'pending', generation: this.scope.generation }; const lease = await this.scope.inspectCandidate(AgentTokens.host); try {
        lease.assertOpen();
    }
    finally {
        await lease.release();
    } const generation = this.scope.commitReplacement(); this.handler = this.pendingHandler!; this.pendingHandler = null; this.transitioning = false; return { state: 'active', generation }; }
    dispose(): Promise<void> { if (!this.disposal) {
        this.closing = true;
        this.disposal = this.close();
    } return this.disposal; }
    private async close(): Promise<void> { const jobs = []; for (const execution of this.running.values()) {
        execution.controller.abort();
        jobs.push(execution.job);
    } await Promise.allSettled(jobs); await this.scope.dispose(); }
}
