import { createHash } from 'node:crypto';
import { assignmentResultSchema, type AssignmentAttempt, type AssignmentContext, type AssignmentResult, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { isDeepStrictEqual } from 'node:util';
import type { AgentRuntime, Handler } from '../contracts.ts';

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

export class ReporterHandler implements Handler {
	readonly id = 'reporter';

	/** This configured handler commits TreeDX content without acquiring isolation.
	 * Validate its original native closure, never manufacture a sandbox receipt. */
	static retainedNativeResult(assignment: AssignmentAttempt, output: Record<string, unknown>,
		clock: { activeStartedAt?: string; activeFinishedAt?: string; accountedThrough?: string }): AssignmentResult | null {
		if (assignment.effectiveProfile.handlerOrigin !== 'agent-package'
			|| assignment.effectiveProfile.handler !== new ReporterHandler().id || assignment.workspace.mode !== 'treedx'
			|| assignment.grant.sourceWrite.length || Object.keys(output).some(key => !['assignmentResult', 'teardown', 'artifacts'].includes(key))
			|| !Array.isArray(output.artifacts) || output.artifacts.length) return null;
		const parsed = assignmentResultSchema.safeParse(output.assignmentResult);
		if (!parsed.success || !isDeepStrictEqual(parsed.data, output.assignmentResult)) return null;
		const result = parsed.data, teardown = output.teardown as Record<string, unknown> | undefined;
		const start = Date.parse(clock.activeStartedAt ?? ''), finish = Date.parse(clock.activeFinishedAt ?? '');
		const closed = Date.parse(String(teardown?.completedAt ?? '')), completed = Date.parse(result.completedAt);
		if (!Number.isFinite(start) || !Number.isFinite(finish) || !Number.isFinite(closed) || !Number.isFinite(completed)
			|| clock.accountedThrough !== clock.activeFinishedAt || start > completed || completed > closed || closed > finish || finish > Date.now()
			|| completed > Date.parse(assignment.deadline) || start < Date.parse(assignment.createdAt)
			|| !teardown || teardown.verified !== true || Object.keys(teardown).some(key => !['verified', 'completedAt'].includes(key))
			|| result.assignmentId !== assignment.id || result.status !== 'completed' || result.references.length !== 1) return null;
		const reference = result.references[0]!;
		if (reference.kind !== 'treedx' || reference.projectId !== assignment.projectId
			|| reference.repository !== assignment.workspace.repository || reference.workspaceId !== assignment.workspace.workspaceId
			|| !assignment.grant.contentWrite.some(target => target.store === 'treedx' && target.model === 'note'
				&& target.repository === reference.repository && target.path === reference.path)) return null;
		const active = result.usage.native?.activeSeconds;
		if (typeof active !== 'number' || !Number.isFinite(active) || active <= 0 || active > result.usage.elapsedSeconds
			|| result.usage.modelInputTokens !== undefined || result.usage.modelOutputTokens !== undefined
			|| Object.keys(result.usage.native ?? {}).some(key => key !== 'activeSeconds')) return null;
		return result;
	}

	async run(context: AssignmentContext, runtime: AgentRuntime): Promise<AssignmentResult> {
		const startedAt = runtime.now();
		const assignment = context.assignment;
		if (assignment.workspace.mode !== 'treedx') throw new Error('reporter_requires_treedx_workspace');
		const evidence = context.context.find(item => item.ref.store === 'postgresql'
			&& item.ref.model === 'workday' && item.ref.id === assignment.workdayId);
		if (!evidence) throw new Error('reporter_workday_evidence_required');
		const report = {
			classification: 'workday-report',
			workdayId: assignment.workdayId,
			assignmentId: assignment.id,
			workday: evidence.value,
			predecessorResults: context.predecessorResults,
		};
		const bytes = stable(report);
		const id = `report-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`;
		const target = assignment.grant.contentWrite.find((ref) => ref.model === 'note');
		if (!target) throw new Error('reporter_note_grant_required');
		const [reference] = await runtime.commitTreeDx({ writes: [{ target: target as ExactEntityReference, value: {
			frontmatter: { schemaVersion: 'treeseed.note/v1', id: target.id, projectId: assignment.projectId,
				classification: 'workday-report', subjectRefs: [assignment.sourceRef],
				createdAt: startedAt },
			body: `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``,
		} }] });
		if (!reference) throw new Error('reporter_commit_reference_missing');
		const completedAt = runtime.now();
		const elapsedSeconds = (Date.parse(completedAt) - Date.parse(startedAt)) / 1000;
		if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new Error('reporter_clock_invalid');
		return {
			schemaVersion: 'treeseed.assignment-result/v1',
			id,
			assignmentId: assignment.id,
			status: 'completed',
			summary: `Recorded workday ${assignment.workdayId} report.`,
			references: [reference],
			verification: [],
			usage: { elapsedSeconds: Math.ceil(elapsedSeconds) },
			diagnostics: [],
			completedAt,
		};
	}
}
