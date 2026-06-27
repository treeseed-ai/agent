import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTreeseedManagedToolEnv, resolveTreeseedToolBinary } from '@treeseed/sdk/managed-dependencies';
import { resolveTreeseedLaunchEnvironment } from '@treeseed/sdk/workflow-support';
import { runTreeseedCopilotTask } from '@treeseed/sdk/copilot';
import { createCopilotAgentTools } from '../src/agents/tools/agent-tool-copilot.ts';
import type { ExecutionProviderToolDescriptor } from '../src/agents/runtime-types.ts';

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8', env: process.env });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
	}
	return result.stdout;
}

function readTelemetry(path: string) {
	try {
		return readFileSync(path, 'utf8')
			.split(/\r?\n/u)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

function changedPathsDescriptor(repoRoot: string, assignmentId: string): ExecutionProviderToolDescriptor {
	return {
		kind: 'agent_tool',
		id: 'treeseed.changed_paths',
		name: 'TreeSeed changed paths',
		description: 'List git changed paths for the assigned worktree.',
		inputSchema: {
			type: 'object',
			properties: { includeDiffSummary: { type: 'boolean' } },
			additionalProperties: false,
		},
		executionTarget: 'provider_runner',
		mutability: 'read',
		metadata: {
			assignmentId,
			projectId: 'live-copilot-project',
			worktreeRoot: repoRoot,
			allowedPaths: ['live-output/**'],
			forbiddenPaths: ['.git/**', '.treeseed/secrets/**'],
			telemetryCategory: 'repository',
		},
	};
}

async function runCopilotToolProof(input: {
	repoRoot: string;
	telemetryPath: string;
	assignmentId: string;
	prompt: string;
	env: NodeJS.ProcessEnv;
}) {
	const env = createTreeseedManagedToolEnv(input.env);
	const tools = createCopilotAgentTools({
		apiBaseUrl: '',
		providerApiKey: '',
		assignmentId: input.assignmentId,
		descriptors: [changedPathsDescriptor(input.repoRoot, input.assignmentId)],
		repoRoot: input.repoRoot,
		telemetryPath: input.telemetryPath,
	});
	return await runTreeseedCopilotTask({
		prompt: input.prompt,
		cwd: input.repoRoot,
		model: process.env.TREESEED_COPILOT_DEFAULT_MODEL || undefined,
		tools,
		env,
		timeoutMs: Number(process.env.TREESEED_COPILOT_LIVE_TIMEOUT_MS || 180_000),
	});
}

if (process.env.TREESEED_AGENT_LIVE_COPILOT !== '1') {
	throw new Error('Set TREESEED_AGENT_LIVE_COPILOT=1 to run live Copilot agent-tool acceptance.');
}

const launchEnv = resolveTreeseedLaunchEnvironment({
	tenantRoot: resolve(process.cwd(), '..', '..'),
	scope: 'local',
	baseEnv: process.env,
}) as NodeJS.ProcessEnv;
const managedEnv = createTreeseedManagedToolEnv(launchEnv);
const copilotBinary = resolveTreeseedToolBinary('copilot', { env: managedEnv });
if (!copilotBinary) {
	throw new Error('Copilot CLI is unavailable. Run `npx trsd install --json`, then retry the live Copilot tool proof.');
}

const hasToken = Boolean(
	managedEnv.TREESEED_GITHUB_COPILOT_TOKEN?.trim()
	|| managedEnv.COPILOT_GITHUB_TOKEN?.trim()
	|| managedEnv.TREESEED_GITHUB_TOKEN?.trim()
	|| managedEnv.GH_TOKEN?.trim()
	|| managedEnv.GITHUB_TOKEN?.trim(),
);
const hasCopilotToken = Boolean(
	managedEnv.TREESEED_GITHUB_COPILOT_TOKEN?.trim()
	|| managedEnv.COPILOT_GITHUB_TOKEN?.trim(),
);
const hasFallbackGitHubToken = Boolean(
	managedEnv.TREESEED_GITHUB_TOKEN?.trim()
	|| managedEnv.GH_TOKEN?.trim()
	|| managedEnv.GITHUB_TOKEN?.trim(),
);

const tempRoot = mkdtempSync(join(tmpdir(), 'treeseed-agent-tools-live-copilot-'));
const repoRoot = join(tempRoot, 'repo');
const reportRoot = resolve(process.cwd(), '.treeseed', 'test-reports', 'agent-tools-live-copilot');
mkdirSync(repoRoot, { recursive: true });
mkdirSync(reportRoot, { recursive: true });

try {
	run('git', ['init', '-b', 'main'], repoRoot);
	run('git', ['config', 'user.email', 'agent-tools-live-copilot@example.test'], repoRoot);
	run('git', ['config', 'user.name', 'Agent Tools Live Copilot'], repoRoot);
	mkdirSync(join(repoRoot, 'live-output'), { recursive: true });
	writeFileSync(join(repoRoot, 'README.md'), '# Copilot agent tools live repo\n', 'utf8');
	run('git', ['add', '.'], repoRoot);
	run('git', ['commit', '-m', 'live test baseline'], repoRoot);

	const readOnlyTelemetryPath = join(tempRoot, 'readonly-tools.jsonl');
	const readOnly = await runCopilotToolProof({
		repoRoot,
		telemetryPath: readOnlyTelemetryPath,
		assignmentId: 'live-copilot-readonly-assignment',
		env: launchEnv,
		prompt: [
			'Use the available TreeSeed tool named treeseed_changed_paths exactly once with includeDiffSummary false.',
			'Then summarize the tool result in one short sentence.',
			'Do not print credentials or environment variables.',
		].join('\n'),
	});
	const readOnlyTelemetry = readTelemetry(readOnlyTelemetryPath);
	if (readOnly.status !== 'completed') {
		throw new Error(`Read-only live Copilot tool test failed: ${readOnly.stderr || readOnly.stdout || readOnly.summary}`);
	}
	if (!readOnlyTelemetry.some((entry) => entry.toolId === 'treeseed.changed_paths' && (entry.status === 'completed' || entry.status === 'failed'))) {
		throw new Error(`Read-only live Copilot test did not receive a treeseed.changed_paths tool call. Output: ${readOnly.stdout || '<empty>'}`);
	}

	const worktreeTelemetryPath = join(tempRoot, 'worktree-tools.jsonl');
	const worktree = await runCopilotToolProof({
		repoRoot,
		telemetryPath: worktreeTelemetryPath,
		assignmentId: 'live-copilot-worktree-assignment',
		env: launchEnv,
		prompt: [
			'Create or update live-output/copilot-tool-proof.txt with one sentence.',
			'Then use the available TreeSeed tool named treeseed_changed_paths with includeDiffSummary true.',
			'Finish with the changed path list only.',
		].join('\n'),
	});
	const worktreeTelemetry = readTelemetry(worktreeTelemetryPath);
	if (worktree.status !== 'completed') {
		throw new Error(`Worktree live Copilot tool test failed: ${worktree.stderr || worktree.stdout || worktree.summary}`);
	}
	if (!worktreeTelemetry.some((entry) => entry.toolId === 'treeseed.changed_paths' && entry.status === 'completed')) {
		throw new Error(`Worktree live Copilot test did not complete a treeseed.changed_paths tool call. Output: ${worktree.stdout || '<empty>'}`);
	}

	const report = {
		ok: true,
		generatedAt: new Date().toISOString(),
		auth: {
			tokenDetected: hasToken,
			copilotTokenDetected: hasCopilotToken,
			fallbackGitHubTokenDetected: hasFallbackGitHubToken,
			mode: hasCopilotToken ? 'copilot_token' : hasFallbackGitHubToken ? 'github_token_fallback' : 'logged_in_user_or_cli_store',
		},
		copilotBinary,
		readOnly: {
			status: readOnly.status,
			stdout: readOnly.stdout,
			stderr: readOnly.stderr,
			telemetry: readOnlyTelemetry,
		},
		worktree: {
			status: worktree.status,
			stdout: worktree.stdout,
			stderr: worktree.stderr,
			telemetry: worktreeTelemetry,
		},
	};
	await writeFile(join(reportRoot, 'latest.json'), JSON.stringify(report, null, 2), 'utf8');
	console.log(`Live agent-tool Copilot proof passed. Report: ${join(reportRoot, 'latest.json')}`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	await writeFile(join(reportRoot, 'latest.json'), JSON.stringify({
		ok: false,
		generatedAt: new Date().toISOString(),
		error: message,
		auth: {
			tokenDetected: hasToken,
			copilotTokenDetected: hasCopilotToken,
			fallbackGitHubTokenDetected: hasFallbackGitHubToken,
			mode: hasCopilotToken ? 'copilot_token' : hasFallbackGitHubToken ? 'github_token_fallback' : 'logged_in_user_or_cli_store',
		},
		copilotBinary,
	}, null, 2), 'utf8');
	if (!hasToken) {
		throw new Error(`${message}\nNo GitHub Copilot token was detected in TREESEED_GITHUB_COPILOT_TOKEN/COPILOT_GITHUB_TOKEN, and no TREESEED_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN fallback was present. If Copilot is not logged in locally, configure an account-scoped token with Copilot access using \`npx trsd config set TREESEED_GITHUB_COPILOT_TOKEN\`, then retry.`);
	}
	if (/authorization|authentication|login|unauthorized/iu.test(message)) {
		throw new Error(`${message}\nA GitHub Copilot/GitHub fallback token was detected, but Copilot rejected it. Create or update an account-scoped GitHub fine-grained personal access token with the Copilot Requests permission enabled, store it as TREESEED_GITHUB_COPILOT_TOKEN with \`npx trsd config\`, then retry.`);
	}
	throw error;
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}
