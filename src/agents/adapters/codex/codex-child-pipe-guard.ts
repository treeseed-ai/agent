let activeGuards = 0;

function isBrokenCodexPipe(error: unknown): boolean {
	return error instanceof Error
		&& 'code' in error
		&& (error as Error & { code?: unknown }).code === 'EPIPE';
}

function uncaughtPipeError(error: unknown) {
	if (isBrokenCodexPipe(error)) {
		console.error(JSON.stringify({
			level: 'warn',
			event: 'codex.child_pipe_closed',
			message: 'Codex child stdin closed before prompt delivery completed; the turn result remains authoritative.',
		}));
		return;
	}
	process.removeListener('uncaughtException', uncaughtPipeError);
	activeGuards = 0;
	queueMicrotask(() => { throw error; });
}

export async function withCodexChildPipeGuard<T>(action: () => Promise<T>): Promise<T> {
	if (activeGuards === 0) process.on('uncaughtException', uncaughtPipeError);
	activeGuards += 1;
	try {
		return await action();
	} finally {
		activeGuards = Math.max(0, activeGuards - 1);
		if (activeGuards === 0) process.removeListener('uncaughtException', uncaughtPipeError);
	}
}
