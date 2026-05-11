import type { Hono } from 'hono';
import type { AgentSdk } from '@treeseed/sdk';
import {
	buildKnowledgeCoopKnowledgePackPackage,
	buildKnowledgeCoopTemplatePackage,
	TreeseedWorkflowSdk,
} from '@treeseed/sdk';
import {
	getTreeseedMachineConfigPaths,
	loadCliDeployConfig,
	loadTreeseedMachineConfig,
	resolveTreeseedRemoteSession,
} from '@treeseed/sdk/workflow-support';
import type {
	AgentMessageKind,
	AgentMessageRecord,
	AgentStatusRecord,
	DirectBoardItemSummary,
	ProjectOverviewSummary,
	ReleaseDetail,
	ReleaseSummary,
	SharePackageStatus,
	WorkstreamDetail,
	WorkstreamState,
	WorkstreamSummary,
} from '@treeseed/sdk';
import { normalizeKnowledgeCoopJobStatus } from '@treeseed/sdk';
import { requireTeamCapability } from './capabilities.ts';
import { jsonError } from './http.ts';
import type { ApiConfig } from './types.ts';

function withPrefix(prefix: string, path: string) {
	if (!prefix) return path;
	return `${prefix}${path}`.replace(/\/{2,}/g, '/');
}

function slugify(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64) || 'change';
}

function nowIso() {
	return new Date().toISOString();
}

function asRecords(value: unknown) {
	return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return '';
}

function readOptionalString(record: Record<string, unknown>, ...keys: string[]) {
	const value = readString(record, ...keys);
	return value || null;
}

function inferMessageKind(type: string, status: string): AgentMessageKind {
	if (status === 'failed' || type.includes('failed')) return 'warning';
	if (type.includes('waiting') || type.includes('review') || type.includes('release')) return 'action_requested';
	if (type.includes('release_completed') || type.includes('task_verified')) return 'release_readiness';
	return 'informational';
}

