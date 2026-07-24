import type { AgentSdk } from '@treeseed/sdk';
import { getMachineConfigPaths, loadCliDeployConfig, loadMachineConfig, resolveRemoteSession } from '@treeseed/sdk/workflow-support';
import type { AgentMessageRecord, AgentStatusRecord, DirectBoardItemSummary, ProjectOverviewSummary, ReleaseDetail, ReleaseSummary, SharePackageStatus, WorkstreamDetail, WorkstreamState, WorkstreamSummary } from '@treeseed/sdk';
import { normalizeProjectJobStatus } from '@treeseed/sdk';
import { checkCodexProviderReadiness } from '../../../agents/adapters/codex/codex-readiness.ts';
import type { ApiConfig } from '../../types.ts';
import { asRecords, inferMessageKind, nowIso, readOptionalString, readString } from './project-route-helpers.ts';

export async function summarizeDirect(sdk: AgentSdk, projectId: string) {
	const [objectives, questions, notes, proposals, decisions, workstreams, releases] = await Promise.all([
		sdk.search({ model: 'objective', sort: [{ field: 'updated_at', direction: 'desc' }], limit: 50 }),
		sdk.search({ model: 'question', sort: [{ field: 'updated_at', direction: 'desc' }], limit: 50 }),
		sdk.search({ model: 'note', sort: [{ field: 'updated_at', direction: 'desc' }], limit: 50 }),
		sdk.search({ model: 'proposal', sort: [{ field: 'updated_at', direction: 'desc' }], limit: 50 }),
		sdk.search({ model: 'decision', sort: [{ field: 'updated_at', direction: 'desc' }], limit: 50 }),
		sdk.listWorkstreams(projectId),
		sdk.listReleases(projectId),
	]);

	const workstreamPayload = workstreams.payload ?? [];
	const releasePayload = releases.payload ?? [];
	const linkIndex = new Map<string, { workstreamIds: string[]; releaseIds: string[] }>();
	for (const workstream of workstreamPayload) {
		for (const ref of workstream.linkedItems) {
			const key = `${ref.model}:${ref.id}`;
			const current = linkIndex.get(key) ?? { workstreamIds: [], releaseIds: [] };
			current.workstreamIds.push(workstream.id);
			linkIndex.set(key, current);
		}
	}
	for (const release of releasePayload) {
		for (const workstreamId of release.workstreamIds) {
			const workstream = workstreamPayload.find((entry) => entry.id === workstreamId);
			for (const ref of workstream?.linkedItems ?? []) {
				const key = `${ref.model}:${ref.id}`;
				const current = linkIndex.get(key) ?? { workstreamIds: [], releaseIds: [] };
				current.releaseIds.push(release.id);
				linkIndex.set(key, current);
			}
		}
	}

	const mapItems = (model: 'objective' | 'question' | 'note' | 'proposal' | 'decision', entries: Record<string, unknown>[]) =>
		entries.slice(0, 15).map((entry): DirectBoardItemSummary => {
			const id = readString(entry, 'id', 'slug');
			const links = linkIndex.get(`${model}:${id}`) ?? { workstreamIds: [], releaseIds: [] };
			return {
				model,
				id,
				title: readString(entry, 'title', 'name') || id,
				status: readOptionalString(entry, 'status'),
				updatedAt: readOptionalString(entry, 'updated_at', 'updatedAt', 'updated'),
				linkedWorkstreamIds: [...new Set(links.workstreamIds)],
				linkedReleaseIds: [...new Set(links.releaseIds)],
			};
		});

	return {
		projectId,
		objectiveCount: objectives.payload.length,
		questionCount: questions.payload.length,
		noteCount: notes.payload.length,
		proposalCount: proposals.payload.length,
		decisionCount: decisions.payload.length,
		savedViews: ['Now', 'Blocked', 'Ready for research', 'Ready for build', 'Release-linked'],
		items: [
			...mapItems('objective', objectives.payload as Record<string, unknown>[]),
			...mapItems('question', questions.payload as Record<string, unknown>[]),
			...mapItems('note', notes.payload as Record<string, unknown>[]),
			...mapItems('proposal', proposals.payload as Record<string, unknown>[]),
			...mapItems('decision', decisions.payload as Record<string, unknown>[]),
		].slice(0, 15),
	};
}

