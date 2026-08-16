import type { ExecutionContentResult } from '../execution-content.ts';

function summary(value:unknown) {
	return typeof value==='string'&&value.trim()?value.trim():null;
}

export function executionCompletionEvidence(result: ExecutionContentResult) {
	if(result.snapshot.status!=='completed')return null;
	const refs=[...new Set(result.contentArtifactRefs.map((entry)=>entry.contentPath).filter(Boolean))];
	const responses=result.contentArtifactRefs.filter((entry)=>entry.model==='discussion_message'&&entry.artifactKind==='discussion_response');
	return {
		disposition:'completed' as const,
		acceptanceChecks:[{id:'execution-provider-completed',passed:true},...result.contentArtifactRefs.map((entry)=>({id:`artifact:${entry.model}:${entry.artifactKind}`,passed:true,evidenceRefs:[entry.contentPath]}))],
		durableArtifactRefs:refs,remainingBudget:{},completionReason:summary(result.snapshot.summary)??'Execution provider completed the exact assigned output contract.',
		noUsefulScopedWorkRemaining:responses.length===1,
		completedScope:result.contentArtifactRefs.map((entry)=>`${entry.model}:${entry.artifactKind}`),remainingScope:[],
	};
}
