import { createHash, createPrivateKey, sign } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { CapacityProviderManifestV5, SandboxAssignment } from '@treeseed/sdk/capacity-provider';
import { assignmentTimingAwarenessReceiptSchema, providerEnvironmentReceiptSchema, sandboxAssignmentSchema, sandboxLeaseRenewalSchema, sandboxResultSchema } from '@treeseed/sdk/capacity-provider';
import { assignmentAttemptSchema, type AssignmentReference } from '@treeseed/sdk/agent-capacity';
import type { ProviderHostRuntimeConfig } from '../configuration/config.ts';
import { loadCapacityProviderIdentity } from '../accounts/identity.ts';
import type { AgentExecutor } from './contracts.ts';
import { SandboxBrokerClient } from './sandbox-broker-client.ts';
import { materializeSandboxInputs } from './sandbox-input-materializer.ts';
import { activeSandboxAttempt, prepareAssignmentSource, renewAssignmentSource, type ActiveSource } from './source-workspace.ts';
import { publishSourceBranch } from './source-branch-publication.ts';
import { assignmentRuntimeSeconds } from './activity/context.ts';
import { RenewalDrain } from './activity/renewal-drain.ts';
import { assignmentOfferId } from './assignment-selection.ts';

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
	? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

type V5Adapter = CapacityProviderManifestV5['adapters'][number];
const TOOL_PERMISSION:Record<string,string>={treedx_build_context:'source.read',treedx_read_files:'source.read',treedx_search_files:'source.read',treedx_list_paths:'source.read'};
function object(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
export function timingAwarenessEvidence(value: unknown) {
	const parsed = assignmentTimingAwarenessReceiptSchema.safeParse(value);
	if (!parsed.success) throw new Error('Completed sandbox result lacks valid timing-awareness evidence.');
	return parsed.data;
}
function contextBuildBody(value:Record<string,unknown>) {
	const topics=Array.isArray(value.topics)?value.topics.map(String).map((item)=>item.trim()).filter(Boolean).slice(0,20):[];
	const query=String(value.query??topics.join(' ')).trim().slice(0,2_000);
	const existingBudget=object(value.budget),maxItems=Number(value.maxItems??existingBudget.maxNodes),maxTokens=Number(value.maxTokens??existingBudget.maxTokens);
	return {
		...value,...(query?{query}:{}),
		...(Number.isFinite(maxItems)||Number.isFinite(maxTokens)?{budget:{...existingBudget,
			...(Number.isFinite(maxItems)?{maxNodes:Math.min(50,Math.max(1,Math.floor(maxItems)))}:{}),
			...(Number.isFinite(maxTokens)?{maxTokens:Math.min(100_000,Math.max(1,Math.floor(maxTokens)))}:{}),
		}}:{}),
		topics:undefined,maxItems:undefined,maxTokens:undefined,
	};
}
export async function executeAssignmentTreeDxTool(request:Parameters<AgentExecutor['execute']>[0],tool:string,arguments_:Record<string,unknown>, executionTime?: { startedAt: string; deadlineAt: string }) {
	if (tool === 'treeseed_time_status') {
		if (!executionTime) throw new Error('Productive execution has not started.');
		return { startedAt: executionTime.startedAt, deadlineAt: executionTime.deadlineAt,
			remainingSeconds: Math.max(0, Math.ceil((Date.parse(executionTime.deadlineAt) - Date.now()) / 1_000)) };
	}
	const attempt=object(request.assignment.assignmentAttempt??object(request.assignment.workspaceContext).assignmentAttempt);
	const assignmentGrant=object(attempt.grant);
	const allowed=Array.isArray(assignmentGrant.tools)?assignmentGrant.tools.map(String):[];
	if(!TOOL_PERMISSION[tool]||!allowed.includes(TOOL_PERMISSION[tool])) throw new Error(`Activity profile does not authorize ${tool}.`);
	if(!request.treeDx.repositoryId||!request.treeDx.baseRef) throw new Error('Assignment TreeDX current-view authority is unavailable.');
	const selected=String(arguments_.project??arguments_.projectId??'').trim();
	const currentGrant=request.treeDx.readRepositories?.find((candidate)=>candidate.repositoryId===request.treeDx.repositoryId);
	const grant=selected?request.treeDx.readRepositories?.find((candidate)=>candidate.projectId===selected||candidate.projectSlug===selected):currentGrant;
	if(selected&&!grant&&selected!==request.treeDx.projectId)throw new Error(`Assignment has no TreeDX read grant for project ${selected}.`);
	const path={projectId:grant?.projectId??request.treeDx.projectId,repoId:grant?.repositoryId??request.treeDx.repositoryId};
	if(tool==='treedx_read_files') return request.treeDx.invoke('treedx.repositories.files.read',{path,body:{paths:Array.isArray(arguments_.paths)?arguments_.paths.slice(0,20).map(String):[],encoding:'utf8',parseFrontmatter:true,allowProtected:true}});
	if(tool==='treedx_search_files') return request.treeDx.invoke('treedx.repositories.files.search',{path,body:{paths:Array.isArray(arguments_.paths)?arguments_.paths.slice(0,20).map(String):undefined,query:String(arguments_.query??'').slice(0,2_000),limit:Math.min(100,Math.max(1,Number(arguments_.limit??30))),includeBody:arguments_.includeBody===true,includeFrontmatter:true}});
	if(tool==='treedx_list_paths') return request.treeDx.invoke('treedx.repositories.paths.list',{path,body:{paths:Array.isArray(arguments_.paths)?arguments_.paths.slice(0,20).map(String):[],kinds:['blob'],limit:Math.min(200,Math.max(1,Number(arguments_.limit??100)))}});
	const body=contextBuildBody(object(arguments_.request)); return request.treeDx.invoke('treedx.repositories.context.build',{path,body});
}
export function reasoningEffortFromAssignmentMetadata(metadata: Record<string, unknown>) {
	const chatProfile = metadata.chatProfile && typeof metadata.chatProfile === 'object' ? metadata.chatProfile as Record<string, unknown> : {};
	const execution = metadata.executionPolicy && typeof metadata.executionPolicy === 'object' ? metadata.executionPolicy as Record<string, unknown>
		: chatProfile.execution && typeof chatProfile.execution === 'object' ? chatProfile.execution as Record<string, unknown> : {};
	return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(execution.reasoningEffort))
		? String(execution.reasoningEffort) as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' : undefined;
}
export function assignmentAllowedServices(executionKind: unknown, treeDxEnabled: boolean) {
	return ['model-gateway', 'codex-subscription', ...(executionKind === 'workday' ? ['package-registry'] : []), ...(treeDxEnabled ? ['treedx-relay'] : [])];
}
export function assignmentNeedsSourceWorkspace(attempt: ReturnType<typeof assignmentAttemptSchema.safeParse>) {
	if (!attempt.success) return true;
	return attempt.data.workspace.mode === 'git' || attempt.data.grant.sourceRead.length > 0;
}
export async function createMicrovmExecutor(config: ProviderHostRuntimeConfig, manifest: CapacityProviderManifestV5, adapter: V5Adapter): Promise<AgentExecutor> {
	const client = new SandboxBrokerClient(manifest.sandbox.brokerSocket);
	const identity = await loadCapacityProviderIdentity({ ref: manifest.identity.privateKeyRef, baseDirectory: config.manifestPath ? dirname(resolve(config.manifestPath)) : process.cwd(), dataDirectory: config.dataDir, env: process.env });
	const signingKey = createPrivateKey({ key: identity.privateJwk as never, format: 'jwk' }), keyId = `provider-${createHash('sha256').update(identity.publicJwk.x).digest('hex').slice(0, 16)}`;
	const active = new Map<string, { sandboxId: string; operationToken: string; providerId: string; teamId: string; source?: ActiveSource; renewals: RenewalDrain }>();
	return {
		id: adapter.id,
		async renewLease(assignmentId, leaseExpiresAt) {
			const current = active.get(assignmentId); if (!current) return;
			const unsigned = { schemaVersion: 'treeseed.sandbox-lease-renewal/v1' as const, sandboxId: current.sandboxId, assignmentId, providerId: current.providerId, teamId: current.teamId, leaseExpiresAt, issuedAt: new Date().toISOString() };
			const renewal = sandboxLeaseRenewalSchema.parse({ ...unsigned, signature: { keyId, algorithm: 'Ed25519', value: sign(null, Buffer.from(canonical(unsigned)), signingKey).toString('base64url') } });
			await current.renewals.run(async () => {
				await client.renew(current.sandboxId, current.operationToken, renewal);
				await renewAssignmentSource(client, current);
			});
		},
		async observe() {
			const capabilities = [...new Set(adapter.offers.flatMap(({ offer }) => offer.capabilities.map(({ id }) => id)))];
			try { const status = await client.status(); return { available: status.ready === true, capabilities, reason: status.ready === true ? undefined : String(status.reason ?? 'sandbox_broker_unavailable') }; }
			catch (error) { return { available: false, capabilities, reason: error instanceof Error ? error.message : String(error) }; }
		},
		async execute(request) {
			const attempt = assignmentAttemptSchema.safeParse(request.assignment.assignmentAttempt ?? object(request.assignment.workspaceContext).assignmentAttempt);
			const brokerStatus = await client.status().catch(() => ({} as Record<string, unknown>));
			const metadata = request.assignment.metadata && typeof request.assignment.metadata === 'object' ? request.assignment.metadata as Record<string, unknown> : {};
			const reasoningEffort = reasoningEffortFromAssignmentMetadata(metadata);
			const offerId = assignmentOfferId(request.assignment);
			const v5Binding = adapter.offers.find(({ offer }) => offer.offerId === offerId) ?? null;
			const profileId = v5Binding?.sandboxProfileId;
			const profile = manifest.sandbox.profiles.find((entry) => entry.id === profileId);
			if (!profile || !v5Binding) return { status: 'returned', code: 'sandbox_profile_unavailable', summary: `The selected capability offer ${offerId || '<missing>'} has no healthy provider-local sandbox binding.`, retryable: true };
			const advertisedCapabilities = v5Binding.offer.capabilities.map(({ id }) => id);
			// Inputs are always private to the guest. Git source is attached only when the
			// canonical attempt selects it or grants an exact source read.
			const materialized = await materializeSandboxInputs(request);
			try {
				const unsigned = { schemaVersion: 'treeseed.sandbox-assignment/v1', assignmentId: request.assignmentId, attempt: activeSandboxAttempt(request.assignment.attemptCount), runnerId: request.runnerId,
				providerId: String(request.assignment.capacityProviderId ?? request.assignment.capacity_provider_id ?? ''), teamId: String(request.assignment.teamId ?? request.assignment.team_id ?? ''), projectId: String(request.assignment.projectId ?? request.assignment.project_id ?? ''),
				profile: profile.id, ...(profile.contract ? { environmentContract: profile.contract } : {}), guestImage: profile.guestImage, guestImageDigest: profile.guestImageDigest,
				identityManifestDigest: digest(materialized.identityManifest), contextManifestDigest: materialized.contextManifestDigest, resources: { ...profile.resources, durationSeconds: assignmentRuntimeSeconds(request.assignment) },
				inputs: materialized.inputs.map(({ sourcePath: _sourcePath, ...input }) => input), outputs: [
					{ id: 'result', path: '/run/treeseed-output/result.json', mediaType: 'application/json', maxBytes: profile.resources.outputBytes },
				],
				network: { defaultDeny: true as const, relayUrl: 'https://10.89.0.1:7443', allowedServices: assignmentAllowedServices(request.assignment.executionKind, Boolean(request.treeDx.handleId)), ...(profile.id === 'connected' && typeof metadata.developmentSessionId === 'string' ? { connectedDevelopmentSessionId: metadata.developmentSessionId } : {}) },
					modelPolicy: { provider: 'openai', model: adapter.model?.model ?? 'gpt-5.6-terra', ...(reasoningEffort ? { reasoningEffort } : {}), capabilities: advertisedCapabilities, ...(manifest.capacity.maxInputTokens ? { maxInputTokens: manifest.capacity.maxInputTokens } : {}), ...(manifest.capacity.maxOutputTokens ? { maxOutputTokens: manifest.capacity.maxOutputTokens } : {}), ...(manifest.capacity.maxCost ? { maxCost: manifest.capacity.maxCost } : {}) },
				credentialHandles: (adapter.credentialProfiles ?? []).map((id) => ({ id, profileId: id, revealAllowed: false as const })), treeDxHandleIds: [request.treeDx.handleId],
				leaseExpiresAt: String(request.assignment.leaseExpiresAt ?? new Date(Date.now() + 300_000).toISOString()) };
				const value = sign(null, Buffer.from(canonical(unsigned)), signingKey).toString('base64url');
				const assignment = sandboxAssignmentSchema.parse({ ...unsigned, signature: { keyId, algorithm: 'Ed25519', value } }) as SandboxAssignment;
				await request.emit?.({ type: 'execution.preparing', occurredAt: new Date().toISOString(), summary: 'Requesting a bounded Kata sandbox from the host broker.', payload: { profile: assignment.profile, guestImageDigest: assignment.guestImageDigest } });
				const prepared = await client.prepare(assignment, request.signal); active.set(request.assignmentId, { sandboxId: prepared.sandboxId, operationToken: prepared.operationToken, providerId: assignment.providerId, teamId: assignment.teamId, renewals: new RenewalDrain() }); let result; let sourceReference: AssignmentReference | undefined; let artifacts: Record<string, unknown>[] = []; let teardown: Record<string, unknown> = { verified: false, completedAt: null };
				const cancelSandbox = () => { void client.cancel(prepared.sandboxId, prepared.operationToken).catch(() => undefined); };
					if (request.signal?.aborted) cancelSandbox(); else request.signal?.addEventListener('abort', cancelSandbox, { once: true });
				try {
				await request.emit?.({ type: 'sandbox.created', occurredAt: new Date().toISOString(), summary: `Prepared Kata sandbox ${prepared.sandboxId}.`, payload: { sandboxId: prepared.sandboxId, profile: assignment.profile, guestImageDigest: assignment.guestImageDigest,
					identityManifestDigest: assignment.identityManifestDigest, contextManifestDigest: assignment.contextManifestDigest, inputs: assignment.inputs.map(({ id, digest: inputDigest, bytes, disposition, mediaType, targetPath }) => ({ id, digest: inputDigest, bytes, disposition, mediaType, targetPath })) },
					protectedPayload: { identityManifest: materialized.identityManifest, contextManifest: materialized.context } });
					const current = active.get(request.assignmentId)!;
					if (assignmentNeedsSourceWorkspace(attempt)) {
						current.source = await prepareAssignmentSource(client, prepared, request);
						if (current.source.authorization.mode === 'work' && current.source.authorization.publication !== 'assignment-branch') throw new Error('Git work requires assignment-branch publication authority.');
					}
					for (const input of materialized.inputs) await client.upload(prepared.sandboxId, prepared.operationToken, input.id, input.sourcePath, input.bytes, request.signal);
					if (!request.beginExecution) throw new Error('Productive execution start authority is unavailable.');
					const startedAssignment = await request.beginExecution();
					const executionTime = object(object(object(startedAssignment.capacityEnvelope).budget).time);
					const executionStartedAt = String(executionTime.executionStartedAt ?? '');
					const executionDeadlineAt = String(executionTime.executionDeadlineAt ?? '');
					if (!Number.isFinite(Date.parse(executionStartedAt)) || !Number.isFinite(Date.parse(executionDeadlineAt))) throw new Error('API execution start omitted its authoritative productive window.');
					await request.emit?.({ type: 'execution.started', occurredAt: new Date().toISOString(), summary: `Kata execution started in ${prepared.sandboxId}.`, payload: { sandboxId: prepared.sandboxId, model: assignment.modelPolicy.model, isolation: 'microvm' } });
					const toolsAbort=new AbortController();
					const toolPump=(async()=>{while(!toolsAbort.signal.aborted){const pending=await client.nextToolRequest(prepared.sandboxId,prepared.operationToken,toolsAbort.signal).catch((error)=>{if(toolsAbort.signal.aborted)return {request:null};throw error;});if(pending.request){try{const value=await executeAssignmentTreeDxTool(request,pending.request.tool,pending.request.arguments,{startedAt:executionStartedAt,deadlineAt:executionDeadlineAt});await client.completeToolRequest(prepared.sandboxId,prepared.operationToken,pending.request.id,{result:value},request.signal);}catch(error){await client.completeToolRequest(prepared.sandboxId,prepared.operationToken,pending.request.id,{error:error instanceof Error?error.message:String(error)},request.signal);}}else await new Promise((resolve)=>setTimeout(resolve,50));}})();
					try{result = sandboxResultSchema.parse(await client.execute(prepared.sandboxId, prepared.operationToken, {}, request.signal));}finally{toolsAbort.abort();await toolPump.catch(()=>undefined);}
					artifacts = await Promise.all(result.artifacts.map(async (artifact) => ({ ...artifact, content: (await client.downloadArtifact(prepared.sandboxId, prepared.operationToken, artifact.id, artifact.bytes, request.signal)).toString('utf8') })));
					if (result.status === 'completed' && current.source?.authorization.mode === 'work') sourceReference = await publishSourceBranch(client, prepared, current.source, assignment, result, request);
				} finally {
					request.signal?.removeEventListener('abort', cancelSandbox);
					const renewals = active.get(request.assignmentId)?.renewals;
					active.delete(request.assignmentId);
					await renewals?.close();
					const receipt = await client.destroy(prepared.sandboxId, prepared.operationToken).catch(() => null); teardown = receipt && typeof receipt.teardown === 'object' ? receipt.teardown as Record<string, unknown> : teardown;
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
					const diagnostics = object(result.diagnostics);
					const timingAwareness = timingAwarenessEvidence(result.timingAwareness);
					await request.emit?.({ type: 'execution.completed', occurredAt: new Date().toISOString(), summary: result.summary, payload: { sandboxId: result.sandboxId, model: assignment.modelPolicy.model, provider: assignment.modelPolicy.provider, capabilities: assignment.modelPolicy.capabilities,
						usage: [result.usage], timing: { elapsedSeconds: result.usage.elapsedSeconds }, resources: { cpuUserMicros: result.usage.cpuUserMicros, cpuSystemMicros: result.usage.cpuSystemMicros, peakRssBytes: result.usage.peakRssBytes }, artifacts: result.artifacts,
						activityCompletion: diagnostics.activityCompletion ?? null, timingAwareness, changedPaths: diagnostics.changedPaths ?? [], teardown }, protectedPayload: result.diagnostics });
					return { status: abstained ? 'abstained' : result.responseMarkdown ? 'responded' : 'completed', summary: result.summary, ...(!abstained && result.responseMarkdown ? { responseMarkdown: result.responseMarkdown } : {}), outputs: { sandboxId: result.sandboxId, teardown, environmentReceipt,
						verificationRecords: object(result.diagnostics).verificationRecords ?? [],
						activityCompletion: object(result.diagnostics).activityCompletion ?? null,
						timingAwareness,
						providerEventShapes: Array.isArray(diagnostics.providerEventShapes) ? diagnostics.providerEventShapes : [],
						...(sourceReference ? { sourceReference } : {}) }, artifacts, usage: [result.usage] };
				}
				await request.emit?.({ type: 'execution.failed', occurredAt: new Date().toISOString(), summary: result.summary, payload: { sandboxId: result.sandboxId, status: result.status, teardown }, protectedPayload: result.diagnostics });
				return { status: result.status === 'failed' ? 'failed' : 'returned', code: `sandbox_${result.status}`, summary: result.summary, retryable: result.status !== 'failed', outputs: { sandboxId: result.sandboxId, teardown } };
			} finally { await materialized.cleanup(); }
		},
	};
}