export async function summarizeAgents(sdk: AgentSdk, projectId: string) {
	const [specs, runs, messages] = await Promise.all([
		sdk.listAgentSpecs({ enabled: true }),
		sdk.search({ model: 'agent_run', sort: [{ field: 'startedAt', direction: 'desc' }], limit: 100 }),
		sdk.search({ model: 'message', sort: [{ field: 'updated_at', direction: 'desc' }], limit: 100 }),
	]);
	const workstreams = await sdk.listWorkstreams(projectId);
	const workstreamIds = new Set((workstreams.payload ?? []).map((entry) => entry.id));

	const agentStatuses: AgentStatusRecord[] = specs.map((spec) => {
		const latestRun = (runs.payload as Record<string, unknown>[]).find((entry) => readString(entry, 'agentSlug', 'agent_slug') === spec.slug);
		const latestMessage = (messages.payload as Record<string, unknown>[]).find((entry) => readString(entry, 'type') && readString(entry, 'payloadJson', 'payload_json'));
		return {
			agentSlug: spec.slug,
			handler: spec.handler,
			status: readString(latestRun ?? {}, 'status') === 'failed'
				? 'failed'
				: readString(latestRun ?? {}, 'status') === 'running'
					? 'active'
					: latestRun
						? 'idle'
						: 'waiting',
			currentTask: readOptionalString(latestRun ?? {}, 'summary'),
			workstreamId: readOptionalString(latestRun ?? {}, 'selectedItemKey'),
			lastMessage: readOptionalString(latestMessage ?? {}, 'type'),
			lastRunAt: readOptionalString(latestRun ?? {}, 'startedAt', 'started_at', 'finishedAt', 'finished_at'),
		};
	});

	const messageRecords: AgentMessageRecord[] = (messages.payload as Record<string, unknown>[]).map((entry) => {
		const payloadJson = readString(entry, 'payloadJson', 'payload_json');
		let parsed: Record<string, unknown> = {};
		try {
			parsed = payloadJson ? JSON.parse(payloadJson) : {};
		} catch {
			parsed = {};
		}
		const workstreamId = typeof parsed.workstreamId === 'string' && workstreamIds.has(parsed.workstreamId)
			? parsed.workstreamId
			: null;
		return {
			id: String(entry.id ?? ''),
			agentSlug: readString(parsed, 'agentSlug') || readString(entry, 'relatedId', 'related_id') || 'agent',
			kind: inferMessageKind(readString(entry, 'type'), readString(entry, 'status')),
			type: readString(entry, 'type'),
			status: readString(entry, 'status') || 'pending',
			summary: readString(parsed, 'summary', 'message', 'failureSummary', 'blockingReason') || readString(entry, 'type'),
			workstreamId,
			releaseId: typeof parsed.releaseId === 'string' ? parsed.releaseId : null,
			createdAt: readString(entry, 'updated_at', 'updatedAt', 'created_at') || nowIso(),
			metadata: parsed,
		};
	});

	return {
		projectId,
		agents: agentStatuses,
		messages: messageRecords,
	};
}

