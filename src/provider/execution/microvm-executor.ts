import { createHash, createPrivateKey, sign } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
import { clockReading, timingAwarenessContract } from '../../sandbox/guest.ts';

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
	? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

type V5Adapter = CapacityProviderManifestV5['adapters'][number];
const TOOL_PERMISSION:Record<string,string>={treedx_build_context:'source.read',treedx_read_files:'source.read',treedx_search_files:'source.read',treedx_list_paths:'source.read'};
function object(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
/** Translate harness-native counters once at the sandbox transport boundary. */
export function sandboxAccountingUsage(usage: Record<string, unknown>): Record<string, unknown> {
	const fields = { input_tokens: 'inputTokens', cached_input_tokens: 'cachedInputTokens',
		output_tokens: 'outputTokens', reasoning_output_tokens: 'reasoningTokens' };
	// Provenance is diagnostic metadata, not a provider-native numeric unit.
	// Retain every other raw observation, including invalid values: the owning
	// aggregate validator must reject them, never silently manufacture a count.
	const nativeUsage = { ...usage }; delete nativeUsage.provenance;
	const normalized: Record<string, unknown> = { ...usage, nativeUsage };
	for (const [native, canonical] of Object.entries(fields)) {
		const value = usage[native];
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) normalized[canonical] = value;
		delete normalized[native];
	}
	return normalized;
}
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
		const attempt = assignmentAttemptSchema.parse(request.assignment.assignmentAttempt ?? object(request.assignment.workspaceContext).assignmentAttempt);
		const start = Date.parse(executionTime.startedAt), end = Date.parse(executionTime.deadlineAt);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start > Date.now()
			|| start < Date.parse(attempt.createdAt) || end > Date.parse(attempt.deadline)
			|| end - start > attempt.limits.maximumSeconds * 1_000) throw new Error('Assignment productive execution clock is invalid.');
		return { startedAt: executionTime.startedAt, deadlineAt: executionTime.deadlineAt,
			remainingSeconds: Math.max(0, Math.ceil((Date.parse(executionTime.deadlineAt) - Date.now()) / 1_000)) };
	}
	const attempt=object(request.assignment.assignmentAttempt??object(request.assignment.workspaceContext).assignmentAttempt);
	const assignmentGrant=object(attempt.grant);
	const allowed=Array.isArray(assignmentGrant.tools)?assignmentGrant.tools.map(String):[];
	if(!TOOL_PERMISSION[tool]||!allowed.includes(TOOL_PERMISSION[tool])) throw new Error(`Activity profile does not authorize ${tool}.`);
	if(!request.treeDx.repositoryId||!request.treeDx.baseRef) throw new Error('Assignment TreeDX current-view authority is unavailable.');
	const inventory=request.treeDx.readRepositories??[];
	const selectors=[arguments_.project,arguments_.projectId].filter(value=>value!==undefined);
	if(selectors.some(value=>typeof value!=='string'||!value.trim()))throw new Error('Assignment TreeDX project selector is invalid.');
	const selected=typeof selectors[0]==='string'?selectors[0].trim():'';
	const current=inventory.filter(candidate=>candidate.repositoryId===request.treeDx.repositoryId);
	if(current.length>1)throw new Error('Assignment TreeDX current repository is ambiguous.');
	const matching=(selector:string)=>inventory.filter(candidate=>candidate.projectId===selector||candidate.projectSlug===selector||candidate.repositoryId===selector);
	const matches=selected?matching(selected):current;
	if(matches.length>1)throw new Error('Assignment TreeDX project selector is ambiguous.');
	const grant=matches[0];
	for(const selector of selectors.slice(1)) {
		const alternate=matching(String(selector).trim());
		if(alternate.length!==1||alternate[0]!==grant)throw new Error('Assignment TreeDX project selectors contradict each other.');
	}
	if(selected&&!grant&&selected!==request.treeDx.projectId)throw new Error(`Assignment has no TreeDX read grant for project ${selected}.`);
	const path={projectId:grant?.projectId??request.treeDx.projectId,repoId:grant?.repositoryId??request.treeDx.repositoryId};
	if(tool==='treedx_read_files') {
		const ref=String(arguments_.ref??'').trim();
		if(ref&&!/^[a-f0-9]{40}$/u.test(ref)) throw new Error('TreeDX read ref must be an exact commit.');
		return request.treeDx.invoke('treedx.repositories.files.read',{path,body:{...(ref?{ref}:{}),paths:Array.isArray(arguments_.paths)?arguments_.paths.slice(0,20).map(String):[],encoding:'utf8',parseFrontmatter:true,allowProtected:true}});
	}
	if(tool==='treedx_search_files') return request.treeDx.invoke('treedx.repositories.files.search',{path,body:{paths:Array.isArray(arguments_.paths)?arguments_.paths.slice(0,20).map(String):undefined,query:String(arguments_.query??'').slice(0,2_000),limit:Math.min(100,Math.max(1,Number(arguments_.limit??30))),includeBody:arguments_.includeBody===true,includeFrontmatter:true}});
	if(tool==='treedx_list_paths') return request.treeDx.invoke('treedx.repositories.paths.list',{path,body:{paths:Array.isArray(arguments_.paths)?arguments_.paths.slice(0,20).map(String):[],kinds:['blob'],limit:Math.min(200,Math.max(1,Number(arguments_.limit??100)))}});
	const body=contextBuildBody(object(arguments_.request)); return request.treeDx.invoke('treedx.repositories.context.build',{path,body});
}
export function assignmentAllowedServices(executionKind: unknown, treeDxEnabled: boolean) {
	return ['model-gateway', 'codex-subscription', ...(executionKind === 'workday' ? ['package-registry'] : []), ...(treeDxEnabled ? ['treedx-relay'] : [])];
}

