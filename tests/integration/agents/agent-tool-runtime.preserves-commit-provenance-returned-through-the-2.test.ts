import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

import { rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	callAgentTool,
} from '../../../src/agents/tools/agent-tool-runtime.ts';

import { callAgentToolWithTelemetry } from '../../../src/agents/tools/agent-tool-telemetry.ts';

import type { ExecutionProviderToolDescriptor } from '../../../src/agents/runtime-types.ts';

import { createAssignmentToolCatalog } from '../../../src/provider/assignment-tool-catalog.ts';

import { AgentSdk } from '@treeseed/sdk/sdk';

const tempRoots: string[] = [];

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
				allowedOperations: ['files:write', 'git:commit'],
				allowedPaths: ['docs/src/content/**'],
				allowedWritePaths: ['docs/src/content', 'docs/src/content/**'],
			},
			contentAccess: {
				read: { models: ['note'], actions: ['read'] },
				write: { models: ['note'], actions: ['create'] },
				commit: { allowed: true },
			},
			allowedPaths: ['docs/src/content/**'],
			forbiddenPaths: [],
		});
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
			ok: true,
			payload: {
				ok: true,
				status: 'committed',
				commitSha: 'abc123',
				branchName: 'refs/heads/agent-work',
			},
		}), { status: 200 })) as unknown as typeof fetch;
		const telemetry: Array<Record<string, unknown>> = [];

		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test',
			providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			fetchImpl,
			onTelemetry: (entry) => telemetry.push(entry as unknown as Record<string, unknown>),
		}, 'treeseed.content.commit', { message: 'Persist planning note' })).resolves.toMatchObject({ ok: true });
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
				allowedOperations: ['files:write', 'git:commit'],
				allowedPaths: ['docs/**'], allowedWritePaths: ['docs', 'docs/**'],
			},
			contentAccess: {
				read: { models: ['note'], actions: ['read'] },
				write: { models: ['note'], actions: ['create', 'link'] },
				commit: { allowed: true },
			},
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
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, payload: {
			status: 'committed', commitSha: 'abc123', branchName: 'refs/heads/agent-work',
		} }), { status: 200 })) as unknown as typeof fetch;
		writeFileSync(telemetryPath, `${JSON.stringify({
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'note', path: 'docs/src/content/notes/release.md' } }],
		})}\n`, 'utf8');

		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1', descriptors: [descriptor], fetchImpl, telemetryPath,
		}, 'treeseed.content.commit', { message: 'Finalize documentation' })).resolves.toMatchObject({
			ok: false,
			code: 'content_completion_required_before_commit',
			metadata: { missingReceipts: [
				'content_subject_linked:docs/src/content/notes/release.md',
			] },
		});
		expect(fetchImpl).not.toHaveBeenCalled();

		writeFileSync(telemetryPath, `${JSON.stringify({
			status: 'completed',
			derivedEvents: [{ type: 'content_updated', contentRef: {
				model: 'note', path: 'docs/src/content/notes/release.md',
				subjectId: 'proposal:release-channel-normalization', subjectField: 'about',
			} }],
		})}\n`, 'utf8');
		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: 'https://api.example.test', providerAccessToken: 'provider-key',
			assignmentId: 'assignment-1', descriptors: [descriptor], fetchImpl, telemetryPath,
		}, 'treeseed.content.commit', { message: 'Finalize documentation' })).resolves.toMatchObject({ ok: true });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
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
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: [descriptor!],
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
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: [descriptor!],
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
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
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
			treedxProxyHandle: {},
		});
		const telemetry: Array<Record<string, unknown>> = [];
		await expect(callAgentToolWithTelemetry({
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			onTelemetry: (entry) => telemetry.push(entry as unknown as Record<string, unknown>),
		}, 'treeseed.review_decision', {
			disposition: 'rejected',
			summary: 'The implementation needs a bounded recovery correction.',
		})).resolves.toMatchObject({
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
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: [changedPathsDescriptor(root)],
		}, 'treeseed.changed_paths');
		expect(result).toMatchObject({ ok: false, code: 'path_forbidden' });
	});
});
