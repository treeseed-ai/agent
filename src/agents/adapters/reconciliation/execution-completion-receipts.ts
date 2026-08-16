import type { ExecutionProviderToolDescriptor } from '../../runtime/runtime-types.ts';
import { hasCompletedToolEvent } from '../codex/execution-codex-core.ts';
import { hasCompatibleContentArtifact,unlinkedNotePaths } from '../../tools/agent-tool-completion.ts';

const TOOL_COMPLETION_RECEIPTS = new Map([
	['treeseed.verify', 'verification_completed'],
	['treeseed.review_decision', 'review_decision_recorded'],
	['treeseed.content.commit', 'content_committed'],
	['treedx.commit_workspace', 'content_committed'],
]);

const SOURCE_CHECKPOINT_ARTIFACT_KINDS = new Set([
	'failing_test_proof',
	'implementation_change',
	'implementation_revision',
]);

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fetchedResearchPublishers(telemetry: Record<string, unknown>[]) {
	const publishers = new Set<string>();
	for (const entry of telemetry) {
		if (entry.status !== 'completed' || !Array.isArray(entry.derivedEvents)) continue;
		for (const event of entry.derivedEvents) {
			const derived = record(event);
			if (derived.type !== 'research_citation_fetched') continue;
			try { publishers.add(new URL(String(record(derived.citation).sourceUrl ?? '')).hostname.toLowerCase()); }
			catch { /* A malformed citation cannot satisfy the independent-publisher gate. */ }
		}
	}
	return publishers;
}

export function missingCodexCompletionReceipts(
	tools: ExecutionProviderToolDescriptor[],
	telemetry: Record<string, unknown>[],
	artifactKind?: string | null,
	researchStage?: string | null,
	minimumIndependentSources = 2,
	requireContentArtifact = false,
	requiredPublishedSignals: string[] = [],
) {
	const completedInputs = (toolId: string) => telemetry
		.filter((entry) => entry.status === 'completed' && entry.toolId === toolId)
		.map((entry) => record(entry.inputSummary));
	const terminal = new Set(['completed', 'failed', 'cancelled', 'suspended']);
	const missing = tools.flatMap((tool) => {
		const eventType = TOOL_COMPLETION_RECEIPTS.get(tool.id);
		if (eventType === 'content_committed' && !requireContentArtifact) return [];
		return eventType && !hasCompletedToolEvent(telemetry, eventType) ? [eventType] : [];
	});
	if (tools.some((tool) => tool.id === 'treeseed.assignment_plan')
		&& !completedInputs('treeseed.assignment_plan').some((input) => input.action === 'write')) missing.push('assignment_plan');
	if (tools.some((tool) => tool.id === 'treeseed.assignment_status_update')
		&& !completedInputs('treeseed.assignment_status_update').some((input) => terminal.has(String(input.status ?? '')))) missing.push('assignment_terminal_status');
	if (tools.some((tool) => tool.id === 'treeseed.assignment_summary')
		&& !completedInputs('treeseed.assignment_summary').some((input) => input.action === 'write' && terminal.has(String(input.status ?? '')))) missing.push('assignment_summary');
	if (artifactKind && SOURCE_CHECKPOINT_ARTIFACT_KINDS.has(artifactKind)
		&& tools.some((tool) => tool.id === 'treeseed.checkpoint')
		&& !hasCompletedToolEvent(telemetry, 'source_checkpoint_committed')) missing.push('source_checkpoint_committed');
	if (artifactKind === 'discussion_response'
		&& !completedInputs('treeseed.discussion.respond').length) missing.push('discussion_final_response');
	if (researchStage === 'independent-source-fetch' && !tools.some((tool) => tool.id === 'research.fetch_source')) missing.push('research_fetch_tool_available');
	else if (researchStage === 'independent-source-fetch' && fetchedResearchPublishers(telemetry).size < minimumIndependentSources) missing.push(`research_independent_publishers:${minimumIndependentSources}`);
	for (const path of unlinkedNotePaths(telemetry)) missing.push(`content_subject_linked:${path}`);
	if (requireContentArtifact && artifactKind && !hasCompatibleContentArtifact(telemetry, artifactKind)) missing.push(`content_artifact_kind:${artifactKind}`);
	const publishedSignals = new Set(telemetry
		.filter((entry) => entry.status === 'completed' && entry.toolId === 'treeseed.publish_signal')
		.flatMap((entry) => Array.isArray(entry.derivedEvents) ? entry.derivedEvents : [])
		.map(record)
		.filter((event) => event.type === 'signal_requested')
		.map((event) => String(record(event.signal).contractId ?? ''))
		.filter(Boolean));
	for (const contractId of requiredPublishedSignals) if (!publishedSignals.has(contractId)) missing.push(`signal_publication:${contractId}`);
	return [...new Set(missing)];
}
