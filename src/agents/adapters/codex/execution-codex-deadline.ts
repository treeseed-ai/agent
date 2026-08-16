export function codexDeadlineContract(timingValue: unknown, hasStatusTool: boolean) {
	if (!hasStatusTool) return [];
	const timing = timingValue && typeof timingValue === 'object' && !Array.isArray(timingValue)
		? timingValue as Record<string, unknown> : {};
	const closeoutWarningSeconds = Number(timing.closeoutWarningSeconds) > 0 ? Number(timing.closeoutWarningSeconds) : 180;
	return [
		'Assignment time contract:',
		`- Productive execution allocation: ${typeof timing.executionSeconds==='number'?`${timing.executionSeconds} seconds`:'<read through treeseed_status>'}. Preparation and closeout do not consume it.`,
		`- Assignment custody deadline: ${typeof timing.closeoutDeadlineAt === 'string'?timing.closeoutDeadlineAt:typeof timing.deadlineAt === 'string' ? timing.deadlineAt : '<read through treeseed_status>'}.`,
		`- Protected closeout allocation: ${typeof timing.closeoutSeconds==='number'?timing.closeoutSeconds:closeoutWarningSeconds} seconds.`,
		'- Call treeseed_status immediately, after every major phase, and before a long-running command or mutation. Treat its phase and phase-specific remaining time as authoritative.',
		'- Preparation is bounded but outside productive execution. Resolve admitted dynamic context and write the mandatory initial assignment plan; its authoritative read-back starts the execution clock.',
		'- When shouldCloseOut=true, stop new exploration and scope expansion. Preserve coherent work: validate and commit content exactly once, or run only verification that fits and create a source checkpoint. Record exact artifact/checkpoint refs, verification state, remaining scope, blockers, and resume instructions before final response.',
		'- If useful scope remains and proposal creation is authorized, a Zod-valid project proposal may request more capacity. It never changes the current deadline or approves itself. Otherwise report extensionRequested=true, requested seconds, and the evidence-based reason.',
	];
}
