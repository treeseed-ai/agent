import { describeContentFrontmatterJsonSchema } from '@treeseed/sdk/content-validation';

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

const fixedSchema = (value: unknown): JsonRecord => {
	if (value === undefined || value === null) return { type: 'null' };
	if (Array.isArray(value)) return { type: 'array', minItems: value.length, maxItems: value.length,
		items: value.length ? { anyOf: value.map(fixedSchema) } : { type: 'null' } };
	if (typeof value === 'object') {
		const entries = Object.entries(value as JsonRecord);
		return { type: 'object', additionalProperties: false, required: entries.map(([key]) => key),
			properties: Object.fromEntries(entries.map(([key, item]) => [key, fixedSchema(item)])) };
	}
	return { type: typeof value, const: value };
};

/** One class-owned estimate scope, shared by generation constraints and kernel validation. */
export function estimateMutableField(item: JsonRecord, agentClass: string) {
	return agentClass === 'reviewer'
		? item.review === 'required' ? 'reviewEstimate' : undefined
		: item.agentClass === agentClass ? 'estimate' : undefined;
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

export function estimateProposalOutputSchema(proposal: JsonRecord, agentClass: string, workItemId?: string): JsonRecord {
	const schema = describeContentFrontmatterJsonSchema('proposal');
	const plan = record(proposal.executionPlan), items = plan.workItems;
	if (!Array.isArray(items) || !items.some(item => estimateMutableField(record(item), agentClass))) {
		throw new Error('estimate_work_item_scope_missing');
	}
	const planSchema = record((record(record(schema.properties).executionPlan).anyOf as unknown[])[0]);
	const itemsSchema = record(record(planSchema.properties).workItems), itemSchema = record(itemsSchema.items);
	const owned = items.map(record).flatMap(item => {
		const field = estimateMutableField(item, agentClass);
		if (!field || (workItemId && item.id !== workItemId)) return [];
		const editable = record(record(itemSchema.properties)[field]);
		return [{ type: 'object', additionalProperties: false, required: [...(workItemId ? [] : ['id']), field], properties: {
			...(workItemId ? {} : { id: fixedSchema(item.id) }), [field]: (editable.anyOf as unknown[])[0],
		} }];
	});
	if (!owned.length) throw new Error('estimate_work_item_scope_missing');
	// The model returns only the estimate fields it owns. AgentKernel merges this
	// compact patch into the exact proposal before committing canonical content.
	// Requiring the model to reproduce every immutable proposal byte made a
	// bounded estimating turn spend most of its budget serializing duplicated data.
	return { type: 'object', additionalProperties: false, required: ['executionPlan'], properties: {
		executionPlan: { type: 'object', additionalProperties: false, required: ['workItems'], properties: {
			workItems: { type: 'array', minItems: owned.length, maxItems: owned.length, items: { anyOf: owned } },
		} },
	} };
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

export const maximumVerificationCommands = 8;
export const maximumVerificationCommandLength = 4096;

export function activityCompletionOutputSchema(frontmatterSchema?: Record<string, unknown>, allowVerification = true,
	outputVariants?: Array<{ model: string; frontmatter: Record<string, unknown> }>) { return {
	type: 'object',
	additionalProperties: false,
	required: ['schemaVersion', 'summary', 'verification', 'reviewDisposition', 'contentOutput'],
	properties: {
		schemaVersion: { type: 'string', const: 'treeseed.activity-completion/v1' },
		summary: { type: 'string', minLength: 1 },
		verification: {
			type: 'array',
			maxItems: allowVerification ? maximumVerificationCommands : 0,
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['status', 'summary', 'commands'],
				properties: {
					status: { type: 'string', enum: ['passed', 'failed', 'not-run', 'unknown'] },
					summary: { type: 'string', minLength: 1 },
					// The model API does not accept lookaround patterns. The guest
					// validates each command before runner-observed replay instead.
					commands: { type: 'array', maxItems: 1, items: { type: 'string', minLength: 1, maxLength: maximumVerificationCommandLength } },
				},
			},
		},
		reviewDisposition: { type: ['string', 'null'], enum: ['approved', 'rejected', 'revision-required', null] },
		// Exact output variants are supplied only for acting TreeDX Writer assignments.
		// Requiring one here prevents the provider from satisfying the transport schema
		// with null and failing later at the AgentKernel commit boundary.
		contentOutput: outputVariants?.length ? { anyOf: outputVariants.map(({ model, frontmatter }) => ({
			type: 'object', additionalProperties: false, required: ['model', 'body', 'frontmatter'],
			properties: { model: { type: 'string', const: model }, body: { type: 'string', minLength: 1 }, frontmatter },
		})) } : frontmatterSchema ? {
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

export function validateActivityCompletion(value: unknown, allowVerification = true): ActivityCompletionReport {
	const candidate = record(value), summary = text(candidate.summary);
	const verification = Array.isArray(candidate.verification) ? candidate.verification.map(record) : [];
	if (candidate.schemaVersion !== 'treeseed.activity-completion/v1' || !summary) throw new Error('Work execution omitted its structured activity completion report.');
	if (!allowVerification && verification.length) throw new Error('Planning and estimating cannot claim acceptance verification.');
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
