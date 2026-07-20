export const CORE_OBJECTIVE_RELATIVE_PATH = 'src/content/objectives/core.md';

export function formatCoreObjectiveMessage(content: string, relativePath = CORE_OBJECTIVE_RELATIVE_PATH) {
	return [
		'TreeSeed Core Objective',
		`Source: ${relativePath}`,
		'',
		content.trim(),
	].join('\n');
}

export function resolveTreeDxCoreObjectiveContext(value: unknown) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.source !== 'treedx_proxy') return null;
	const path = typeof candidate.path === 'string' ? candidate.path.trim() : '';
	const content = typeof candidate.content === 'string' ? candidate.content.trim() : '';
	if (!path || !content) return null;
	const message = typeof candidate.message === 'string' && candidate.message.trim()
		? candidate.message.trim()
		: formatCoreObjectiveMessage(content, path);
	return { path, content, message };
}

export function prependCoreObjectiveToPrompt(input: {
	prompt: string;
	coreObjective?: string | null;
	coreObjectiveRef?: string | null;
}) {
	const coreObjective = input.coreObjective?.trim();
	if (!coreObjective) return input.prompt;
	return [
		formatCoreObjectiveMessage(coreObjective, input.coreObjectiveRef ?? 'treedx://objectives/core'),
		'',
		'Agent Task',
		'',
		input.prompt,
	].join('\n');
}
