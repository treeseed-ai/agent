import { createHash, createPrivateKey, sign } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { CapacityProviderManifestV5, SandboxAssignment } from '@treeseed/sdk/capacity-provider';
import { providerEnvironmentReceiptSchema, sandboxAssignmentSchema, sandboxLeaseRenewalSchema, sandboxResultSchema } from '@treeseed/sdk/capacity-provider';
import type { ProviderHostRuntimeConfig } from '../configuration/config.ts';
import { loadCapacityProviderIdentity } from '../accounts/identity.ts';
import type { AgentExecutor } from './contracts.ts';
import { SandboxBrokerClient } from './sandbox-broker-client.ts';
import { materializeSandboxInputs } from './sandbox-input-materializer.ts';

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
	? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

type V5Adapter = CapacityProviderManifestV5['adapters'][number];
export function reasoningEffortFromAssignmentMetadata(metadata: Record<string, unknown>) {
	const chatProfile = metadata.chatProfile && typeof metadata.chatProfile === 'object' ? metadata.chatProfile as Record<string, unknown> : {};
	const execution = metadata.executionPolicy && typeof metadata.executionPolicy === 'object' ? metadata.executionPolicy as Record<string, unknown>
		: chatProfile.execution && typeof chatProfile.execution === 'object' ? chatProfile.execution as Record<string, unknown> : {};
	return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(execution.reasoningEffort))
		? String(execution.reasoningEffort) as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' : undefined;
}
export async function createMicrovmExecutor(config: ProviderHostRuntimeConfig, manifest: CapacityProviderManifestV5, adapter: V5Adapter): Promise<AgentExecutor> {
	const client = new SandboxBrokerClient(manifest.sandbox.brokerSocket);
	const identity = await loadCapacityProviderIdentity({ ref: manifest.identity.privateKeyRef, baseDirectory: config.manifestPath ? dirname(resolve(config.manifestPath)) : process.cwd(), dataDirectory: config.dataDir, env: process.env });
	const signingKey = createPrivateKey({ key: identity.privateJwk as never, format: 'jwk' }), keyId = `provider-${createHash('sha256').update(identity.publicJwk.x).digest('hex').slice(0, 16)}`;
	const active = new Map<string, { sandboxId: string; operationToken: string; providerId: string; teamId: string }>();
	return {
		id: adapter.id,
		async renewLease(assignmentId, leaseExpiresAt) {
			const current = active.get(assignmentId); if (!current) return;
			const unsigned = { schemaVersion: 'treeseed.sandbox-lease-renewal/v1' as const, sandboxId: current.sandboxId, assignmentId, providerId: current.providerId, teamId: current.teamId, leaseExpiresAt, issuedAt: new Date().toISOString() };
			const renewal = sandboxLeaseRenewalSchema.parse({ ...unsigned, signature: { keyId, algorithm: 'Ed25519', value: sign(null, Buffer.from(canonical(unsigned)), signingKey).toString('base64url') } });
			await client.renew(current.sandboxId, current.operationToken, renewal);
		},
		async observe() {
			const capabilities = [...new Set(adapter.offers.flatMap(({ offer }) => offer.capabilities.map(({ id }) => id)))];
			try { const status = await client.status(); return { available: status.ready === true, capabilities, reason: status.ready === true ? undefined : String(status.reason ?? 'sandbox_broker_unavailable') }; }
			catch (error) { return { available: false, capabilities, reason: error instanceof Error ? error.message : String(error) }; }
		},
		async execute(request) {
			const brokerStatus = await client.status().catch(() => ({} as Record<string, unknown>));
			const metadata = request.assignment.metadata && typeof request.assignment.metadata === 'object' ? request.assignment.metadata as Record<string, unknown> : {};
			const reasoningEffort = reasoningEffortFromAssignmentMetadata(metadata);
			const offerId = String(request.assignment.offerId ?? metadata.offerId ?? '');
			const v5Binding = adapter.offers.find(({ offer }) => offer.offerId === offerId) ?? null;
			const profileId = v5Binding?.sandboxProfileId;
			const profile = manifest.sandbox.profiles.find((entry) => entry.id === profileId);
			if (!profile || !v5Binding) return { status: 'returned', code: 'sandbox_profile_unavailable', summary: `The selected capability offer ${offerId || '<missing>'} has no healthy provider-local sandbox binding.`, retryable: true };
			const advertisedCapabilities = v5Binding.offer.capabilities.map(({ id }) => id);
			// Every guest receives a private writable project copy. Activity policy controls whether
			// the resulting patch may leave the VM; filesystem permissions never fight Codex.
			const materialized = await materializeSandboxInputs(request, true);
			try {
				const unsigned = { schemaVersion: 'treeseed.sandbox-assignment/v1', assignmentId: request.assignmentId, attempt: Math.max(1, Number(request.assignment.attemptCount ?? 1)), runnerId: request.runnerId,
				providerId: String(request.assignment.capacityProviderId ?? request.assignment.capacity_provider_id ?? ''), teamId: String(request.assignment.teamId ?? request.assignment.team_id ?? ''), projectId: String(request.assignment.projectId ?? request.assignment.project_id ?? ''),
				profile: profile.id, ...(profile.contract ? { environmentContract: profile.contract } : {}), guestImage: profile.guestImage, guestImageDigest: profile.guestImageDigest,
				identityManifestDigest: digest(materialized.identityManifest), contextManifestDigest: materialized.contextManifestDigest, resources: { ...profile.resources, durationSeconds: Math.max(60, Number(request.assignment.leaseSeconds ?? 300)) },
				inputs: materialized.inputs.map(({ sourcePath: _sourcePath, ...input }) => input), outputs: [
					{ id: 'result', path: '/run/treeseed-output/result.json', mediaType: 'application/json', maxBytes: profile.resources.outputBytes },
					...(profile.id === 'read' ? [] : [{ id: 'project-patch', path: '/run/treeseed-output/project.patch', mediaType: 'application/vnd.treeseed.git-patch', maxBytes: profile.resources.outputBytes }]),
				],
				network: { defaultDeny: true as const, relayUrl: 'https://10.89.0.1:7443', allowedServices: ['model-gateway', 'codex-subscription'], ...(profile.id === 'connected' && typeof metadata.developmentSessionId === 'string' ? { connectedDevelopmentSessionId: metadata.developmentSessionId } : {}) },
				modelPolicy: { provider: 'openai', model: adapter.model?.model ?? 'gpt-5.4', ...(reasoningEffort ? { reasoningEffort } : {}), capabilities: advertisedCapabilities, ...(manifest.capacity.maxInputTokens ? { maxInputTokens: manifest.capacity.maxInputTokens } : {}), ...(manifest.capacity.maxOutputTokens ? { maxOutputTokens: manifest.capacity.maxOutputTokens } : {}), ...(manifest.capacity.maxCost ? { maxCost: manifest.capacity.maxCost } : {}) },
				credentialHandles: (adapter.credentialProfiles ?? []).map((id) => ({ id, profileId: id, revealAllowed: false as const })), treeDxHandleIds: request.treeDx.workspaceId ? [request.treeDx.workspaceId] : [],
				leaseExpiresAt: String(request.assignment.leaseExpiresAt ?? new Date(Date.now() + 300_000).toISOString()) };
				const value = sign(null, Buffer.from(canonical(unsigned)), signingKey).toString('base64url');
				const assignment = sandboxAssignmentSchema.parse({ ...unsigned, signature: { keyId, algorithm: 'Ed25519', value } }) as SandboxAssignment;
				const prepared = await client.prepare(assignment, request.signal); active.set(request.assignmentId, { sandboxId: prepared.sandboxId, operationToken: prepared.operationToken, providerId: assignment.providerId, teamId: assignment.teamId }); let result; let artifacts: Record<string, unknown>[] = []; let teardown: Record<string, unknown> = { verified: false, completedAt: null };
				const cancelSandbox = () => { void client.cancel(prepared.sandboxId, prepared.operationToken).catch(() => undefined); };
				if (request.signal?.aborted) cancelSandbox(); else request.signal?.addEventListener('abort', cancelSandbox, { once: true });
				await request.emit?.({ type: 'sandbox.created', occurredAt: new Date().toISOString(), summary: `Prepared Kata sandbox ${prepared.sandboxId}.`, payload: { sandboxId: prepared.sandboxId, profile: assignment.profile, guestImageDigest: assignment.guestImageDigest,
					identityManifestDigest: assignment.identityManifestDigest, contextManifestDigest: assignment.contextManifestDigest, inputs: assignment.inputs.map(({ id, digest: inputDigest, bytes, disposition, mediaType, targetPath }) => ({ id, digest: inputDigest, bytes, disposition, mediaType, targetPath })) },
					protectedPayload: { identityManifest: materialized.identityManifest, contextManifest: materialized.context } });
				try {
					for (const input of materialized.inputs) await client.upload(prepared.sandboxId, prepared.operationToken, input.id, input.sourcePath, input.bytes, request.signal);
					await request.emit?.({ type: 'execution.started', occurredAt: new Date().toISOString(), summary: `Kata execution started in ${prepared.sandboxId}.`, payload: { sandboxId: prepared.sandboxId, model: assignment.modelPolicy.model, isolation: 'microvm' } });
					result = sandboxResultSchema.parse(await client.execute(prepared.sandboxId, prepared.operationToken, {}, request.signal));
					artifacts = await Promise.all(result.artifacts.map(async (artifact) => ({ ...artifact, content: (await client.downloadArtifact(prepared.sandboxId, prepared.operationToken, artifact.id, artifact.bytes, request.signal)).toString('utf8') })));
				} finally {
					request.signal?.removeEventListener('abort', cancelSandbox);
					const receipt = await client.destroy(prepared.sandboxId, prepared.operationToken).catch(() => null); teardown = receipt && typeof receipt.teardown === 'object' ? receipt.teardown as Record<string, unknown> : teardown;
					active.delete(request.assignmentId);
					await request.emit?.({ type: 'sandbox.destroyed', occurredAt: new Date().toISOString(), summary: `Kata sandbox ${prepared.sandboxId} teardown ${teardown.verified === true ? 'verified' : 'could not be verified'}.`, payload: { sandboxId: prepared.sandboxId, teardown } });
				}
				if (!result) throw new Error('Sandbox broker returned no assignment result.');
				const environmentReceipt = profile.lineage ? (() => {
					const unsigned = { schemaVersion: 'treeseed.provider-environment-receipt/v1' as const, assignmentId: request.assignmentId, offerId,
						providerId: assignment.providerId, imageDigest: assignment.guestImageDigest,
						baseLineage: { baseImageDigest: profile.lineage.baseImageDigest, provenanceDigest: profile.lineage.provenanceDigest, architectures: profile.lineage.architectures },
						securityAttestationDigest: digest({ sandboxId: result.sandboxId, assignment: assignment.signature, teardown }), brokerVersion: String(brokerStatus.version ?? brokerStatus.brokerVersion ?? 'unknown'), teardown: { verified: teardown.verified === true, completedAt: typeof teardown.completedAt === 'string' ? teardown.completedAt : null }, createdAt: new Date().toISOString() };
					return providerEnvironmentReceiptSchema.parse({ ...unsigned, signature: { keyId, algorithm: 'Ed25519', value: sign(null, Buffer.from(canonical(unsigned)), signingKey).toString('base64url') } });
				})() : null;
				if (environmentReceipt) await request.emit?.({ type: 'sandbox.environment.attested', occurredAt: environmentReceipt.createdAt, summary: 'Provider environment attestation recorded.', payload: { environmentReceipt } });
				if (result.status === 'completed') {
					const abstained = result.responseMarkdown?.trim() === '<!-- treeseed:abstain -->';
					await request.emit?.({ type: 'execution.completed', occurredAt: new Date().toISOString(), summary: result.summary, payload: { sandboxId: result.sandboxId, model: assignment.modelPolicy.model, provider: assignment.modelPolicy.provider, capabilities: assignment.modelPolicy.capabilities,
						usage: [result.usage], timing: { elapsedSeconds: result.usage.elapsedSeconds }, resources: { cpuUserMicros: result.usage.cpuUserMicros, cpuSystemMicros: result.usage.cpuSystemMicros, peakRssBytes: result.usage.peakRssBytes }, artifacts: result.artifacts, teardown }, protectedPayload: result.diagnostics });
					return { status: abstained ? 'abstained' : result.responseMarkdown ? 'responded' : 'completed', summary: result.summary, ...(!abstained && result.responseMarkdown ? { responseMarkdown: result.responseMarkdown } : {}), outputs: { sandboxId: result.sandboxId, teardown, environmentReceipt }, artifacts, usage: [result.usage] };
				}
				await request.emit?.({ type: 'execution.failed', occurredAt: new Date().toISOString(), summary: result.summary, payload: { sandboxId: result.sandboxId, status: result.status, teardown }, protectedPayload: result.diagnostics });
				return { status: result.status === 'failed' ? 'failed' : 'returned', code: `sandbox_${result.status}`, summary: result.summary, retryable: result.status !== 'failed', outputs: { sandboxId: result.sandboxId, teardown } };
			} finally { await materialized.cleanup(); }
		},
	};
}
