import type { ScopedAgentSdk } from '@treeseed/sdk/sdk';
import {
	compileDeclarativeContextQuery,
	type DeclarativeContextQuery,
	type HandlerContextPackSource,
	type ResolvedHandlerContextPack,
} from '@treeseed/sdk/graph/context-query-contracts';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type { CodebaseInventoryArtifact } from '../../services/codebase-documentation-scanner.ts';
import { buildCodeContextPacksForQuery } from './code-context-packs.ts';

interface QueryCandidate {
	query: DeclarativeContextQuery;
	source: HandlerContextPackSource;
	sourceRef?: string;
	priority: number;
	index: number;
}

export interface HandlerContextRecord {
	ref?: string;
	context?: {
		queries?: DeclarativeContextQuery[];
	};
	frontmatter?: {
		context?: {
			queries?: DeclarativeContextQuery[];
		};
	};
}

export interface ResolveHandlerContextPacksInput {
	sdk: Pick<ScopedAgentSdk, 'buildContextPack'>;
	agent?: (AgentRuntimeSpec & { context?: { queries?: DeclarativeContextQuery[] } }) | null;
	taskPayload?: Record<string, unknown> | null;
	workPackage?: Record<string, unknown> | null;
	contentRecords?: HandlerContextRecord[];
	defaultRoleContext?: DeclarativeContextQuery[];
}

export interface HandlerContextPackCollection {
	all(): ResolvedHandlerContextPack[];
	get(id: string): ResolvedHandlerContextPack | undefined;
	byPurpose(purpose: string): ResolvedHandlerContextPack[];
	warnings(): string[];
}

export interface ResolveHandlerContextPacksResult {
	contextPacks: HandlerContextPackCollection;
	warnings: string[];
}

const SOURCE_PRIORITIES: Record<HandlerContextPackSource, number> = {
	default_role_context: 10,
	agent_spec: 20,
	content_frontmatter: 30,
	work_package: 40,
	task_payload: 50,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function codebaseInventoryFromPayload(value: unknown): CodebaseInventoryArtifact | null {
	if (!isRecord(value)) return null;
	const inventory = isRecord(value.codebaseInventory) ? value.codebaseInventory : null;
	return inventory?.kind === 'codebase_inventory' ? inventory as unknown as CodebaseInventoryArtifact : null;
}

function contextQueriesFromRecord(value: unknown): DeclarativeContextQuery[] {
	if (!isRecord(value)) return [];
	const context = isRecord(value.context) ? value.context : null;
	return Array.isArray(context?.queries)
		? context.queries.filter(isRecord) as unknown as DeclarativeContextQuery[]
		: [];
}

function collectFromRecord(
	candidates: QueryCandidate[],
	source: HandlerContextPackSource,
	record: unknown,
	sourceRef: string | undefined,
	indexRef: { value: number },
) {
	for (const query of contextQueriesFromRecord(record)) {
		candidates.push({
			query,
			source,
			sourceRef,
			priority: SOURCE_PRIORITIES[source],
			index: indexRef.value++,
		});
	}
}

function collectCandidates(input: ResolveHandlerContextPacksInput) {
	const candidates: QueryCandidate[] = [];
	const indexRef = { value: 0 };

	for (const query of input.defaultRoleContext ?? []) {
		candidates.push({
			query,
			source: 'default_role_context',
			priority: SOURCE_PRIORITIES.default_role_context,
			index: indexRef.value++,
		});
	}

	if (input.agent?.context?.queries?.length) {
		for (const query of input.agent.context.queries) {
			candidates.push({
				query,
				source: 'agent_spec',
				sourceRef: input.agent.slug,
				priority: SOURCE_PRIORITIES.agent_spec,
				index: indexRef.value++,
			});
		}
	}

	for (const record of input.contentRecords ?? []) {
		const frontmatterSource = record.frontmatter ? { context: record.frontmatter.context } : record;
		collectFromRecord(candidates, 'content_frontmatter', frontmatterSource, record.ref, indexRef);
	}

	collectFromRecord(candidates, 'work_package', input.workPackage, undefined, indexRef);
	collectFromRecord(candidates, 'task_payload', input.taskPayload, undefined, indexRef);

	return candidates;
}

function mergeCandidates(candidates: QueryCandidate[]) {
	const byId = new Map<string, QueryCandidate>();
	for (const candidate of candidates) {
		const id = typeof candidate.query.id === 'string' ? candidate.query.id.trim() : '';
		if (!id) {
			continue;
		}
		const current = byId.get(id);
		if (!current || candidate.priority > current.priority || (candidate.priority === current.priority && candidate.index > current.index)) {
			byId.set(id, candidate);
		}
	}
	return [...byId.values()].sort((left, right) => left.index - right.index);
}

function createCollection(packs: ResolvedHandlerContextPack[], warnings: string[]): HandlerContextPackCollection {
	const byId = new Map(packs.map((pack) => [pack.id, pack]));
	return {
		all: () => [...packs],
		get: (id) => byId.get(id),
		byPurpose: (purpose) => packs.filter((pack) => pack.purpose === purpose),
		warnings: () => [...warnings],
	};
}

export async function resolveHandlerContextPacks(
	input: ResolveHandlerContextPacksInput,
): Promise<ResolveHandlerContextPacksResult> {
	const warnings: string[] = [];
	const packs: ResolvedHandlerContextPack[] = [];

	for (const candidate of mergeCandidates(collectCandidates(input))) {
		const compiled = compileDeclarativeContextQuery(candidate.query);
		warnings.push(...compiled.warnings.map((warning) => `${candidate.query.id}: ${warning}`));
		if (!compiled.ok || !compiled.compiled) {
			const detail = compiled.errors.join(' ');
			if (candidate.query.required) {
				throw new Error(`Required context query "${candidate.query.id}" failed validation: ${detail}`);
			}
			warnings.push(`Skipped context query "${candidate.query.id}": ${detail}`);
			continue;
		}

		const pack = await input.sdk.buildContextPack(compiled.compiled.request);
		packs.push({
			id: compiled.compiled.query.id,
			purpose: compiled.compiled.query.purpose,
			source: candidate.source,
			sourceRef: candidate.sourceRef,
			query: compiled.compiled.query,
			request: compiled.compiled.request,
			pack,
			warnings: compiled.compiled.warnings,
		});
		const inventory = codebaseInventoryFromPayload(input.taskPayload);
		if (inventory) {
			packs.push(...buildCodeContextPacksForQuery({
				query: compiled.compiled.query,
				inventory,
				source: candidate.source,
				sourceRef: candidate.sourceRef,
			}));
		}
	}

	return {
		contextPacks: createCollection(packs, warnings),
		warnings,
	};
}