export async function summarizeProject(sdk: AgentSdk, config: ApiConfig, principal: { metadata?: Record<string, unknown> } | null): Promise<ProjectOverviewSummary> {
	const [direct, workstreams, agents, releases, packages] = await Promise.all([
		summarizeDirect(sdk, config.projectId),
		sdk.listWorkstreams(config.projectId),
		summarizeAgents(sdk, config.projectId),
		sdk.listReleases(config.projectId),
		sdk.listSharePackages(config.projectId),
	]);

	const workstreamPayload = workstreams.payload ?? [];
	const releasePayload = releases.payload ?? [];
	const packagePayload = packages.payload ?? [];
	const failedWorkstream = workstreamPayload.find((entry) => entry.verificationStatus === 'failed');
	const releaseReady = releasePayload.find((entry) => entry.state === 'ready_to_publish');
	const publishingDraft = packagePayload.find((entry) => entry.state === 'ready_to_publish' || entry.state === 'published');
	let projectConnection: ProjectOverviewSummary['connection'] = {
		projectId: config.projectId,
		connection: null,
		connected: true,
		hubMode: null,
		runtimeMode: null,
		runtimeRegistration: null,
		runtimeAttached: false,
		runtimeReady: true,
		runnerReady: true,
		projectApiReady: true,
		mode: 'disconnected',
	};
	try {
		const deployConfig = loadCliDeployConfig(config.repoRoot);
		const runtimeMode = deployConfig.runtime?.mode ?? 'none';
		const runtimeRegistration = deployConfig.runtime?.registration ?? 'none';
		const registrationEnabled = runtimeRegistration === 'optional' || runtimeRegistration === 'required';
		const { configPath } = getMachineConfigPaths(config.repoRoot);
		const machineConfig = configPath ? loadMachineConfig(config.repoRoot) : null;
		const marketSettings = machineConfig?.settings?.market && typeof machineConfig.settings.market === 'object'
			? machineConfig.settings.market as Record<string, unknown>
			: null;
		const runnerHostId = typeof marketSettings?.runnerHostId === 'string' && marketSettings.runnerHostId.trim()
			? marketSettings.runnerHostId.trim()
			: (typeof marketSettings?.projectId === 'string' && marketSettings.projectId.trim()
				? `operations-runner:${marketSettings.projectId.trim()}`
				: null);
		const runnerSession = runnerHostId ? resolveRemoteSession(config.repoRoot, runnerHostId) : null;
		const runtimeReady = runtimeMode === 'none'
			|| !registrationEnabled
			|| Boolean(
				marketSettings?.runnerReady === true
				|| (typeof runnerSession?.accessToken === 'string' && runnerSession.accessToken.length > 0),
			);
		projectConnection = {
			projectId: config.projectId,
			connection: null,
			connected: true,
			hubMode: deployConfig.hub?.mode ?? null,
			runtimeMode,
			runtimeRegistration,
			runtimeAttached: runtimeMode !== 'none' && (!registrationEnabled || Boolean(marketSettings?.projectId)),
			runtimeReady,
			runnerReady: runtimeReady,
			projectApiReady: deployConfig.runtime?.mode !== 'none',
			mode: runtimeMode === 'treeseed_managed'
				? 'hosted'
				: runtimeMode === 'byo_attached'
					? (registrationEnabled ? 'hybrid' : 'self_hosted')
					: 'disconnected',
		};
	} catch {
		// Keep summary available even when deploy config or machine config is missing.
	}
	const health = failedWorkstream
		? { state: 'verification_failing', label: 'Verification failing', reason: failedWorkstream.verificationSummary ?? 'A workstream verification failed.' }
		: releaseReady
			? { state: 'release_ready', label: 'Release ready', reason: 'A release candidate is ready for approval.' }
			: publishingDraft
				? { state: 'sharing_draft', label: 'Sharing draft', reason: 'A share package is ready for publishing.' }
				: { state: 'working_normally', label: 'Working normally', reason: 'Project workstreams and agents are operating normally.' };

	const recentActivity = [
		...workstreamPayload.map((entry) => ({
			kind: 'workstream',
			id: entry.id,
			title: entry.title,
			status: entry.state,
			timestamp: entry.updatedAt,
			summary: entry.summary ?? entry.verificationSummary,
			metadata: { branchName: entry.branchName, linkedItems: entry.linkedItems },
		})),
		...releasePayload.map((entry) => ({
			kind: 'release',
			id: entry.id,
			title: entry.title ?? entry.version,
			status: entry.state,
			timestamp: entry.updatedAt,
			summary: entry.summary,
			metadata: { version: entry.version, releaseTag: entry.releaseTag },
		})),
		...agents.messages.map((entry) => ({
			kind: 'agent_message',
			id: entry.id,
			title: entry.type,
			status: entry.status,
			timestamp: entry.createdAt,
			summary: entry.summary,
			metadata: entry.metadata ?? {},
		})),
	].sort((left, right) => String(right.timestamp ?? '').localeCompare(String(left.timestamp ?? ''))).slice(0, 20);

	return {
		projectId: config.projectId,
		teamId: String(principal?.metadata?.teamId ?? config.projectId),
		health,
		counts: {
			objectives: direct.objectiveCount,
			questions: direct.questionCount,
			notes: direct.noteCount,
			proposals: direct.proposalCount,
			decisions: direct.decisionCount,
			activeWorkstreams: workstreamPayload.filter((entry) => entry.state !== 'archived').length,
			agents: agents.agents.length,
			releases: releasePayload.length,
		},
		connection: {
			...projectConnection,
		},
		nextBestAction: releaseReady
			? 'Review the ready release and decide whether to publish.'
			: failedWorkstream
				? 'Inspect the latest failed verification and update the workstream.'
				: 'Open Direct or Workstreams to continue work.',
		recentActivity,
	};
}