/** Observe proxy failures immediately; never retry a failed delivery as a second response. */
export function startSandboxToolPump(client: Pick<SandboxBrokerClient, 'nextToolRequest' | 'completeToolRequest'>,
	prepared: { sandboxId: string; operationToken: string }, request: Parameters<AgentExecutor['execute']>[0],
	executionTime: { startedAt: string; deadlineAt: string }, onFailure: () => void) {
	const controller = new AbortController();
	let failure: Error | undefined;
	const completion = (async () => {
		while (!controller.signal.aborted) {
			const pending = await client.nextToolRequest(prepared.sandboxId, prepared.operationToken, controller.signal);
			if (controller.signal.aborted) break;
			if (!pending.request) { await delay(50, undefined, { signal: controller.signal }); continue; }
			let payload: { result: unknown } | { error: string };
			try {
				payload = { result: await executeAssignmentTreeDxTool(request, pending.request.tool, pending.request.arguments, executionTime) };
			} catch (error) { payload = { error: error instanceof Error ? error.message : String(error) }; }
			if (!controller.signal.aborted) await client.completeToolRequest(prepared.sandboxId, prepared.operationToken,
				pending.request.id, payload, controller.signal);
		}
	})().catch(error => {
		if (!controller.signal.aborted) {
			failure = error instanceof Error ? error : new Error(String(error));
			onFailure();
		}
	});
	return async () => { controller.abort(); await completion; return failure; };
}
export function assignmentNeedsSourceWorkspace(attempt: ReturnType<typeof assignmentAttemptSchema.safeParse>) {
	if (!attempt.success) return true;
	return attempt.data.workspace.mode === 'git' || attempt.data.grant.sourceRead.length > 0;
}
export function assertGitWorkPublication(authority: { mode: string; publication: string }) {
	if (authority.mode === 'work' && authority.publication !== 'assignment-branch' && authority.publication !== 'simulation-branch') {
		throw new Error('Git work requires assignment-branch or simulation-branch publication authority.');
	}
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
			try {
				const status = await client.status();
				const checks = status.checks && typeof status.checks === 'object' ? Object.entries(status.checks).filter(([, ready]) => ready !== true).map(([name]) => name) : [];
				return { available: status.ready === true, capabilities, reason: status.ready === true ? undefined : `${String(status.reason ?? 'sandbox_broker_unavailable')}${checks.length ? `: ${checks.join(',')}` : ''}` };
			}
			catch (error) { return { available: false, capabilities, reason: error instanceof Error ? error.message : String(error) }; }
		},
		async execute(request) {
			const attempt = assignmentAttemptSchema.safeParse(request.assignment.assignmentAttempt ?? object(request.assignment.workspaceContext).assignmentAttempt);
			const metadata = request.assignment.metadata && typeof request.assignment.metadata === 'object' ? request.assignment.metadata as Record<string, unknown> : {};
			const reasoningEffort = adapter.model?.reasoningEffort;
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
				const preparationDeadlineAt = String(object(object(object(request.assignment.capacityEnvelope).budget).time).preparationDeadlineAt ?? '');
				const prepared = await client.prepare(assignment, preparationDeadlineAt, request.signal); active.set(request.assignmentId, { sandboxId: prepared.sandboxId, operationToken: prepared.operationToken, providerId: assignment.providerId, teamId: assignment.teamId, renewals: new RenewalDrain() }); let result: ReturnType<typeof sandboxResultSchema.parse> | undefined; let sourceReference: AssignmentReference | undefined; let artifacts: Record<string, unknown>[] = []; let teardown: Record<string, unknown> = { verified: false, completedAt: null };
				let transportFailure: unknown;
				const cancelSandbox = () => { void client.cancel(prepared.sandboxId, prepared.operationToken).catch(() => undefined); };
					if (request.signal?.aborted) cancelSandbox(); else request.signal?.addEventListener('abort', cancelSandbox, { once: true });
				try {
				await request.emit?.({ type: 'sandbox.created', occurredAt: new Date().toISOString(), summary: `Prepared Kata sandbox ${prepared.sandboxId}.`, payload: { sandboxId: prepared.sandboxId, profile: assignment.profile, guestImageDigest: assignment.guestImageDigest,
					identityManifestDigest: assignment.identityManifestDigest, contextManifestDigest: assignment.contextManifestDigest, inputs: assignment.inputs.map(({ id, digest: inputDigest, bytes, disposition, mediaType, targetPath }) => ({ id, digest: inputDigest, bytes, disposition, mediaType, targetPath })) },
					protectedPayload: { identityManifest: materialized.identityManifest, contextManifest: materialized.context } });
					const current = active.get(request.assignmentId)!;
					if (assignmentNeedsSourceWorkspace(attempt)) {
						current.source = await prepareAssignmentSource(client, prepared, request);
						assertGitWorkPublication(current.source.authorization);
					}
					for (const input of materialized.inputs) await client.upload(prepared.sandboxId, prepared.operationToken, input.id, input.sourcePath, input.bytes, request.signal);
					if (!request.beginExecution) throw new Error('Productive execution start authority is unavailable.');
					const startedAssignment = await request.beginExecution();
					const executionTime = object(object(object(startedAssignment.capacityEnvelope).budget).time);
					const executionStartedAt = String(executionTime.executionStartedAt ?? '');
					const executionDeadlineAt = String(executionTime.executionDeadlineAt ?? '');
					if (!Number.isFinite(Date.parse(executionStartedAt)) || !Number.isFinite(Date.parse(executionDeadlineAt))) throw new Error('API execution start omitted its authoritative productive window.');
					await request.emit?.({ type: 'execution.started', occurredAt: new Date().toISOString(), summary: `Kata execution started in ${prepared.sandboxId}.`, payload: { sandboxId: prepared.sandboxId, model: assignment.modelPolicy.model, isolation: 'microvm' } });
					let toolFailure: Error | undefined;
					let executionFailure: unknown;
					const stopToolPump = startSandboxToolPump(client, prepared, request,
						{ startedAt: executionStartedAt, deadlineAt: executionDeadlineAt }, cancelSandbox);
					try { result = sandboxResultSchema.parse(await client.execute(prepared.sandboxId, prepared.operationToken, {}, request.signal)); }
					catch (error) { executionFailure = error; }
					finally {
						try { await request.finishExecution?.(); }
						finally { toolFailure = await stopToolPump(); }
					}
					if (toolFailure) throw Object.assign(new Error(`Assignment tool proxy failed: ${toolFailure.message}`), {
						code: 'assignment_tool_proxy_failed', cause: executionFailure,
					});
					if (executionFailure) throw executionFailure;
					if (!result) throw new Error('Sandbox broker returned no assignment result.');
					if (result.sandboxId !== prepared.sandboxId || result.assignmentId !== assignment.assignmentId) throw Object.assign(new Error('Sandbox result does not match its owning assignment.'), { code: 'sandbox_result_correlation_mismatch' });
					const artifactIds = new Set<string>();
					for (const artifact of result.artifacts) {
						const declared = assignment.outputs.find(output => output.id === artifact.id);
						if (!declared || artifactIds.has(artifact.id) || artifact.path !== declared.path || artifact.mediaType !== declared.mediaType
							|| !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > declared.maxBytes) throw Object.assign(new Error('Sandbox artifact is outside declared output authority.'), { code: 'sandbox_artifact_unauthorized' });
						artifactIds.add(artifact.id);
					}
					artifacts = await Promise.all(result.artifacts.map(async artifact => {
						const bytes = await client.downloadArtifact(prepared.sandboxId, prepared.operationToken, artifact.id, artifact.bytes, request.signal);
						if (bytes.length !== artifact.bytes || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== artifact.digest) throw Object.assign(new Error('Sandbox artifact bytes disagree with their declared size or digest.'), { code: 'sandbox_artifact_integrity_invalid' });
						return { ...artifact, content: bytes.toString('utf8') };
					}));
					if (result.status === 'completed') {
						const events = object(result.diagnostics).providerEvents;
						const receipt = timingAwarenessEvidence(result.timingAwareness);
						const actual = Array.isArray(events) ? timingAwarenessContract(events.map(object)) : undefined;
						const identities = new Set<string>(), pending = new Set<string>(); let remaining = Infinity, checkedBeforeBlocking = false;
						let valid = !!actual && actual.completedChecks === receipt.completedChecks && actual.completedChecks >= 2 && actual.firstToolCompliant && actual.finalToolCompliant;
						for (const event of Array.isArray(events) ? events : []) {
							const row = object(event), item = object(row.item);
							if (row.type === 'item.started' && ['command_execution', 'mcp_tool_call'].includes(String(item.type))) pending.add(String(item.id));
							if (row.type !== 'item.completed') continue;
							if (item.type === 'mcp_tool_call' && item.server === 'treedx' && item.tool === 'treeseed_time_status') {
								const reading = clockReading(item.result);
								if (typeof item.id !== 'string' || identities.has(item.id) || !reading || reading.startedAt !== executionStartedAt || reading.deadlineAt !== executionDeadlineAt
									|| reading.remainingSeconds <= 0 || reading.remainingSeconds > remaining) valid = false;
								identities.add(String(item.id)); remaining = reading?.remainingSeconds ?? remaining; checkedBeforeBlocking = true;
							} else if (item.type === 'command_execution') { if (!checkedBeforeBlocking) valid = false; checkedBeforeBlocking = false; }
							pending.delete(String(item.id));
						}
						if (!valid || pending.size) throw new Error('Completed sandbox result lacks valid timing-awareness evidence.');
					}
					if (result.status === 'completed' && current.source?.authorization.mode === 'work') sourceReference = await publishSourceBranch(client, prepared, current.source, assignment, result, request);
				} catch (error) { transportFailure = error; } finally {
					request.signal?.removeEventListener('abort', cancelSandbox);
					const renewals = active.get(request.assignmentId)?.renewals;
					active.delete(request.assignmentId);
					await renewals?.close();
					let destroyFailure: unknown;
					const receipt = await client.destroy(prepared.sandboxId, prepared.operationToken).catch(error => { destroyFailure = error; return null; });
					teardown = object(receipt?.teardown);
					if (!receipt || receipt.sandboxId !== prepared.sandboxId || receipt.destroyed !== true || teardown.verified !== true
						|| typeof teardown.completedAt !== 'string' || !Number.isFinite(Date.parse(teardown.completedAt)) || Date.parse(teardown.completedAt) > Date.now()) {
						transportFailure = Object.assign(new Error('Sandbox teardown could not be independently verified.'), { code: 'sandbox_teardown_unverified', cause: destroyFailure ?? transportFailure });
					}
					try {
						await request.emit?.({ type: 'sandbox.destroyed', occurredAt: new Date().toISOString(), summary: `Kata sandbox ${prepared.sandboxId} teardown ${teardown.verified === true ? 'verified' : 'could not be verified'}.`, payload: { sandboxId: prepared.sandboxId, teardown } });
					} catch (error) { if (!request.signal?.aborted) throw error; }
				}
				if (transportFailure) throw Object.assign(transportFailure instanceof Error ? transportFailure : new Error(String(transportFailure)), {
					outputs: { sandboxId: prepared.sandboxId, teardown }, ...(result ? { usage: [sandboxAccountingUsage(result.usage)] } : {}),
				});
				if (!result) throw new Error('Sandbox broker returned no assignment result.');
				const environmentReceipt = profile.lineage ? (() => {
					const unsigned = { schemaVersion: 'treeseed.provider-environment-receipt/v1' as const, assignmentId: request.assignmentId, offerId,
						providerId: assignment.providerId, imageDigest: assignment.guestImageDigest,
						baseLineage: { baseImageDigest: profile.lineage.baseImageDigest, provenanceDigest: profile.lineage.provenanceDigest, architectures: profile.lineage.architectures },
						securityAttestationDigest: digest({ sandboxId: result.sandboxId, assignment: assignment.signature, teardown }), brokerVersion: 'unknown', teardown: { verified: teardown.verified === true, completedAt: typeof teardown.completedAt === 'string' ? teardown.completedAt : null }, createdAt: new Date().toISOString() };
					return providerEnvironmentReceiptSchema.parse({ ...unsigned, signature: { keyId, algorithm: 'Ed25519', value: sign(null, Buffer.from(canonical(unsigned)), signingKey).toString('base64url') } });
				})() : null;
				if (environmentReceipt) await request.emit?.({ type: 'sandbox.environment.attested', occurredAt: environmentReceipt.createdAt, summary: 'Provider environment attestation recorded.', payload: { environmentReceipt } });
				const usage = sandboxAccountingUsage(result.usage);
				if (result.status === 'completed') {
					const abstained = result.responseMarkdown?.trim() === '<!-- treeseed:abstain -->';
					const diagnostics = object(result.diagnostics);
					const timingAwareness = timingAwarenessEvidence(result.timingAwareness);
					await request.emit?.({ type: 'execution.completed', occurredAt: new Date().toISOString(), summary: result.summary, payload: { sandboxId: result.sandboxId, model: assignment.modelPolicy.model, provider: assignment.modelPolicy.provider, capabilities: assignment.modelPolicy.capabilities,
						usage: [usage], timing: { elapsedSeconds: result.usage.elapsedSeconds }, resources: { cpuUserMicros: result.usage.cpuUserMicros, cpuSystemMicros: result.usage.cpuSystemMicros, peakRssBytes: result.usage.peakRssBytes }, artifacts: result.artifacts,
						activityCompletion: diagnostics.activityCompletion ?? null, timingAwareness, changedPaths: diagnostics.changedPaths ?? [], teardown }, protectedPayload: result.diagnostics });
					return { status: abstained ? 'abstained' : result.responseMarkdown ? 'responded' : 'completed', summary: result.summary, ...(!abstained && result.responseMarkdown ? { responseMarkdown: result.responseMarkdown } : {}), outputs: { sandboxId: result.sandboxId, teardown, environmentReceipt,
						verificationRecords: object(result.diagnostics).verificationRecords ?? [],
						activityCompletion: object(result.diagnostics).activityCompletion ?? null,
						timingAwareness,
						providerEventShapes: Array.isArray(diagnostics.providerEventShapes) ? diagnostics.providerEventShapes : [],
						...(sourceReference ? { sourceReference } : {}) }, artifacts, usage: [usage] };
				}
				await request.emit?.({ type: 'execution.failed', occurredAt: new Date().toISOString(), summary: result.summary, payload: { sandboxId: result.sandboxId, status: result.status, teardown }, protectedPayload: result.diagnostics });
				const resourceExhausted = result.summary.includes('sandbox_resource_exhausted:');
				return { status: result.status === 'failed' && !resourceExhausted ? 'failed' : 'returned',
					code: resourceExhausted ? 'sandbox_resource_exhausted' : `sandbox_${result.status}`,
					summary: result.summary, retryable: resourceExhausted || result.status !== 'failed',
					outputs: { sandboxId: result.sandboxId, teardown }, usage: [usage] };
			} finally { await materialized.cleanup(); }
		},
	};
}
