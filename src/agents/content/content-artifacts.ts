import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export interface ContentArtifactRef {
	contentPath: string;
	model: string;
	subjectId: string | null;
	subjectField?: string | null;
	artifactKind: string;
	sourceAssignmentId: string | null;
	producedByAgent: string;
	commitSha?: string | null;
	ref?: string | null;
}

export function resolveProjectContentRoot(repoRoot: string) {
	const docsContent = resolve(repoRoot, 'docs/src/content');
	if (existsSync(docsContent)) return 'docs/src/content';
	return 'src/content';
}

export function assertRelativeContentPath(repoRoot: string, relativePath: string) {
	const root = resolve(repoRoot);
	const target = resolve(root, relativePath);
	const rel = relative(root, target);
	if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) {
		throw new Error(`Content artifact path escapes the repository: ${relativePath}`);
	}
	const normalized = relativePath.replaceAll('\\', '/');
	if (!normalized.startsWith('src/content/') && !normalized.startsWith('docs/src/content/')) {
		throw new Error(`Content artifact path must be inside a Knowledge Hub content root: ${relativePath}`);
	}
	return target;
}
