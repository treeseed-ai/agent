import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runLocalEndToEndVerification } from '../src/agents/testing/local-e2e-verification.ts';
import { resolveWorkspaceReportPath } from '../src/services/report-paths.ts';

const result = await runLocalEndToEndVerification();
const reportPath = resolveWorkspaceReportPath('.treeseed/test-reports/governed-mutation-dogfood.md');
const jsonPath = resolveWorkspaceReportPath(reportPath.replace(/\.md$/u, '.json'));
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, [
	'# Governed Mutation Dogfood Report',
	'',
	`Status: ${result.ok ? 'PASS' : 'FAIL'}`,
	`Seeded tasks: ${result.seededTaskCount}`,
	`Approvals: ${result.approvalCount}`,
	`Release approvals: ${result.releaseApprovalCount}`,
	`Staged paths: ${result.stagedPathCount}`,
	`Report: ${result.report.relativePath}`,
	'',
	'## Generated Targets',
	'',
	...result.generatedTargetPaths.map((targetPath) => `- ${targetPath}`),
	'',
].join('\n'), 'utf8');
await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (!result.ok) {
	process.exitCode = 1;
}
