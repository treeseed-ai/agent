import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS } from '../../src/agents/knowledge/pipeline.ts';
import { runLocalEndToEndVerification } from '../../src/agents/testing/local-e2e-verification.ts';

describe('local end-to-end verification harness', () => {
	it('proves the workday research and knowledge loop through API and report surfaces', async () => {
		const result = await runLocalEndToEndVerification({
			now: new Date('2026-05-13T12:00:00.000Z'),
		});
		try {
			const questionCount = TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length;
			expect(result.ok).toBe(true);
			expect(result.seededTaskCount).toBe(questionCount);
			expect(result.taskCounts.byKind).toMatchObject({
				research_question: questionCount,
				generate_knowledge_draft: questionCount,
				optimize_knowledge_draft: questionCount,
				promote_knowledge_draft_request: questionCount,
				promote_knowledge_to_staging: questionCount,
				release_staged_knowledge_request: questionCount,
			});
			expect(result.taskCounts.completed).toBe(questionCount * 4);
			expect(result.taskCounts.waiting).toBe(questionCount * 2);
			expect(result.artifactCounts).toMatchObject({
				research_note: questionCount,
				knowledge_draft: questionCount,
				optimization_report: questionCount,
				promotion_request: questionCount,
				release_request: questionCount,
			});
			expect(result.approvalCount).toBe(questionCount * 2);
			expect(result.releaseApprovalCount).toBe(questionCount);
			expect(result.stagedPathCount).toBe(questionCount);
			expect(result.releaseResultCount).toBeGreaterThanOrEqual(questionCount);
			expect(result.generatedTargetPaths).toEqual(expect.arrayContaining(
				TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.map((question) => question.targetPath),
			));
			expect(result.api).toMatchObject({
				researchNoteCount: questionCount,
				knowledgeDraftCount: questionCount,
				optimizationReportCount: questionCount,
				approvalCount: questionCount * 2,
				releaseApprovalCount: questionCount,
				releaseResultCount: expect.any(Number),
				reportCount: 1,
				currentWorkdayReported: true,
			});
			expect(result.report.includesGeneratedArtifactsSection).toBe(true);
			expect(result.report.includesAllTargetPaths).toBe(true);
			expect(result.report.includesOperationSections).toBe(true);
			expect(result.report.includesReleaseResults).toBe(true);
			expect(result.codexReadiness).toMatchObject({
				nodeVersionOk: true,
				blockingIssues: [],
			});
			expect(result.releaseAttempted).toBe(true);
			expect(result.stagingAttempted).toBe(true);

			const report = readFileSync(resolve(result.repoRoot, result.report.relativePath), 'utf8');
			expect(report).toContain('## Generated Artifacts');
			expect(report).toContain('## Operation Events');
			expect(report).toContain('## Staging And Release');
			expect(report).toContain('Release results:');
			expect(report).toContain('Mocked local E2E release completed.');
			for (const question of TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS) {
				expect(report).toContain(question.targetPath);
			}
		} finally {
			rmSync(result.repoRoot, { recursive: true, force: true });
		}
	});
});
