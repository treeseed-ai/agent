import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

import { rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	callAgentTool,
} from '../../../../../src/agents/tools/agent-tool-runtime.ts';

import { callAgentToolWithTelemetry } from '../../../../../src/agents/tools/agent-tool-telemetry.ts';

import type { ExecutionProviderToolDescriptor } from '../../../../../src/agents/runtime/runtime-types.ts';

import { createAssignmentToolCatalog } from '../../../../../src/provider/commerce/catalog/assignment-tool-catalog.ts';

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

it('reads and searches only bounded assignment repository paths', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-repository-tools-'));
		tempRoots.push(root);
		execFileSync('git', ['init', '-b', 'main'], { cwd: root });
		execFileSync('git', ['config', 'user.email', 'agent-tool@example.test'], { cwd: root });
		execFileSync('git', ['config', 'user.name', 'Agent Tool'], { cwd: root });
		mkdirSync(join(root, 'src/private'), { recursive: true });
		writeFileSync(join(root, 'src/scheduler.ts'), 'export const scheduler = \"weighted-deficit\";\\n', 'utf8');
		writeFileSync(join(root, 'src/private/secret.ts'), 'export const secret = true;\\n', 'utf8');
		execFileSync('git', ['add', '.'], { cwd: root });
		execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
		const catalog = createAssignmentToolCatalog({
			agentTools: ['treeseed.repository.read_file', 'treeseed.repository.search'],
			projectId: 'project-1',
			assignmentId: 'assignment-1',
			treedxProxyHandle: {},
			allowedPaths: ['src/**'],
			forbiddenPaths: ['src/private/**'],
		});
		const options = {
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: catalog.descriptors,
			repoRoot: root,
		};
		await expect(callAgentTool(options, 'treeseed.repository.read_file', {
			path: 'src/scheduler.ts',
		})).resolves.toMatchObject({
			ok: true,
			payload: { path: 'src/scheduler.ts', content: expect.stringContaining('weighted-deficit'), truncated: false },
		});
		await expect(callAgentTool(options, 'treeseed.repository.search', {
			query: 'weighted-deficit',
			paths: ['src'],
		})).resolves.toMatchObject({
			ok: true,
			payload: { matches: [{ path: 'src/scheduler.ts', match: expect.stringContaining('weighted-deficit') }] },
		});
		await expect(callAgentTool(options, 'treeseed.repository.read_file', {
			path: 'src/private/secret.ts',
		})).resolves.toMatchObject({ ok: false, code: 'path_forbidden' });
		await expect(callAgentTool(options, 'treeseed.repository.read_file', {
			path: '../outside',
		})).resolves.toMatchObject({ ok: false, code: 'repository_path_invalid' });
	});

it('emits redacted telemetry for tool calls', async () => {
		const telemetry: unknown[] = [];
		const dispatch = vi.fn(async () => ({ ok: true, mode: 'inline', payload: { token: 'not-input' } }));
		await callAgentToolWithTelemetry({
			apiBaseUrl: '',
			providerAccessToken: '',
			assignmentId: 'assignment-1',
			descriptors: [statusDescriptor()],
			sdk: { dispatch },
			onTelemetry: (entry) => telemetry.push(entry),
		}, 'treeseed.status');
		expect(telemetry).toHaveLength(2);
		expect(telemetry.at(-1)).toMatchObject({
			toolId: 'treeseed.status',
			status: 'completed',
		});
	});
});
