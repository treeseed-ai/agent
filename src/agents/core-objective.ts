import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CORE_OBJECTIVE_RELATIVE_PATH = 'src/content/objectives/core.md';

export function loadCoreObjective(repoRoot: string) {
	const path = join(repoRoot, CORE_OBJECTIVE_RELATIVE_PATH);
	if (!existsSync(path)) return null;
	const content = readFileSync(path, 'utf8').trim();
	return content || null;
}

export function formatCoreObjectiveMessage(content: string) {
	return [
		'TreeSeed Core Objective',
		`Source: ${CORE_OBJECTIVE_RELATIVE_PATH}`,
		'',
		content.trim(),
	].join('\n');
}

export function loadCoreObjectiveContext(repoRoot: string) {
	const content = loadCoreObjective(repoRoot);
	if (!content) return null;
	return {
		path: CORE_OBJECTIVE_RELATIVE_PATH,
		content,
		message: formatCoreObjectiveMessage(content),
	};
}

export function prependCoreObjectiveToPrompt(input: {
	prompt: string;
	repoRoot: string;
	coreObjective?: string | null;
}) {
	const coreObjective = input.coreObjective ?? loadCoreObjective(input.repoRoot);
	if (!coreObjective) return input.prompt;
	return [
		formatCoreObjectiveMessage(coreObjective),
		'',
		'Agent Task',
		'',
		input.prompt,
	].join('\n');
}
