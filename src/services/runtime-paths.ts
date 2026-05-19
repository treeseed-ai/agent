import { join } from 'node:path';

export const PROCESSING_DATA_DIR = '/data';

function envValue(env: NodeJS.ProcessEnv, name: string) {
	return env[name]?.trim() || '';
}

export function resolveProcessingDataDir(env: NodeJS.ProcessEnv = process.env) {
	return envValue(env, 'TREESEED_DATA_DIR')
		|| envValue(env, 'TREESEED_RUNNER_VOLUME_ROOT')
		|| envValue(env, 'RAILWAY_VOLUME_MOUNT_PATH')
		|| (envValue(env, 'TREESEED_PROCESSING_PARITY') ? PROCESSING_DATA_DIR : '.treeseed-runner');
}

export function resolveRunnerRoot(volumeRoot: string, runnerId: string) {
	return join(volumeRoot, 'runners', runnerId);
}

export function resolveRunnerTmpRoot(volumeRoot: string) {
	return join(volumeRoot, 'tmp');
}

export function resolveRunnerWorkspaceRoot(volumeRoot: string, workspaceId: string) {
	return join(volumeRoot, 'workspaces', workspaceId);
}

export function resolveRunnerRepositoryPaths(input: {
	volumeRoot: string;
	repositoryId: string;
	taskId: string;
}) {
	const repositoryRoot = join(input.volumeRoot, 'repositories', input.repositoryId);
	return {
		repositoryRoot,
		bareGit: join(repositoryRoot, 'bare.git'),
		bare: join(repositoryRoot, 'bare.git'),
		worktree: join(repositoryRoot, 'worktrees', input.taskId),
	};
}

export function summarizeProcessingStorage(input: {
	volumeRoot: string;
	repositoryId?: string;
	taskId?: string;
	runnerId?: string;
}) {
	const repositoryId = input.repositoryId ?? '<repository-id>';
	const taskId = input.taskId ?? '<task-id>';
	const runnerId = input.runnerId ?? '<runner-id>';
	const paths = resolveRunnerRepositoryPaths({
		volumeRoot: input.volumeRoot,
		repositoryId,
		taskId,
	});
	return {
		dataDir: input.volumeRoot,
		repositoryBarePath: paths.bare,
		repositoryWorktreePath: paths.worktree,
		runnerPath: resolveRunnerRoot(input.volumeRoot, runnerId),
		tmpPath: resolveRunnerTmpRoot(input.volumeRoot),
	};
}
