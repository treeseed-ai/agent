import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runStudyKnowledgePackScenario } from '../../src/agents/testing/study-knowledge-pack-scenario.ts';

describe('study knowledge pack scenario', () => {
	it('exports three course knowledge packs with portfolio allocation and workday trails', async () => {
		const repoRoot = resolve(process.cwd(), '../..');
		const outputRoot = mkdtempSync(resolve(tmpdir(), 'treeseed-study-packs-'));
		const result = await runStudyKnowledgePackScenario({
			repoRoot,
			outputRoot,
			now: new Date('2026-06-17T12:00:00.000Z'),
			codexMode: 'skip',
		});

		expect(result.ok).toBe(true);
		expect(result.student.id).toBe('student-maya-rivera');
		expect(result.team.id).toBe('team-campus-study-group');
		expect(result.capacityProvider.kind).toBe('codex_subscription');
		expect(result.capacityProvider.allocatedMinutesPerDay).toBe(144);
		expect(result.capacityProvider.projectMinutesPerDay).toBe(48);
		expect(result.allocation.projectShare).toBeCloseTo(1 / 3);
		expect(result.projects).toHaveLength(3);

		for (const project of result.projects) {
			expect(project.coreObjective).toContain('VERY IMPORTANT');
			expect(project.allocationShare).toBeCloseTo(1 / 3);
			expect(project.dailyMinutes).toBe(48);
			expect(project.workdayCount).toBe(10);
			expect(project.proposalCount).toBe(10);
			expect(project.decisionCount).toBe(10);
			expect(project.communicationMessageCount).toBe(50);
			expect(project.liveCodex.status).toBe('skipped');
			expect(project.bookPackage.sourceFileCount).toBeGreaterThanOrEqual(3);
			expect(existsSync(project.bookPackage.markdownPath)).toBe(true);
			expect(existsSync(project.readablePackPath)).toBe(true);
			const pack = readFileSync(project.readablePackPath, 'utf8');
			expect(pack).toContain('Source Bundle');
			expect(pack).toContain(project.title);
			expect(pack).toContain('Core Objective');
			expect(pack).toContain('Communication Trail');
			expect(pack).toContain('Study Cards');
		}
	}, 30000);
});
