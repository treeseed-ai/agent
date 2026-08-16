import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

import { rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	callAgentTool,
} from '../../../../../src/agents/tools/agent-tool-runtime.ts';

import { callAgentToolWithTelemetry } from '../../../../../src/agents/tools/agent-tool-telemetry.ts';

import { hasAssignmentPlan } from '../../../../../src/agents/tools/assignment/operational-content-tool.ts';

import type { ExecutionProviderToolDescriptor } from '../../../../../src/agents/runtime/runtime-types.ts';

import { createAssignmentToolCatalog } from '../../../../../src/provider/commerce/catalog/assignment-tool-catalog.ts';

import { AgentSdk } from '@treeseed/sdk/sdk';

const tempRoots: string[] = [];

function assignmentStatusEnvelope() {
	return { ok: true, payload: {
		id: 'assignment-1', teamId: 'team-1', projectId: 'project-1', workDayId: 'workday-1',
		stateVersion: 2, status: 'leased', leaseState: 'leased', assignedAt: '2026-08-14T00:00:00.000Z',
		capacityEnvelope: { reservedSeconds: 900, budget: { time: { hardDeadlineAt: '2099-01-01T00:00:00.000Z' } } },
		decisionInput: { input: { activityType: 'planning' } }, metadata: { workdayRunId: 'run-1' },
	} };
}

const planContent = '---\nschemaVersion: treeseed.assignment-plan/v1\nid: assignment-1\nassignmentId: assignment-1\nstatus: ready\nrevision: 1\nobjective: Complete the assignment.\ncompleted: []\nremaining: []\nrisks: []\ncreatedAt: 2026-08-14T00:00:00.000Z\nupdatedAt: 2026-08-14T00:00:00.000Z\nteamId: team-1\nprojectId: project-1\n---\n';

function assignmentRuntimeFetch(finalPayload: Record<string, unknown>) {
	return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		if (String(url).includes('/v1/provider/assignments/')) return new Response(JSON.stringify(assignmentStatusEnvelope()), { status: 200 });
		if (init?.method === 'GET') return new Response(JSON.stringify({ content: planContent }), { status: 200 });
		return new Response(JSON.stringify(finalPayload), { status: 200 });
	}) as unknown as typeof fetch;
}

function statusDescriptor(overrides: Partial<ExecutionProviderToolDescriptor> = {}): ExecutionProviderToolDescriptor {
	return {
		kind: 'agent_tool',
		id: 'treeseed.status',
		name: 'TreeSeed status',
		description: 'Status',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		outputSchema: { type: 'object', additionalProperties: true },
		executionTarget: 'sdk_dispatch',
		mutability: 'read',
		metadata: {
			assignmentId: 'assignment-1',
			projectId: 'project-1',
			dispatchPreferredMode: 'auto',
			telemetryCategory: 'treeseed',
		},
		...overrides,
	};
}

function changedPathsDescriptor(worktreeRoot: string): ExecutionProviderToolDescriptor {
	return {
		kind: 'agent_tool',
		id: 'treeseed.changed_paths',
		name: 'Changed paths',
		description: 'Changed paths',
		inputSchema: {
			type: 'object',
			properties: { includeDiffSummary: { type: 'boolean' } },
			additionalProperties: false,
		},
		outputSchema: { type: 'object', additionalProperties: true },
		executionTarget: 'provider_runner',
		mutability: 'read',
		metadata: {
			assignmentId: 'assignment-1',
			projectId: 'project-1',
			worktreeRoot,
			allowedPaths: ['src/content/**'],
			forbiddenPaths: ['src/content/private/**'],
			telemetryCategory: 'repository',
		},
	};
}
describe('agent tool runtime', () => {
afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

it('preserves commit provenance returned through the TreeDX proxy envelope', async () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.content.commit'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			workspaceMode: 'workspace_write',
			treedxProxyHandle: {
				id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1',
				repositoryId: 'repo-1', workspaceId: 'workspace-1',
				status: 'active',
				allowedOperations: ['files:read', 'files:write', 'git:commit'],
				allowedPaths: ['docs/src/content/**'],
				allowedWritePaths: ['docs/src/content', 'docs/src/content/**'],
			},
			permissionProjection: {
				read: { models: ['note'], actions: ['read'] },
				write: { models: ['note'], actions: ['create'] },
				commit: { allowed: true },
			},
			allowedPaths: ['docs/src/content/**'],
			forbiddenPaths: [],
		});
		const fetchImpl = assignmentRuntimeFetch({
			ok: true,
			payload: {
				ok: true,
				status: 'committed',
				commitSha: 'abc123',
				branchName: 'refs/heads/agent-work',
			},
		});
		const telemetry: Array<Record<string, unknown>> = [];

		const commitResult = await callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			fetchImpl,
			onTelemetry: (entry) => telemetry.push(entry as unknown as Record<string, unknown>),
		}, 'treeseed.content.commit', { message: 'Persist planning note' });
		expect(commitResult, JSON.stringify(commitResult)).toMatchObject({ ok: true });
		expect(telemetry.at(-1)).toMatchObject({
			derivedEvents: [{
				type: 'content_committed',
				commitSha: 'abc123',
				branchRef: 'refs/heads/agent-work',
			}],
		});
	});

