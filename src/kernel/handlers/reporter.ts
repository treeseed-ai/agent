import { createHash } from 'node:crypto';
import type { AssignmentContext, AssignmentResult, ExactEntityReference } from '@treeseed/sdk/agent-capacity';
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
