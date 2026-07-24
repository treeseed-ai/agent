import type { Hono } from 'hono';
import type { AgentSdk } from '@treeseed/sdk';
import { buildKnowledgePackMarketPackage, buildTemplateMarketPackage, WorkflowSdk } from '@treeseed/sdk';
import type { WorkstreamSummary } from '@treeseed/sdk';
import { checkCodexProviderReadiness } from '../../../agents/adapters/codex/codex-readiness.ts';
import { requireTeamCapability } from '../../support/capabilities.ts';
import { jsonError } from '../../support/http.ts';
import { nowIso, readOptionalString, routeParam, slugify, withPrefix } from './project-route-helpers.ts';
import { summarizeAgents, summarizeDirect, summarizeProject } from './project-summary.ts';
import type { ApiConfig } from '../../types.ts';

export function registerProjectRoutes(
	app: Hono<any>,
	options: {
		config: ApiConfig;
		sharedSdk: AgentSdk;
		prefix?: string;
	},
) {
	const prefix = options.prefix ?? '';
	const workflow = new WorkflowSdk({
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
		const workstreamId = routeParam(c, 'id');
		const detail = await options.sharedSdk.getWorkstream(workstreamId);
		if (!detail.payload) return jsonError(c, 404, `Unknown workstream "${workstreamId}".`);
		return c.json({ ok: true, payload: detail.payload });
	});

	app.post(withPrefix(prefix, '/v1/workstreams/:id/save'), async (c) => {
		const unauthorized = requireTeamCapability(c, 'manage_workstreams');
		if (unauthorized) return unauthorized;
		const workstreamId = routeParam(c, 'id');
		const existing = await options.sharedSdk.getWorkstream(workstreamId);
		if (!existing.payload) return jsonError(c, 404, `Unknown workstream "${workstreamId}".`);
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
		const workstreamId = routeParam(c, 'id');
		const existing = await options.sharedSdk.getWorkstream(workstreamId);
		if (!existing.payload) return jsonError(c, 404, `Unknown workstream "${workstreamId}".`);
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
		const workstreamId = routeParam(c, 'id');
		const existing = await options.sharedSdk.getWorkstream(workstreamId);
		if (!existing.payload) return jsonError(c, 404, `Unknown workstream "${workstreamId}".`);
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
		const releaseId = routeParam(c, 'id');
		const release = await options.sharedSdk.getRelease(releaseId);
		if (!release.payload) return jsonError(c, 404, `Unknown release "${releaseId}".`);
		return c.json({ ok: true, payload: release.payload });
	});

	app.post(withPrefix(prefix, '/v1/releases/:id/publish'), async (c) => {
		const unauthorized = requireTeamCapability(c, 'publish_releases');
		if (unauthorized) return unauthorized;
		const releaseId = routeParam(c, 'id');
		const release = await options.sharedSdk.getRelease(releaseId);
		if (!release.payload) return jsonError(c, 404, `Unknown release "${releaseId}".`);
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
		const releaseId = routeParam(c, 'id');
		const release = await options.sharedSdk.getRelease(releaseId);
		if (!release.payload) return jsonError(c, 404, `Unknown release "${releaseId}".`);
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
				? buildTemplateMarketPackage(options.config.repoRoot, {
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
					? buildKnowledgePackMarketPackage(options.config.repoRoot, {
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

	app.get(withPrefix(prefix, '/v1/providers/codex/readiness'), async (c) => {
		const principal = c.get('principal');
		if (!principal) return jsonError(c, 401, 'Authentication required.');
		return c.json({
			ok: true,
			payload: checkCodexProviderReadiness({ env: process.env }),
		});
	});
}

