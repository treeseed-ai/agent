import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveWorkspaceReportPath } from '../../services/report-paths.ts';

export interface AgentTestCatalogEntry {
	id: string;
	agent: string;
	kind: string;
	fixture: string | null;
	sourcePath: string;
	status: 'PASS' | 'FAIL';
	issues: string[];
}

export interface AgentTestCatalogResult {
	ok: boolean;
	generatedAt: string;
	repoRoot: string;
	entries: AgentTestCatalogEntry[];
	reportPath: string;
	jsonPath: string;
}

function frontmatter(source: string) {
	const match = source.match(/^---\n([\s\S]*?)\n---/u);
	return match ? parseYaml(match[1]) as Record<string, unknown> : {};
}

function renderCatalog(result: Omit<AgentTestCatalogResult, 'reportPath' | 'jsonPath'>) {
	const lines = [
		'# Agent Test Catalog',
		'',
		`Generated: ${result.generatedAt}`,
		`Repository: ${result.repoRoot}`,
		`Status: ${result.ok ? 'PASS' : 'FAIL'}`,
		'',
	];
	for (const entry of result.entries) {
		lines.push(
			`## ${entry.id}`,
			'',
			`Agent: ${entry.agent}`,
			`Kind: ${entry.kind}`,
			`Fixture: ${entry.fixture ?? 'none'}`,
			`Source: ${entry.sourcePath}`,
			`Status: ${entry.status}`,
		);
		if (entry.issues.length) {
			lines.push('Issues:', ...entry.issues.map((issue) => `- ${issue}`));
		} else {
			lines.push('Issues: none');
		}
		lines.push('');
	}
	return `${lines.join('\n')}\n`;
}

export async function runAgentTestCatalogChecks(options: {
	repoRoot?: string;
	reportPath?: string;
	now?: Date;
} = {}): Promise<AgentTestCatalogResult> {
	const repoRoot = resolve(options.repoRoot ?? process.cwd());
	const root = resolve(repoRoot, 'src/content/agent-tests');
	const files = existsSync(root)
		? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.mdx?$/iu.test(entry.name))
		: [];
	const entries = files.map((file) => {
		const sourcePath = join(root, file.name);
		const data = frontmatter(readFileSync(sourcePath, 'utf8'));
		const id = typeof data.id === 'string' ? data.id : file.name.replace(/\.mdx?$/iu, '');
		const agent = typeof data.agent === 'string' ? data.agent : '';
		const kind = typeof data.kind === 'string' ? data.kind : '';
		const fixture = typeof data.fixture === 'string' ? data.fixture : null;
		const issues = [
			!agent ? 'agent is required' : '',
			!kind ? 'kind is required' : '',
			fixture && !existsSync(resolve(repoRoot, fixture)) ? `fixture path does not exist: ${fixture}` : '',
		].filter(Boolean);
		return {
			id,
			agent,
			kind,
			fixture,
			sourcePath,
			status: issues.length ? 'FAIL' as const : 'PASS' as const,
			issues,
		};
	});
	const resultWithoutPaths = {
		ok: entries.every((entry) => entry.status === 'PASS'),
		generatedAt: (options.now ?? new Date()).toISOString(),
		repoRoot,
		entries,
	};
	const reportPath = resolveWorkspaceReportPath(options.reportPath ?? '.treeseed/test-reports/agent-test-catalog.md');
	const jsonPath = resolveWorkspaceReportPath(reportPath.replace(/\.md$/u, '.json'));
	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(reportPath, renderCatalog(resultWithoutPaths), 'utf8');
	await writeFile(jsonPath, `${JSON.stringify(resultWithoutPaths, null, 2)}\n`, 'utf8');
	return {
		...resultWithoutPaths,
		reportPath,
		jsonPath,
	};
}
