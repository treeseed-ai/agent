import type { ExactEntityReference } from '@treeseed/sdk/agent-capacity';
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

function pathAllowed(path: string, allowed: string[]): boolean {
	return allowed.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/$/u, '')}/`));
}

export function enforceAssignmentGrant(runtime: AgentRuntime, input: {
	contentRead: ExactEntityReference[];
	contentWrite: ExactEntityReference[];
	sourceRead: string[];
	sourceWrite: string[];
	tools: string[];
}, workspace: { mode: string; writablePaths?: string[] }): AgentRuntime {
	const readable = new Set(input.contentRead.map(referenceKey));
	const writable = new Set(input.contentWrite.map(referenceKey));
	const tools = new Set(input.tools);
	return {
		now: () => runtime.now(),
		readContext: (ref) => {
			if (!readable.has(referenceKey(ref))) throw new Error('assignment_grant_denied:content.read');
			return runtime.readContext(ref);
		},
		invokeModel: (request: ModelInvocationRequest) => runtime.invokeModel(request),
		runVerification: (request: VerificationRequest) => {
			if (!tools.has('verification')) throw new Error('assignment_grant_denied:verification');
			return runtime.runVerification(request);
		},
		commitTreeDx: (request: TreeDxCommitRequest) => {
			if (workspace.mode !== 'treedx' || !writable.has(referenceKey(request.target))) throw new Error('assignment_grant_denied:treedx.write');
			return runtime.commitTreeDx(request);
		},
		commitSource: (request: SourceCommitRequest) => {
			if (workspace.mode !== 'git' || !tools.has('source.write')) throw new Error('assignment_grant_denied:source.write');
			const paths = workspace.writablePaths ?? [];
			const repository = 'repository' in workspace && typeof workspace.repository === 'string' ? workspace.repository : '';
			if (!input.sourceWrite.includes(repository) || request.paths.some((path) => !pathAllowed(path, paths))) throw new Error('assignment_grant_denied:source.path');
			return runtime.commitSource(request);
		},
	};
}
