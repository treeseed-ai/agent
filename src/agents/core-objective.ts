import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CORE_OBJECTIVE_RELATIVE_PATH = 'src/content/objectives/core.md';
export const PACKAGE_CORE_OBJECTIVE_RELATIVE_PATH = 'docs/src/content/objectives/core.md';

export function loadCoreObjective(repoRoot: string) {
	const relativePath = resolveCoreObjectiveRelativePath(repoRoot);
	const path = join(repoRoot, relativePath);
	if (!existsSync(path)) return null;
	const content = readFileSync(path, 'utf8').trim();
	return content || null;
}

export function resolveCoreObjectiveRelativePath(repoRoot: string) {
	if (existsSync(join(repoRoot, PACKAGE_CORE_OBJECTIVE_RELATIVE_PATH))) {
		return PACKAGE_CORE_OBJECTIVE_RELATIVE_PATH;
	}
	return CORE_OBJECTIVE_RELATIVE_PATH;
}

export function formatCoreObjectiveMessage(content: string, relativePath = CORE_OBJECTIVE_RELATIVE_PATH) {
	return [
		'TreeSeed Core Objective',
		`Source: ${relativePath}`,
		'',
		content.trim(),
	].join('\n');
}

export function loadCoreObjectiveContext(repoRoot: string) {
	const content = loadCoreObjective(repoRoot);
	if (!content) return null;
	const relativePath = resolveCoreObjectiveRelativePath(repoRoot);
	return {
		path: relativePath,
		content,
		message: formatCoreObjectiveMessage(content, relativePath),
	};
}

export function prependCoreObjectiveToPrompt(input: {
	prompt: string;
	repoRoot: string;
	coreObjective?: string | null;
}) {
	const coreObjective = input.coreObjective ?? loadCoreObjective(input.repoRoot);
	if (!coreObjective) return input.prompt;
	const relativePath = resolveCoreObjectiveRelativePath(input.repoRoot);
	return [
		formatCoreObjectiveMessage(coreObjective, relativePath),
		'',
		'Agent Task',
		'',
		input.prompt,
	].join('\n');
}
