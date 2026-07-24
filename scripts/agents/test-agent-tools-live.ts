import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkCodexProviderReadiness } from '../../src/agents/adapters/codex/codex-readiness.ts';
import { runCodexTask } from '../../src/agents/adapters/codex/execution-codex.ts';
import { createIsolatedCodexRuntimeHome } from '../../src/agents/adapters/runtime/codex-runtime-home.ts';
import type { ExecutionProviderToolDescriptor } from '../../src/agents/runtime/runtime-types.ts';

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8', env: process.env });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
	}
	return result.stdout;
}

function readTelemetry(path: string) {
	if (!existsSync(path)) return [];
	return readFileSync(path, 'utf8')
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rawMcpToolCalls(result: { metadata?: Record<string, unknown> | undefined }) {
	const rawItems = result.metadata?.rawItems;
	return Array.isArray(rawItems)
		? rawItems.filter((item): item is Record<string, unknown> =>
				item !== null && typeof item === 'object' && !Array.isArray(item) && item.type === 'mcp_tool_call',
			)
		: [];
}

function successfulRawMcpToolCall(result: { metadata?: Record<string, unknown> | undefined }, toolName: string) {
	const normalized = toolName.replace(/\./gu, '_');
	return rawMcpToolCalls(result).find((item) => {
		if (!(item.tool === toolName || item.tool === normalized)) return false;
		if (item.status === 'failed' || item.error) return false;
		const rawResult = item.result && typeof item.result === 'object' && !Array.isArray(item.result) ? item.result as Record<string, unknown> : {};
		const structured = rawResult.structured_content && typeof rawResult.structured_content === 'object' && !Array.isArray(rawResult.structured_content)
			? rawResult.structured_content as Record<string, unknown>
			: null;
		return structured?.ok !== false;
	}) ?? null;
}

function structuredPayloadFromRawCall(call: Record<string, unknown> | null) {
	const rawResult = call?.result && typeof call.result === 'object' && !Array.isArray(call.result) ? call.result as Record<string, unknown> : {};
	const structured = rawResult.structured_content && typeof rawResult.structured_content === 'object' && !Array.isArray(rawResult.structured_content)
		? rawResult.structured_content as Record<string, unknown>
		: {};
	const payload = structured.payload && typeof structured.payload === 'object' && !Array.isArray(structured.payload)
		? structured.payload as Record<string, unknown>
		: {};
	return payload;
}

function descriptor(id: string, inputSchema: Record<string, unknown>, metadata: Record<string, unknown>): ExecutionProviderToolDescriptor {
	return {
		kind: 'agent_tool',
		id,
		name: id,
		description: `Live test tool ${id}`,
		inputSchema,
		outputSchema: { type: 'object', additionalProperties: true },
		executionTarget: id === 'treeseed.changed_paths' ? 'provider_runner' : 'sdk_dispatch',
		mutability: id === 'treeseed.changed_paths' ? 'read' : 'read',
		metadata,
	};
}

if (process.env.TREESEED_AGENT_LIVE_CODEX !== '1') {
	throw new Error('Set TREESEED_AGENT_LIVE_CODEX=1 to run live Codex agent-tool acceptance.');
}

const readiness = checkCodexProviderReadiness();
if (!readiness.ok) {
	throw new Error(`Codex readiness failed: ${readiness.blockingIssues.join('; ')}`);
}

const previousAuthFile = process.env.TREESEED_CODEX_AUTH_FILE;
const previousCodexHome = process.env.CODEX_HOME;
const liveHome = await createIsolatedCodexRuntimeHome({
	serviceTier: process.env.TREESEED_CODEX_SERVICE_TIER === 'fast' ? 'fast' : undefined,
	model: readiness.defaultModel,
});
process.env.TREESEED_CODEX_AUTH_FILE = liveHome.authFile;
process.env.CODEX_HOME = liveHome.codexHome;

const tempRoot = mkdtempSync(join(tmpdir(), 'treeseed-agent-tools-live-'));
const repoRoot = join(tempRoot, 'repo');
const reportRoot = resolve(process.cwd(), '.treeseed', 'test-reports', 'agent-tools-live');
mkdirSync(repoRoot, { recursive: true });
mkdirSync(reportRoot, { recursive: true });
try {
	run('git', ['init', '-b', 'main'], repoRoot);
	run('git', ['config', 'user.email', 'agent-tools-live@example.test'], repoRoot);
	run('git', ['config', 'user.name', 'Agent Tools Live'], repoRoot);
	mkdirSync(join(repoRoot, 'live-output'), { recursive: true });
	writeFileSync(join(repoRoot, 'live-output', '.gitkeep'), '', 'utf8');
	writeFileSync(join(repoRoot, 'README.md'), '# Agent tools live repo\n', 'utf8');
	writeFileSync(join(repoRoot, 'treeseed.site.yaml'), [
		'name: Agent Tools Live',
		'slug: agent-tools-live',
		'siteUrl: https://example.test',
		'contactEmail: agent-tools-live@example.test',
		'',
	].join('\n'), 'utf8');
	run('git', ['add', '.'], repoRoot);
	run('git', ['commit', '-m', 'live test baseline'], repoRoot);

	const readOnlyTelemetryPath = join(tempRoot, 'readonly-tools.jsonl');
	const statusTool = descriptor('treeseed.status', { type: 'object', properties: {}, additionalProperties: false }, {
		assignmentId: 'live-readonly-assignment',
		projectId: 'live-project',
		dispatchPreferredMode: 'prefer_local',
		telemetryCategory: 'treeseed',
	});
	const readOnly = await runCodexTask({
		taskId: 'live-agent-tools-readonly',
		agentSlug: 'live-agent-tools',
		repoRoot,
		prompt: [
			'Use the available TreeSeed MCP tools.',
			'Call treeseed.status exactly once, then summarize the result in one short paragraph.',
			'Do not print credentials or environment variables.',
		].join('\n'),
		allowedPaths: ['**'],
		forbiddenPaths: ['.git/**', '.treeseed/secrets/**', 'node_modules/**'],
		sandboxMode: 'read_only',
		approvalPolicy: 'never',
		model: readiness.defaultModel,
		timeoutMs: readiness.timeoutMs,
		tools: [statusTool],
		leaseToken: 'live-readonly-lease',
		toolTelemetryPath: readOnlyTelemetryPath,
		metadata: { subscriptionPlan: readiness.subscriptionPlan },
	});
	const readOnlyTelemetry = readTelemetry(readOnlyTelemetryPath);
	if (readOnly.status !== 'completed') {
		throw new Error(`Read-only live Codex tool test failed: ${readOnly.summary ?? readOnly.error?.message ?? 'unknown'}`);
	}
	if (!readOnlyTelemetry.some((entry) => entry.toolId === 'treeseed.status' && entry.status === 'completed')
		&& !successfulRawMcpToolCall(readOnly, 'treeseed.status')) {
		throw new Error(`Read-only live Codex test did not receive a treeseed.status tool call. Status: ${readOnly.status}. Summary: ${readOnly.summary ?? 'none'}`);
	}

	const worktreeTelemetryPath = join(tempRoot, 'worktree-tools.jsonl');
	const changedPathsTool = descriptor('treeseed.changed_paths', {
		type: 'object',
		properties: { includeDiffSummary: { type: 'boolean' } },
		additionalProperties: false,
	}, {
		assignmentId: 'live-worktree-assignment',
		projectId: 'live-project',
		worktreeRoot: repoRoot,
		allowedPaths: ['live-output/**', '.treeseed/**'],
		forbiddenPaths: ['.git/**', '.treeseed/secrets/**'],
		telemetryCategory: 'repository',
	});
	const worktree = await runCodexTask({
		taskId: 'live-agent-tools-worktree',
		agentSlug: 'live-agent-tools',
		repoRoot,
		worktreeRoot: repoRoot,
		prompt: [
			'Create or update live-output/codex-tool-proof.txt with one sentence.',
			'Then call treeseed.changed_paths with includeDiffSummary true.',
			'Finish with the changed path list only.',
		].join('\n'),
		allowedPaths: ['live-output/**'],
		forbiddenPaths: ['.git/**', '.treeseed/secrets/**', 'node_modules/**'],
		sandboxMode: 'workspace_write',
		approvalPolicy: 'never',
		model: readiness.defaultModel,
		timeoutMs: readiness.timeoutMs,
		tools: [changedPathsTool],
		leaseToken: 'live-worktree-lease',
		toolTelemetryPath: worktreeTelemetryPath,
		metadata: { subscriptionPlan: readiness.subscriptionPlan },
	});
	const worktreeTelemetry = readTelemetry(worktreeTelemetryPath);
	if (worktree.status !== 'completed') {
		throw new Error(`Worktree live Codex tool test failed: ${worktree.summary ?? worktree.error?.message ?? 'unknown'}`);
	}
	const changedPathsCall = successfulRawMcpToolCall(worktree, 'treeseed.changed_paths');
	if (!worktreeTelemetry.some((entry) => entry.toolId === 'treeseed.changed_paths' && entry.status === 'completed')
		&& !changedPathsCall) {
		throw new Error(`Worktree live Codex test did not complete a treeseed.changed_paths tool call. Status: ${worktree.status}. Summary: ${worktree.summary ?? 'none'}`);
	}
	const changedPathsPayload = structuredPayloadFromRawCall(changedPathsCall);
	const changedPaths = Array.isArray(changedPathsPayload.changedPaths) ? changedPathsPayload.changedPaths.map(String) : [];
	if (!changedPaths.some((entry) => entry === 'live-output/codex-tool-proof.txt')) {
		throw new Error(`Worktree live Codex changed_paths did not include live-output/codex-tool-proof.txt. Observed: ${changedPaths.join(', ') || '<none>'}`);
	}

	const report = {
		ok: true,
		generatedAt: new Date().toISOString(),
		readiness: {
			authMode: readiness.authMode,
			defaultModel: readiness.defaultModel,
			subscriptionPlan: readiness.subscriptionPlan,
			warnings: readiness.warnings,
		},
		readOnly: {
			status: readOnly.status,
			threadId: readOnly.threadId,
			summary: readOnly.summary,
			rawMcpToolCalls: rawMcpToolCalls(readOnly),
			telemetry: readOnlyTelemetry,
		},
		worktree: {
			status: worktree.status,
			threadId: worktree.threadId,
			summary: worktree.summary,
			changedPaths: worktree.changedPaths,
			rawMcpToolCalls: rawMcpToolCalls(worktree),
			telemetry: worktreeTelemetry,
		},
	};
	await writeFile(join(reportRoot, 'latest.json'), JSON.stringify(report, null, 2), 'utf8');
	console.log(`Live agent-tool Codex proof passed. Report: ${join(reportRoot, 'latest.json')}`);
} catch (error) {
	await writeFile(join(reportRoot, 'latest.json'), JSON.stringify({
		ok: false,
		generatedAt: new Date().toISOString(),
		error: error instanceof Error ? error.message : String(error),
	}, null, 2), 'utf8');
	throw error;
} finally {
	if (previousAuthFile === undefined) delete process.env.TREESEED_CODEX_AUTH_FILE;
	else process.env.TREESEED_CODEX_AUTH_FILE = previousAuthFile;
	if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = previousCodexHome;
	await liveHome.cleanup();
	await rm(tempRoot, { recursive: true, force: true });
}
