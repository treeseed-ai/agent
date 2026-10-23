import { assignmentPathAllowed, type AssignmentAttempt, type AssignmentContext, type AssignmentReference, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import type {
	AgentRuntime,
	ModelInvocationRequest,
	SourceCommitRequest,
	TreeDxCommitRequest,
	VerificationRequest,
} from './contracts.ts';

function referenceKey(reference: ExactEntityReference): string {
	return JSON.stringify(reference, Object.keys(reference).sort());
}

export function assertAssignmentContextRead(ref: ExactEntityReference, grant: Pick<AssignmentAttempt['grant'], 'contentRead' | 'sourceRead' | 'tools'>): void {
	const allowed = ref.store === 'git'
		? grant.tools.includes('source.read') && typeof ref.repository === 'string' && grant.sourceRead.includes(ref.repository)
		: grant.contentRead.some(reference => referenceKey(reference) === referenceKey(ref));
	if (!allowed) throw new Error('assignment_grant_denied:content.read');
}

export function enforceAssignmentGrant(runtime: AgentRuntime, input: AssignmentAttempt['grant'],
	workspace: { mode: string; writablePaths?: string[]; repository?: string; branch?: string; baseCommit?: string },
	assertAuthority: () => void, context?: AssignmentContext): AgentRuntime {
	const writable = new Set(input.contentWrite.map(referenceKey));
	const tools = new Set(input.tools);
	return {
		now: () => runtime.now(),
		readContext: (ref) => {
			assertAuthority();
			assertAssignmentContextRead(ref, input);
			return runtime.readContext(ref);
		},
		invokeModel: (request: ModelInvocationRequest) => { assertAuthority(); return runtime.invokeModel(request); },
		runVerification: (request: VerificationRequest) => {
			assertAuthority();
			if (!tools.has('verification')) throw new Error('assignment_grant_denied:verification');
			return runtime.runVerification(request);
		},
		commitTreeDx: (request: TreeDxCommitRequest) => {
			assertAuthority();
			if (workspace.mode !== 'treedx' || request.writes.length === 0
				|| request.writes.some(({ target }) => !writable.has(referenceKey(target)))) throw new Error('assignment_grant_denied:treedx.write');
			return runtime.commitTreeDx(request);
		},
		commitSource: (request: SourceCommitRequest) => {
			assertAuthority();
			if (workspace.mode !== 'git' || !tools.has('source.write')) throw new Error('assignment_grant_denied:source.write');
			const paths = workspace.writablePaths ?? [];
			const repository = 'repository' in workspace && typeof workspace.repository === 'string' ? workspace.repository : '';
			if (!input.sourceWrite.includes(repository) || request.paths.length === 0
				|| request.paths.some((path) => !assignmentPathAllowed(path, paths))) throw new Error('assignment_grant_denied:source.path');
			return runtime.commitSource(request);
		},
		retainSource: async (): Promise<AssignmentReference> => {
			assertAuthority();
			if (!context) throw new Error('assignment_retained_source_unbound');
			const assignment = context.assignment;
			const sourceWorkspace = assignment.workspace;
			if (sourceWorkspace.mode !== 'git' || assignment.effectiveProfile.activity !== 'acting'
				|| !tools.has('source.write') || !input.sourceWrite.includes(sourceWorkspace.repository)
				|| !runtime.retainSource) throw new Error('assignment_grant_denied:source.path');
			const actorAssignments = (context as typeof context & { predecessorAttempts?: AssignmentAttempt[] }).predecessorAttempts ?? [];
			const priorCandidates = context.predecessorResults.filter(result => assignment.predecessorResultIds.includes(result.id)
				&& result.status === 'completed' && actorAssignments.some(prior => prior.id === result.assignmentId
					&& prior.effectiveProfile.activity === 'acting' && prior.workspace.mode === 'git'))
				.flatMap(result => result.references).filter((reference): reference is Extract<AssignmentReference, { kind: 'git' }> =>
					reference.kind === 'git' && reference.repository === sourceWorkspace.repository && reference.commit === sourceWorkspace.baseCommit
						&& reference.branch === sourceWorkspace.branch && reference.path === undefined);
			if (priorCandidates.length !== 1) throw new Error('assignment_retained_source_unbound');
			const actual = await runtime.retainSource();
			assertAuthority();
			if (actual.kind !== 'git' || actual.repository !== sourceWorkspace.repository || actual.commit !== sourceWorkspace.baseCommit
				|| actual.branch !== sourceWorkspace.branch) throw new Error('assignment_retained_source_mismatch');
			return actual;
		},
	};
}
