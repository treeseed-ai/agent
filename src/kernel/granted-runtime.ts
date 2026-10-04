import { assignmentPathAllowed, type AssignmentAttempt, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
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

export function enforceAssignmentGrant(runtime: AgentRuntime, input: {
	contentRead: ExactEntityReference[];
	contentWrite: ExactEntityReference[];
	sourceRead: string[];
	sourceWrite: string[];
	tools: string[];
}, workspace: { mode: string; writablePaths?: string[] }, assertAuthority: () => void): AgentRuntime {
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
	};
}