it('blocks workspace finalization until the required linked content artifact exists', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-precommit-'));
		tempRoots.push(root);
		const telemetryPath = join(root, 'events.jsonl');
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.content.commit'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			workspaceMode: 'workspace_write',
			treedxProxyHandle: {
				id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1',
				repositoryId: 'repo-1', workspaceId: 'workspace-1', status: 'active',
				allowedOperations: ['files:read', 'files:write', 'git:commit'],
				allowedPaths: ['docs/**'], allowedWritePaths: ['docs', 'docs/**'],
			},
			permissionProjection: {
				read: { models: ['note'], actions: ['read'] },
				write: { models: ['note'], actions: ['create', 'link'] },
				commit: { allowed: true },
			},
			contentRoot: 'docs/src/content',
			allowedPaths: ['docs/**'], forbiddenPaths: [],
		});
		const commit = catalog.descriptors.find((entry) => entry.id === 'treeseed.content.commit')!;
		const descriptor = {
			...commit,
			metadata: {
				...(commit.metadata ?? {}),
				requiredArtifactKind: 'documentation_update',
				requireContentArtifact: true,
			},
		};
		const assignmentPlan = catalog.descriptors.find((entry) => entry.id === 'treeseed.assignment_plan')!;
		expect(assignmentPlan).toBeDefined();
		const fetchImpl = assignmentRuntimeFetch({ ok: true, payload: {
			status: 'committed', commitSha: 'abc123', branchName: 'refs/heads/agent-work',
		} });
		writeFileSync(telemetryPath, `${JSON.stringify({
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'note', path: 'docs/src/content/notes/release.md' } }],
		})}\n${JSON.stringify({ toolId: 'treeseed.assignment_plan', status: 'completed', inputSummary: { action: 'write' }, derivedEvents: [] })}\n${JSON.stringify({ toolId: 'treeseed.assignment_status_update', status: 'completed', inputSummary: { status: 'completed' }, derivedEvents: [] })}\n${JSON.stringify({ toolId: 'treeseed.assignment_summary', status: 'completed', inputSummary: { action: 'write', status: 'completed' }, derivedEvents: [] })}\n`, 'utf8');

		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1', descriptors: [descriptor, assignmentPlan], fetchImpl, telemetryPath,
		}, 'treeseed.content.commit', { message: 'Finalize documentation' })).resolves.toMatchObject({
			ok: false,
			code: 'content_completion_required_before_commit',
			metadata: { missingReceipts: [
				'content_subject_linked:docs/src/content/notes/release.md',
			] },
		});
		expect(fetchImpl).not.toHaveBeenCalled();

		appendFileSync(telemetryPath, `${JSON.stringify({
			status: 'completed',
			derivedEvents: [{ type: 'content_updated', contentRef: {
				model: 'note', path: 'docs/src/content/notes/release.md',
				subjectId: 'proposal:release-channel-normalization', subjectField: 'about',
			} }],
		})}\n`, 'utf8');
		await expect(hasAssignmentPlan({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1', descriptors: [descriptor, assignmentPlan], fetchImpl,
		})).resolves.toBe(true);
		const committed = await callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1', descriptors: [descriptor, assignmentPlan], fetchImpl, telemetryPath,
		}, 'treeseed.content.commit', { message: 'Finalize documentation' });
		expect(committed, JSON.stringify(committed)).toMatchObject({ ok: true });
		expect(fetchImpl.mock.calls.filter(([url, init]) => String(url).includes('/commit') && init?.method === 'POST')).toHaveLength(1);
	});

