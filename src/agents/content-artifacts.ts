import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import type { AgentContext } from './runtime-types.ts';

export type ContentArtifactKind =
	| 'agent_feedback'
	| 'decision_feedback'
	| 'proposal_estimate'
	| 'question_answer'
	| 'planning_note'
	| 'workday_summary'
	| string;

export interface ContentArtifactSubject {
	model?: string | null;
	id?: string | null;
	slug?: string | null;
	title?: string | null;
}

export interface ContentArtifactRef {
	contentPath: string;
	model: string;
	subjectId: string | null;
	artifactKind: string;
	sourceAssignmentId: string | null;
	producedByAgent: string;
}

export interface LinkedNoteInput {
	context: AgentContext;
	artifactKind: ContentArtifactKind;
	subject?: ContentArtifactSubject | null;
	title: string;
	summary: string;
	body: string;
	tags?: string[];
	metadata?: Record<string, unknown>;
}

function slugSegment(value: string) {
	return value
		.toLowerCase()
		.replace(/^[^:]+:/u, '')
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '') || 'item';
}

export function resolveProjectContentRoot(repoRoot: string) {
	const docsContent = resolve(repoRoot, 'docs/src/content');
	if (existsSync(docsContent)) return 'docs/src/content';
	return 'src/content';
}

function subjectLink(subject: ContentArtifactSubject | null | undefined) {
	if (!subject?.id && !subject?.slug) return null;
	const model = subject.model ? String(subject.model) : 'content';
	const id = String(subject.id ?? subject.slug);
	return `${model}:${id}`;
}

function relatedFieldFor(model: string | null | undefined) {
	switch (model) {
		case 'decision':
		case 'decisions':
			return 'relatedDecisions';
		case 'proposal':
		case 'proposals':
			return 'relatedProposals';
		case 'question':
		case 'questions':
			return 'relatedQuestions';
		case 'objective':
		case 'objectives':
			return 'relatedObjectives';
		case 'book':
		case 'books':
			return 'relatedBooks';
		default:
			return null;
	}
}

export function buildLinkedNoteArtifact(input: LinkedNoteInput) {
	const contentRoot = resolveProjectContentRoot(input.context.repoRoot);
	const now = new Date().toISOString();
	const date = now.slice(0, 10);
	const subject = input.subject ?? {};
	const subjectId = subject.id ?? subject.slug ?? null;
	const subjectSlug = slugSegment(String(subjectId ?? input.title));
	const kindSlug = slugSegment(String(input.artifactKind));
	const agentSlug = slugSegment(input.context.agent.slug);
	const relativePath = `${contentRoot}/notes/agent-feedback/${date}/${kindSlug}-${subjectSlug}-${agentSlug}.mdx`;
	const link = subjectLink(subject);
	const relatedField = relatedFieldFor(subject.model);
	const relatedFields = relatedField && subjectId ? { [relatedField]: [String(subjectId)] } : {};
	const frontmatter = {
		title: input.title,
		description: input.summary,
		date,
		status: 'draft',
		tags: [...new Set(['agent-feedback', kindSlug, ...(input.tags ?? [])])],
		author: input.context.agent.slug,
		summary: input.summary,
		draft: true,
		about: link ? [link] : [],
		...relatedFields,
	};
	const body = [
		input.body.trim(),
		'',
		'## Artifact Metadata',
		'',
		`- Artifact kind: ${input.artifactKind}`,
		`- Produced by: ${input.context.agent.slug}`,
		`- Assignment: ${input.context.capacity?.assignmentId ?? 'none'}`,
		`- Subject: ${link ?? 'none'}`,
	].join('\n');
	return {
		relativePath,
		content: serializeFrontmatterDocument(frontmatter, body),
		ref: {
			contentPath: relativePath,
			model: 'note',
			subjectId: subjectId ? String(subjectId) : null,
			artifactKind: String(input.artifactKind),
			sourceAssignmentId: input.context.capacity?.assignmentId ?? null,
			producedByAgent: input.context.agent.slug,
		} satisfies ContentArtifactRef,
	};
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