async function summarizeDirect(sdk: AgentSdk, projectId: string) {
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

async function summarizeAgents(sdk: AgentSdk, projectId: string) {
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

async function summarizeProject(sdk: AgentSdk, config: ApiConfig, principal: { metadata?: Record<string, unknown> } | null): Promise<ProjectOverviewSummary> {
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
		const { configPath } = getTreeseedMachineConfigPaths(config.repoRoot);
		const machineConfig = configPath ? loadTreeseedMachineConfig(config.repoRoot) : null;
		const marketSettings = machineConfig?.settings?.market && typeof machineConfig.settings.market === 'object'
			? machineConfig.settings.market as Record<string, unknown>
			: null;
		const runnerHostId = typeof marketSettings?.runnerHostId === 'string' && marketSettings.runnerHostId.trim()
			? marketSettings.runnerHostId.trim()
			: (typeof marketSettings?.projectId === 'string' && marketSettings.projectId.trim()
				? `market-runner:${marketSettings.projectId.trim()}`
				: null);
		const runnerSession = runnerHostId ? resolveTreeseedRemoteSession(config.repoRoot, runnerHostId) : null;
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

export function registerProjectRoutes(
	app: Hono<any>,
	options: {
		config: ApiConfig;
		sharedSdk: AgentSdk;
		prefix?: string;
	},
) {
	const prefix = options.prefix ?? '';
	const workflow = new TreeseedWorkflowSdk({
		cwd: options.config.repoRoot,
		env: process.env,
		transport: 'api',
	});

	app.get(withPrefix(prefix, '/v1/project/summary'), async (c) => {
		const principal = c.get('principal');
		if (!principal) return jsonError(c, 401, 'Authentication required.');
		return c.json({
			ok: true,
			payload: await summarizeProject(options.sharedSdk, options.config, principal),
		});
	});

	app.get(withPrefix(prefix, '/v1/direct/summary'), async (c) => {
		const principal = c.get('principal');
		if (!principal) return jsonError(c, 401, 'Authentication required.');
		return c.json({ ok: true, payload: await summarizeDirect(options.sharedSdk, options.config.projectId) });
	});

	app.get(withPrefix(prefix, '/v1/workstreams'), async (c) => {
		const principal = c.get('principal');
		if (!principal) return jsonError(c, 401, 'Authentication required.');
		const items = await options.sharedSdk.listWorkstreams(options.config.projectId);
		return c.json({
			ok: true,
			payload: {
				projectId: options.config.projectId,
				items: items.payload,
				columns: ['Drafting', 'Active locally', 'Verifying', 'Saved remotely', 'In staging', 'Archived'],
			},
		});
	});

	app.post(withPrefix(prefix, '/v1/workstreams'), async (c) => {
		const unauthorized = requireTeamCapability(c, 'manage_workstreams');
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled change';
		const branchName = typeof body.branchName === 'string' && body.branchName.trim() ? body.branchName.trim() : `task/${slugify(title)}`;
		await workflow.switchTask({
			branchName,
			createIfMissing: true,
			preview: body.preview === true,
		});
		const workstream = await options.sharedSdk.upsertWorkstream({
			projectId: options.config.projectId,
			title,
			summary: typeof body.summary === 'string' ? body.summary : null,
			state: 'active_local',
			branchName,
			branchRef: `refs/heads/${branchName}`,
			owner: typeof body.owner === 'string' ? body.owner : c.get('principal')?.displayName ?? null,
			linkedItems: Array.isArray(body.linkedItems) ? body.linkedItems as WorkstreamSummary['linkedItems'] : [],
			metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata as Record<string, unknown> : {},
		});
		if (workstream.payload) {
			await options.sharedSdk.appendWorkstreamEvent({
				projectId: options.config.projectId,
				workstreamId: workstream.payload.id,
				kind: 'created',
				summary: 'Workstream created and branch activated.',
				data: { branchName },
			});
		}
		return c.json({ ok: true, payload: workstream.payload }, { status: 201 });
	});

	app.get(withPrefix(prefix, '/v1/workstreams/:id'), async (c) => {
		const principal = c.get('principal');
		if (!principal) return jsonError(c, 401, 'Authentication required.');
		const detail = await options.sharedSdk.getWorkstream(c.req.param('id'));
		if (!detail.payload) return jsonError(c, 404, `Unknown workstream "${c.req.param('id')}".`);
		return c.json({ ok: true, payload: detail.payload });
	});

	app.post(withPrefix(prefix, '/v1/workstreams/:id/save'), async (c) => {
		const unauthorized = requireTeamCapability(c, 'manage_workstreams');
		if (unauthorized) return unauthorized;
		const existing = await options.sharedSdk.getWorkstream(c.req.param('id'));
		if (!existing.payload) return jsonError(c, 404, `Unknown workstream "${c.req.param('id')}".`);
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await workflow.save({
			message: typeof body.message === 'string' && body.message.trim() ? body.message.trim() : `Save ${existing.payload.title}`,
			verify: body.verify !== false,
			refreshPreview: body.refreshPreview === true,
		});
		const updated = await options.sharedSdk.upsertWorkstream({
			...existing.payload,
			state: body.verify === false ? 'saved_remote' : 'verifying',
			lastSaveAt: nowIso(),
			verificationStatus: result.ok ? 'completed' : 'failed',
			verificationSummary: result.summary ?? null,
		});
		await options.sharedSdk.appendWorkstreamEvent({
			projectId: options.config.projectId,
			workstreamId: existing.payload.id,
			kind: 'saved',
			summary: result.summary ?? 'Workstream saved.',
			data: { workflow: result.payload ?? {} },
		});
		return c.json({ ok: true, payload: updated.payload });
	});

	app.post(withPrefix(prefix, '/v1/workstreams/:id/stage'), async (c) => {
		const unauthorized = requireTeamCapability(c, 'stage_releases');
		if (unauthorized) return unauthorized;
		const existing = await options.sharedSdk.getWorkstream(c.req.param('id'));
		if (!existing.payload) return jsonError(c, 404, `Unknown workstream "${c.req.param('id')}".`);
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await workflow.stage({
			message: typeof body.message === 'string' && body.message.trim() ? body.message.trim() : `Stage ${existing.payload.title}`,
		});
		const updated = await options.sharedSdk.upsertWorkstream({
			...existing.payload,
			state: 'in_staging',
			lastStageAt: nowIso(),
			verificationStatus: result.ok ? 'completed' : existing.payload.verificationStatus,
			verificationSummary: result.summary ?? existing.payload.verificationSummary,
		});
		await options.sharedSdk.appendWorkstreamEvent({
			projectId: options.config.projectId,
			workstreamId: existing.payload.id,
			kind: 'staged',
			summary: result.summary ?? 'Workstream moved to staging.',
			data: { workflow: result.payload ?? {} },
		});
		return c.json({ ok: true, payload: updated.payload });
	});

	app.post(withPrefix(prefix, '/v1/workstreams/:id/archive'), async (c) => {
		const unauthorized = requireTeamCapability(c, 'manage_workstreams');
		if (unauthorized) return unauthorized;
		const existing = await options.sharedSdk.getWorkstream(c.req.param('id'));
		if (!existing.payload) return jsonError(c, 404, `Unknown workstream "${c.req.param('id')}".`);
		const updated = await options.sharedSdk.upsertWorkstream({
			...existing.payload,
			state: 'archived',
			archivedAt: nowIso(),
		});
		await options.sharedSdk.appendWorkstreamEvent({
			projectId: options.config.projectId,
			workstreamId: existing.payload.id,
			kind: 'archived',
			summary: 'Workstream archived.',
			data: {},
		});
		return c.json({ ok: true, payload: updated.payload });
	});

	app.get(withPrefix(prefix, '/v1/releases'), async (c) => {
		const principal = c.get('principal');
		if (!principal) return jsonError(c, 401, 'Authentication required.');
		const releases = await options.sharedSdk.listReleases(options.config.projectId);
		const history = releases.payload;
		return c.json({
			ok: true,
			payload: {
				projectId: options.config.projectId,
				history,
				currentProd: history.find((entry) => entry.state === 'published') ?? null,
				stagingCandidates: history.filter((entry) => entry.state === 'ready_to_publish' || entry.state === 'waiting_on_verification'),
			},
		});
	});

	app.post(withPrefix(prefix, '/v1/releases'), async (c) => {
		const unauthorized = requireTeamCapability(c, 'stage_releases');
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const workstreams = await options.sharedSdk.listWorkstreams(options.config.projectId);
		const selectedIds = Array.isArray(body.workstreamIds)
			? body.workstreamIds.map(String)
			: workstreams.payload.filter((entry) => entry.state === 'in_staging').map((entry) => entry.id);
		const release = await options.sharedSdk.upsertRelease({
			projectId: options.config.projectId,
			version: typeof body.version === 'string' && body.version.trim() ? body.version.trim() : `draft-${Date.now()}`,
			title: typeof body.title === 'string' ? body.title : null,
			state: 'ready_to_publish',
			summary: typeof body.summary === 'string' ? body.summary : null,
			workstreamIds: selectedIds,
			items: selectedIds.map((workstreamId) => ({
				id: `${workstreamId}-item`,
				workstreamId,
				model: null,
				recordId: null,
				summary: 'Included workstream',
				createdAt: nowIso(),
				metadata: {},
			})),
		});
		return c.json({ ok: true, payload: release.payload }, { status: 201 });
	});

	app.get(withPrefix(prefix, '/v1/releases/:id'), async (c) => {
		const principal = c.get('principal');
		if (!principal) return jsonError(c, 401, 'Authentication required.');
		const release = await options.sharedSdk.getRelease(c.req.param('id'));
		if (!release.payload) return jsonError(c, 404, `Unknown release "${c.req.param('id')}".`);
		return c.json({ ok: true, payload: release.payload });
	});

	app.post(withPrefix(prefix, '/v1/releases/:id/publish'), async (c) => {
		const unauthorized = requireTeamCapability(c, 'publish_releases');
		if (unauthorized) return unauthorized;
		const release = await options.sharedSdk.getRelease(c.req.param('id'));
		if (!release.payload) return jsonError(c, 404, `Unknown release "${c.req.param('id')}".`);
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const workflowResult = await workflow.release({
			bump: body.bump === 'major' || body.bump === 'minor' ? body.bump : 'patch',
		});
		const updated = await options.sharedSdk.upsertRelease({
			...release.payload,
			state: 'published',
			publishedAt: nowIso(),
			releaseTag: readOptionalString((workflowResult.payload ?? {}) as Record<string, unknown>, 'version', 'releaseTag'),
		});
		return c.json({ ok: true, payload: updated.payload });
	});

	app.post(withPrefix(prefix, '/v1/releases/:id/rollback'), async (c) => {
		const unauthorized = requireTeamCapability(c, 'publish_releases');
		if (unauthorized) return unauthorized;
		const release = await options.sharedSdk.getRelease(c.req.param('id'));
		if (!release.payload) return jsonError(c, 404, `Unknown release "${c.req.param('id')}".`);
		const updated = await options.sharedSdk.upsertRelease({
			...release.payload,
			state: 'rolled_back',
			rolledBackAt: nowIso(),
		});
		return c.json({ ok: true, payload: updated.payload });
	});

	app.get(withPrefix(prefix, '/v1/share/status'), async (c) => {
		const principal = c.get('principal');
		if (!principal) return jsonError(c, 401, 'Authentication required.');
		const packages = await options.sharedSdk.listSharePackages(options.config.projectId);
		return c.json({
			ok: true,
			payload: {
				projectId: options.config.projectId,
				packages: packages.payload,
				listing: null,
				canPublish: packages.payload.some((entry) => entry.state === 'ready_to_publish' || entry.state === 'published'),
			},
		});
	});

	for (const [path, kind] of [
		['/v1/share/export', 'export'],
		['/v1/share/package-template', 'template'],
		['/v1/share/package-knowledge-pack', 'knowledge_pack'],
	] as const) {
		app.post(withPrefix(prefix, path), async (c) => {
			const unauthorized = requireTeamCapability(c, 'manage_products');
			if (unauthorized) return unauthorized;
			const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
			const exportResult = kind === 'export'
				? await workflow.export({
					directory: typeof body.directory === 'string' ? body.directory : undefined,
				})
				: null;
			const packageResult = kind === 'template'
				? buildKnowledgeCoopTemplatePackage(options.config.repoRoot, {
					id: typeof body.id === 'string' ? body.id : undefined,
					title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined,
					summary: typeof body.summary === 'string' ? body.summary : null,
					outputRoot: typeof body.outputRoot === 'string' ? body.outputRoot : null,
					projectSlug: typeof body.projectSlug === 'string' ? body.projectSlug : options.config.projectId,
					market: {
						publisherId: typeof c.get('principal')?.metadata?.teamId === 'string' ? c.get('principal').metadata.teamId : null,
						publisherName: typeof c.get('principal')?.displayName === 'string' ? c.get('principal').displayName : null,
						publishMetadata: {
							projectId: options.config.projectId,
							kind,
						},
					},
				})
				: kind === 'knowledge_pack'
					? buildKnowledgeCoopKnowledgePackPackage(options.config.repoRoot, {
						id: typeof body.id === 'string' ? body.id : undefined,
						title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined,
						summary: typeof body.summary === 'string' ? body.summary : null,
						outputRoot: typeof body.outputRoot === 'string' ? body.outputRoot : null,
						projectSlug: typeof body.projectSlug === 'string' ? body.projectSlug : options.config.projectId,
						includePaths: Array.isArray(body.includePaths) ? body.includePaths.map(String) : undefined,
						market: {
							publisherId: typeof c.get('principal')?.metadata?.teamId === 'string' ? c.get('principal').metadata.teamId : null,
							publisherName: typeof c.get('principal')?.displayName === 'string' ? c.get('principal').displayName : null,
							publishMetadata: {
								projectId: options.config.projectId,
								kind,
							},
						},
					})
					: null;
			const item = await options.sharedSdk.upsertSharePackage({
				projectId: options.config.projectId,
				kind,
				title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : `${kind}-${Date.now()}`,
				summary: kind === 'export'
					? exportResult?.summary ?? null
					: packageResult?.manifest.summary ?? null,
				state: 'ready_to_publish',
				version: kind === 'export' ? null : packageResult?.manifest.version ?? null,
				outputPath: kind === 'export'
					? readOptionalString((exportResult?.payload ?? {}) as Record<string, unknown>, 'path', 'outputPath', 'directory')
					: packageResult?.outputRoot ?? null,
				artifactKey: kind === 'export' ? null : packageResult?.payloadRoot ?? null,
				manifestKey: kind === 'export' ? null : packageResult?.manifestPath ?? null,
				metadata: kind === 'export'
					? (typeof exportResult?.payload === 'object' && exportResult.payload ? exportResult.payload as Record<string, unknown> : {})
					: {
						manifest: packageResult?.manifest ?? null,
						files: packageResult?.files ?? [],
						payloadRoot: packageResult?.payloadRoot ?? null,
					},
			});
			return c.json({ ok: true, payload: item.payload });
		});
	}

	app.post(withPrefix(prefix, '/v1/share/publish'), async (c) => {
		const unauthorized = requireTeamCapability(c, 'publish_market_listings');
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const sharePackage = typeof body.packageId === 'string' ? await options.sharedSdk.getSharePackage(body.packageId) : null;
		if (!sharePackage?.payload) {
			return jsonError(c, 404, 'Unknown share package.');
		}
		const updated = await options.sharedSdk.upsertSharePackage({
			...sharePackage.payload,
			state: 'published',
		});
		return c.json({ ok: true, payload: updated.payload });
	});

	app.get(withPrefix(prefix, '/v1/agents/status'), async (c) => {
		const principal = c.get('principal');
		if (!principal) return jsonError(c, 401, 'Authentication required.');
		const payload = await summarizeAgents(options.sharedSdk, options.config.projectId);
		return c.json({ ok: true, payload: { projectId: options.config.projectId, agents: payload.agents } });
	});

	app.get(withPrefix(prefix, '/v1/agents/messages'), async (c) => {
		const principal = c.get('principal');
		if (!principal) return jsonError(c, 401, 'Authentication required.');
		const payload = await summarizeAgents(options.sharedSdk, options.config.projectId);
		return c.json({ ok: true, payload: payload.messages });
	});
}
