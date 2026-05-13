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
			expect(result.ok).toBe(true);
			expect(result.seededTaskCount).toBe(TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length);
			expect(result.taskCounts.byKind).toMatchObject({
				research_question: 5,
				generate_knowledge_draft: 5,
				optimize_knowledge_draft: 5,
				promote_knowledge_draft_request: 5,
				promote_knowledge_to_staging: 5,
				release_staged_knowledge_request: 5,
			});
			expect(result.taskCounts.completed).toBe(20);
			expect(result.taskCounts.waiting).toBe(10);
			expect(result.artifactCounts).toMatchObject({
				research_note: 5,
				knowledge_draft: 5,
				optimization_report: 5,
				promotion_request: 5,
				release_request: 5,
			});
			expect(result.approvalCount).toBe(10);
			expect(result.releaseApprovalCount).toBe(5);
			expect(result.stagedPathCount).toBe(5);
			expect(result.releaseResultCount).toBeGreaterThanOrEqual(5);
			expect(result.generatedTargetPaths).toEqual(expect.arrayContaining(
				TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.map((question) => question.targetPath),
			));
			expect(result.api).toMatchObject({
				researchNoteCount: 5,
				knowledgeDraftCount: 5,
				optimizationReportCount: 5,
				approvalCount: 10,
				releaseApprovalCount: 5,
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
