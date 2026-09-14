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
		const assignment = context.assignment;
		if (assignment.workspace.mode !== 'treedx') throw new Error('reporter_requires_treedx_workspace');
		const report = {
			classification: 'workday-report',
			workdayId: assignment.workdayId,
			assignmentId: assignment.id,
			predecessorResults: context.predecessorResults.map((result) => ({ id: result.id, status: result.status, references: result.references })),
		};
		const bytes = stable(report);
		const id = `report-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`;
		const target = assignment.grant.contentWrite.find((ref) => ref.model === 'note');
		if (!target) throw new Error('reporter_note_grant_required');
		const reference = await runtime.commitTreeDx({ target: target as ExactEntityReference, value: {
			frontmatter: { schemaVersion: 'treeseed.note/v1', id: target.id, projectId: assignment.projectId,
				classification: 'workday-report', subjectRefs: [assignment.sourceRef],
				createdAt: runtime.now() },
			body: `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``,
		} });
		return {
			schemaVersion: 'treeseed.assignment-result/v1',
			id,
			assignmentId: assignment.id,
			status: 'completed',
			summary: `Recorded workday ${assignment.workdayId} report.`,
			references: [reference],
			verification: [],
			usage: { elapsedSeconds: 0 },
			diagnostics: [],
			completedAt: runtime.now(),
		};
	}
}
