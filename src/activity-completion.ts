import { describeContentFrontmatterJsonSchema } from '@treeseed/sdk/content-validation';

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

const fixedSchema = (value: unknown): JsonRecord => {
	if (value === undefined || value === null) return { type: 'null', const: null };
	if (Array.isArray(value)) return { type: 'array', minItems: value.length, maxItems: value.length,
		items: value.length ? { anyOf: value.map(fixedSchema) } : { type: 'null' } };
	if (typeof value === 'object') {
		const entries = Object.entries(value as JsonRecord);
		return { type: 'object', additionalProperties: false, required: entries.map(([key]) => key),
			properties: Object.fromEntries(entries.map(([key, item]) => [key, fixedSchema(item)])) };
	}
	return { type: typeof value, const: value };
};

/** One estimate-write scope, shared by generation constraints and kernel validation. */
export function estimateMutableField(item: JsonRecord, workItemId?: string) {
	return workItemId ? item.id === workItemId ? 'estimate' : undefined
		: item.review === 'required' ? 'reviewEstimate' : undefined;
}

export function estimateProposalSource(context: JsonRecord): JsonRecord {
	const source = record(record(context.assignment).sourceRef);
	const items = Array.isArray(context.context) ? context.context.map(record) : [];
	const item = items.find(item => ['store', 'model', 'id', 'repository', 'commit', 'path']
		.every(key => record(item.ref)[key] === source[key]));
	const proposal = record(record(item?.value).frontmatter);
	if (source.model !== 'proposal' || !Object.keys(proposal).length) throw new Error('estimate_exact_proposal_context_required');
	return proposal;
}

export function estimateProposalOutputSchema(proposal: JsonRecord, workItemId?: string): JsonRecord {
	const schema = describeContentFrontmatterJsonSchema('proposal');
	const plan = record(proposal.executionPlan), items = plan.workItems;
	if (!Array.isArray(items) || !items.length || (workItemId && !items.some(item => record(item).id === workItemId))) {
		throw new Error('estimate_work_item_scope_missing');
	}
	const planSchema = record((record(record(schema.properties).executionPlan).anyOf as unknown[])[0]);
	const itemsSchema = record(record(planSchema.properties).workItems), itemSchema = record(itemsSchema.items);
	const lock = (shape: JsonRecord, base: JsonRecord, mutable: JsonRecord): JsonRecord => ({ ...shape,
		properties: Object.fromEntries(Object.keys(record(shape.properties)).map(key =>
			[key, mutable[key] ?? fixedSchema(base[key])])) });
	return lock(schema, proposal, { executionPlan: lock(planSchema, plan, { workItems: { ...itemsSchema,
		minItems: items.length, maxItems: items.length, items: { anyOf: items.map(value => {
			const item = record(value), field = estimateMutableField(item, workItemId);
			const editable = field ? record(record(itemSchema.properties)[field]) : {};
			return lock(itemSchema, item, field ? { [field]: (editable.anyOf as unknown[])[0] } : {});
		}) } } }) });
}
const omitTransportNulls = (value: unknown): unknown => Array.isArray(value) ? value.map(omitTransportNulls)
	: value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as JsonRecord)
		.filter(([, item]) => item !== null).map(([key, item]) => [key, omitTransportNulls(item)])) : value;

export interface ActivityCompletionReport {
	schemaVersion: 'treeseed.activity-completion/v1';
	summary: string;
	verification: Array<{ status: 'passed' | 'failed' | 'not-run' | 'unknown'; summary: string; commands: string[] }>;
	reviewDisposition: 'approved' | 'rejected' | 'revision-required' | null;
	contentOutput: { model: string; body: string; frontmatter: JsonRecord } | null;
}

export function activityCompletionOutputSchema(frontmatterSchema?: Record<string, unknown>) { return {
	type: 'object',
	additionalProperties: false,
	required: ['schemaVersion', 'summary', 'verification', 'reviewDisposition', 'contentOutput'],
	properties: {
		schemaVersion: { type: 'string', const: 'treeseed.activity-completion/v1' },
		summary: { type: 'string', minLength: 1 },
		verification: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['status', 'summary', 'commands'],
				properties: {
					status: { type: 'string', enum: ['passed', 'failed', 'not-run', 'unknown'] },
					summary: { type: 'string', minLength: 1 },
					commands: { type: 'array', items: { type: 'string', minLength: 1 } },
				},
			},
		},
		reviewDisposition: { type: ['string', 'null'], enum: ['approved', 'rejected', 'revision-required', null] },
		contentOutput: frontmatterSchema ? {
			anyOf: [{ type: 'null' }, {
					type: 'object', additionalProperties: false,
					required: ['model', 'body', 'frontmatter'],
					properties: {
						model: { type: 'string', minLength: 1 },
						body: { type: 'string', minLength: 1 },
						frontmatter: frontmatterSchema,
					},
				}],
		} : { type: 'null' },
	},
} as const; }

export function validateActivityCompletion(value: unknown): ActivityCompletionReport {
	const candidate = record(value), summary = text(candidate.summary);
	const verification = Array.isArray(candidate.verification) ? candidate.verification.map(record) : [];
	if (candidate.schemaVersion !== 'treeseed.activity-completion/v1' || !summary) throw new Error('Work execution omitted its structured activity completion report.');
	const normalized = verification.map((entry) => {
		const status = text(entry.status), entrySummary = text(entry.summary);
		if (!['passed', 'failed', 'not-run', 'unknown'].includes(status) || !entrySummary || !Array.isArray(entry.commands) || entry.commands.some((command) => !text(command))) {
			throw new Error('Activity completion verification entries are invalid.');
		}
		return { status: status as ActivityCompletionReport['verification'][number]['status'], summary: entrySummary, commands: entry.commands.map(String) };
	});
	const disposition = candidate.reviewDisposition === null ? null : text(candidate.reviewDisposition);
	if (disposition !== null && !['approved', 'rejected', 'revision-required'].includes(disposition)) throw new Error('Activity completion review disposition is invalid.');
	const outputCandidate = candidate.contentOutput === null ? null : record(candidate.contentOutput);
	const contentOutput = outputCandidate === null ? null : {
		model: text(outputCandidate.model), body: text(outputCandidate.body), frontmatter: record(omitTransportNulls(outputCandidate.frontmatter)),
	};
	if (contentOutput && (!contentOutput.model || !contentOutput.body || !Object.keys(contentOutput.frontmatter).length)) throw new Error('Activity completion content output is invalid.');
	return { schemaVersion: 'treeseed.activity-completion/v1', summary, verification: normalized,
		reviewDisposition: disposition as ActivityCompletionReport['reviewDisposition'], contentOutput };
}
