/** One correction inside the same admitted workload; no new authority or execution. */
export async function closeModelProduct<T>(input: {
	complete(): Promise<T>;
	retainFailure(error: unknown): Promise<void>;
	canCorrect(): boolean;
	remainingMs(): number;
	correct(error: unknown, remainingMs: number): Promise<void>;
}): Promise<T> {
	try { return await input.complete(); }
	catch (error) {
		await input.retainFailure(error);
		const failure = error && typeof error === 'object' ? error as { code?: unknown; exitCode?: unknown } : {};
		const recoverable = failure.code === 'activity_git_worktree_dirty'
			|| failure.code === 'activity_verification_failed' && failure.exitCode === 127;
		if (!recoverable || !input.canCorrect()) throw error;
		const remaining = input.remainingMs();
		if (!Number.isFinite(remaining) || remaining < 30_000) throw error;
		const launch = input.remainingMs();
		if (!Number.isFinite(launch) || launch < 30_000) throw error;
		try {
			// Retention and callback preparation consume the original window too.
			await input.correct(error, Math.min(remaining, launch));
			return await input.complete();
		} catch (failure) { await input.retainFailure(failure); throw failure; }
	}
}
