import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runMarketKnowledgeDogfood } from '../src/agents/testing/market-knowledge-dogfood.ts';
import { resolveWorkspaceReportPath } from '../src/services/report-paths.ts';

async function main() {
	const result = await runMarketKnowledgeDogfood();
	const reportPath = resolveWorkspaceReportPath('.treeseed/test-reports/workday-dogfood.md');
	const jsonPath = resolveWorkspaceReportPath(reportPath.replace(/\.md$/u, '.json'));
	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(reportPath, [
		'# Workday Dogfood Report',
		'',
		`Status: ${result.generated.length > 0 && !result.releaseAttempted ? 'PASS' : 'FAIL'}`,
		`Stages: ${result.stages.join(', ')}`,
		`Generated artifacts: ${result.generated.length}`,
		`Release attempted: ${String(result.releaseAttempted)}`,
		`Staging attempted: ${String(result.stagingAttempted)}`,
		'',
		'## Generated Targets',
		'',
		...result.generated.map((entry) => `- ${entry.knowledgeDraft.targetPath}`),
		'',
	].join('\n'), 'utf8');
	await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
	console.log(JSON.stringify(result, null, 2));
}

void main();
