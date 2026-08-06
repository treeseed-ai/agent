import type { AgentTreeDxAdapter } from '../../agents/runtime/runtime-types.ts';
import { createHash } from 'node:crypto';
import { createUnifiedChangeset } from '@treeseed/sdk/treedx';
import { assertRelativeContentPath } from '../../agents/content/content-artifacts.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { record, stringValue } from '../configuration/value-utils.ts';

const execFileAsync = promisify(execFile);

export async function writeProviderContentArtifact(input: {
	repoRoot: string;
	relativePath: string;
	content: string;
	commitMessage: string;
	treeDx: AgentTreeDxAdapter | null;
	workspaceId: string | null;
	baseCommitSha: string | null;
	baseRef: string | null;
}) {
	assertRelativeContentPath(input.repoRoot, input.relativePath);
	if (!input.treeDx || !input.workspaceId || !input.baseCommitSha || !input.baseRef) {
		throw new Error('TreeDX writable workspace is required for provider content artifact writes.');
	}
	const existing = await input.treeDx.readWorkspaceFile({ workspaceId: input.workspaceId, path: input.relativePath }).catch(() => null);
	const before = existing ? stringValue(record(existing).content, record(record(existing).file).content) ?? null : null;
	const patch = createUnifiedChangeset([{ path: input.relativePath, before, after: input.content }]);
	const patchSha256 = createHash('sha256').update(patch).digest('hex');
	const changeset = await input.treeDx.applyWorkspaceChangeset({
		workspaceId: input.workspaceId,
		body: { contract: 'treedx.changeset/v1', baseCommitSha: input.baseCommitSha, baseRef: input.baseRef,
			patch, patchSha256, idempotencyKey: createHash('sha256').update(`${input.workspaceId}:${patchSha256}`).digest('hex'),
			expectedDestinationRefHead: input.baseCommitSha },
	});
	const commit = await input.treeDx.commitWorkspace({
		workspaceId: input.workspaceId,
		message: input.commitMessage,
		body: { author: { name: 'TreeSeed Agent Provider', email: 'agent-provider@treeseed.local' } },
	});
	return {
		branchName: null,
		commitMessage: input.commitMessage,
		worktreePath: input.repoRoot,
		commitSha: stringValue(record(commit).commitSha, record(record(commit).payload).commitSha),
		changedPaths: [input.relativePath],
		changeset,
	};
}

export async function inspectProviderRepository(repoRoot: string) {
	try {
		const { stdout: branchStdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
			cwd: repoRoot,
			env: process.env,
		});
		const { stdout: changedStdout } = await execFileAsync('git', ['status', '--short'], {
			cwd: repoRoot,
			env: process.env,
		});
		const { stdout: shaStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
			cwd: repoRoot,
			env: process.env,
		});
		const changedPaths = changedStdout
			.split('\n')
			.map((entry) => entry.trim().replace(/^[MADRCU?! ]+\s+/, '').trim())
			.filter(Boolean);
		return {
			branchName: branchStdout.trim() || null,
			changedPaths,
			commitSha: shaStdout.trim() || null,
			summary: `Inspected provider workspace with ${changedPaths.length} changed path(s).`,
		};
	} catch (error) {
		return {
			branchName: null,
			changedPaths: [],
			commitSha: null,
			summary: `Provider workspace inspection failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export async function runProviderVerification(input: { repoRoot: string; commands: string[]; cwd?: string }) {
	if (!input.commands.length) {
		return {
			status: 'completed' as const,
			summary: 'No verification commands were configured for this assignment.',
			stdout: '',
			stderr: '',
		};
	}
	const stdout: string[] = [];
	const stderr: string[] = [];
	for (const command of input.commands) {
		try {
			const result = await execFileAsync('/bin/bash', ['-lc', command], {
				cwd: input.cwd ?? input.repoRoot,
				env: process.env,
				maxBuffer: 10 * 1024 * 1024,
			});
			stdout.push(result.stdout);
			stderr.push(result.stderr);
		} catch (error) {
			return {
				status: 'failed' as const,
				summary: `Verification command failed: ${command}`,
				stdout: stdout.join('\n'),
				stderr: error && typeof error === 'object' && 'stderr' in error
					? String((error as { stderr?: string }).stderr ?? '')
					: String(error),
				errorCategory: 'execution_error' as const,
			};
		}
	}
	return {
		status: 'completed' as const,
		summary: `Verification completed for ${input.commands.length} command(s).`,
		stdout: stdout.join('\n'),
		stderr: stderr.join('\n'),
	};
}