it('runs bounded verification in the assignment worktree and accepts an expected failure', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-verify-'));
		tempRoots.push(root);
		mkdirSync(join(root, 'template'), { recursive: true });
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.verify'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
			worktreeRoot: root,
			allowedPaths: ['template/tests/**'],
		});
		const descriptor = catalog.descriptors.find((entry) => entry.id === 'treeseed.verify');
		expect(descriptor).toBeDefined();
		await expect(callAgentTool({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1',
			descriptors: [descriptor!],
			fetchImpl: assignmentRuntimeFetch({ ok: true }),
		}, 'treeseed.verify', {
			commands: [{
				command: 'node',
				args: ['-e', 'process.exit(3)'],
				cwd: 'template',
				expectedExitCode: 3,
			}],
		})).resolves.toMatchObject({
			ok: true,
			payload: {
				results: [expect.objectContaining({ command: 'node', cwd: 'template', exitCode: 3, expectedExitCode: 3, ok: true })],
			},
		});
		await expect(callAgentTool({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: [descriptor!],
			fetchImpl: assignmentRuntimeFetch({ ok: true }),
		}, 'treeseed.verify', {
			commands: [{ command: 'node', args: ['--version'], cwd: '../outside' }],
		})).resolves.toMatchObject({ ok: false, code: 'verification_cwd_invalid' });
	});

it('emits structured verification evidence for the artifact manifest', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-verify-telemetry-'));
		tempRoots.push(root);
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.verify'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
			worktreeRoot: root,
		});
		const telemetry: Array<Record<string, unknown>> = [];
		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			fetchImpl: assignmentRuntimeFetch({ ok: true }),
			onTelemetry: (entry) => telemetry.push(entry as unknown as Record<string, unknown>),
		}, 'treeseed.verify', {
			commands: [{ command: 'node', args: ['-e', 'process.exit(3)'], expectedExitCode: 3 }],
		})).resolves.toMatchObject({ ok: true });
		expect(telemetry.at(-1)).toMatchObject({
			status: 'completed',
			derivedEvents: [{
				type: 'verification_completed',
				status: 'passed',
				commands: ['node -e process.exit(3) (cwd: .)'],
			}],
		});
	});

it('records an explicit governed review disposition event', async () => {
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.review_decision'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {
				id: 'handle-1', teamId: 'team-1', projectId: 'project-1', assignmentId: 'assignment-1',
				repositoryId: 'repo-1', workspaceId: 'workspace-1', status: 'active',
				allowedOperations: ['files:read', 'files:write'], allowedPaths: ['src/content/**'],
			},
			workspaceMode: 'workspace_write',
		});
		const telemetry: Array<Record<string, unknown>> = [];
		expect(catalog.exposed).toContain('treeseed.assignment_plan');
		const planRead = await callAgentTool({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1', descriptors: catalog.descriptors,
			fetchImpl: assignmentRuntimeFetch({ ok: true }),
		}, 'treeseed.assignment_plan', { action: 'read' });
		expect(planRead, JSON.stringify(planRead)).toMatchObject({ ok: true });
		await expect(hasAssignmentPlan({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1', descriptors: catalog.descriptors,
			fetchImpl: assignmentRuntimeFetch({ ok: true }),
		})).resolves.toBe(true);
		const reviewResult = await callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			fetchImpl: assignmentRuntimeFetch({ ok: true }),
			onTelemetry: (entry) => telemetry.push(entry as unknown as Record<string, unknown>),
		}, 'treeseed.review_decision', {
			disposition: 'rejected',
			summary: 'The implementation needs a bounded recovery correction.',
		});
		expect(reviewResult, JSON.stringify(reviewResult)).toMatchObject({
			ok: true,
			payload: { disposition: 'rejected' },
		});
		expect(telemetry.at(-1)).toMatchObject({
			status: 'completed',
			derivedEvents: [{
				type: 'review_decision_recorded',
				disposition: 'rejected',
			}],
		});
	});

it('enforces changed path scope', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-tool-runtime-'));
		tempRoots.push(root);
		execFileSync('git', ['init', '-b', 'main'], { cwd: root });
		execFileSync('git', ['config', 'user.email', 'agent-tool@example.test'], { cwd: root });
		execFileSync('git', ['config', 'user.name', 'Agent Tool'], { cwd: root });
		mkdirSync(join(root, 'src/content/private'), { recursive: true });
		writeFileSync(join(root, 'src/content/private/secret.mdx'), 'secret\n', 'utf8');
		execFileSync('git', ['add', 'src/content/private/secret.mdx'], { cwd: root });
		const result = await callAgentTool({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: [changedPathsDescriptor(root)],
			fetchImpl: assignmentRuntimeFetch({ ok: true }),
		}, 'treeseed.changed_paths');
		expect(result).toMatchObject({ ok: false, code: 'path_forbidden' });
	});
});
