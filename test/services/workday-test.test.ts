import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	normalizeWorkdayTestParameters,
	redactWorkdayTestValue,
	scoreWorkdayTest,
	writeWorkdayTestReports,
} from '../../src/services/workday-test.ts';

const tempRoots: string[] = [];

function tempDir() {
	const root = mkdtempSync(join(tmpdir(), 'treeseed-workday-test-'));
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workday test helpers', () => {
	it('normalizes scenario parameters and redacts sensitive values', () => {
		const parameters = normalizeWorkdayTestParameters({
			projects: 'market,sdk',
			workdays: '2',
			maxAssignments: '12',
			providerId: 'local',
			planningOnly: true,
		});
		expect(parameters).toMatchObject({
			projects: ['market', 'sdk'],
			workdays: 2,
			maxAssignments: 12,
			providerId: 'local',
			planningOnly: true,
		});
		expect(redactWorkdayTestValue({
			token: 'secret',
			nested: { apiKey: 'secret', ok: true },
		})).toEqual({
			token: '<redacted>',
			nested: { apiKey: '<redacted>', ok: true },
		});
	});

	it('scores coverage and writes portable reports', async () => {
		const parameters = normalizeWorkdayTestParameters({ projects: 'market', planningOnly: true, reportDir: tempDir() });
		const actual = {
			providerReady: true,
			auditEvents: 3,
			projects: [{
				slug: 'market',
				projectId: 'project-market',
				agentCount: 9,
				planningRuns: 1,
				actingRuns: 0,
				assignments: 1,
				status: 'ready',
			}],
		};
		const metrics = scoreWorkdayTest({
			expectedProjects: ['market'],
			actual,
			planningOnly: true,
		});
		expect(metrics).toMatchObject({
			score: 100,
			status: 'completed',
			blockers: [],
		});
		const refs = await writeWorkdayTestReports({
			runId: 'run-test',
			reportDir: parameters.reportDir,
			parameters,
			metrics,
			actual,
			expected: { projects: ['market'] },
		});
		expect(readFileSync(refs.jsonPath, 'utf8')).toContain('"runId": "run-test"');
		expect(readFileSync(refs.markdownPath, 'utf8')).toContain('# Workday Test run-test');
	});
});
