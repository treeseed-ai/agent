import { describeContentFrontmatterJsonSchema, validatePortableContentData } from '@treeseed/sdk/content-validation';
import { estimateSchema } from '@treeseed/sdk/agent-capacity';
import { isDeepStrictEqual } from 'node:util';

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

/** Retained V1 authority only. Current group contributions never select a class. */
export function estimateMutableField(item: JsonRecord, agentClass: string) {
	return agentClass === 'reviewer'
		? item.review === 'required' ? 'reviewEstimate' : undefined
		: item.agentClass === agentClass ? 'estimate' : undefined;
}

export function assignmentProposalSource(context: JsonRecord): JsonRecord {
	const source = record(record(context.assignment).sourceRef);
	const items = Array.isArray(context.context) ? context.context.map(record) : [];
	const item = items.find(item => ['store', 'model', 'id', 'repository', 'commit', 'path', 'revision', 'digest']
		.every(key => record(item.ref)[key] === source[key]));
	const proposal = record(record(item?.value).frontmatter);
	if (source.model !== 'proposal' || !Object.keys(proposal).length) throw new Error('assignment_exact_proposal_context_required');
	return proposal;
}

function estimateAuthority(proposal: JsonRecord, assignment: JsonRecord): JsonRecord {
	if (!text(assignment.id) || !Number.isSafeInteger(assignment.attempt) || Number(assignment.attempt) < 1
		|| record(assignment.effectiveProfile).activity !== 'estimating' || record(assignment.sourceRef).model !== 'proposal'
		|| record(assignment.sourceRef).id !== proposal.id) throw new Error('estimate_assignment_authority_required');
	return { store: 'postgresql', model: 'assignment-attempt', id: assignment.id, revision: assignment.attempt };
}

export function estimateProposalOutputSchema(proposal: JsonRecord, assignment: JsonRecord): JsonRecord {
	const schema = describeContentFrontmatterJsonSchema('proposal', text(proposal.schemaVersion) || 'treeseed.proposal/v1');
	if (proposal.schemaVersion === 'treeseed.proposal/v2') {
		const reference = estimateAuthority(proposal, assignment);
		const plan = record((record(record(schema.properties).executionPlan).anyOf as unknown[])[0]);
		const items = record(record(plan.properties).workItems), item = record(items.items);
		return { type: 'object', additionalProperties: false, required: ['executionPlan'], properties: {
			executionPlan: { type: 'object', additionalProperties: false, required: ['workItems'], properties: {
				workItems: { ...items, minItems: 1, items: { ...item,
					properties: { ...record(item.properties), estimateRef: fixedSchema(reference) } } },
			} },
		} };
	}
	const agentClass = text(assignment.agentClass), workItemId = text(assignment.workItemId);
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

/** Assemble a private candidate; canonical peer ownership is checked by the backend. */
export function mergeSubscriberEstimateOutput(proposal: JsonRecord, output: JsonRecord, assignment: JsonRecord): JsonRecord {
	if (proposal.schemaVersion !== 'treeseed.proposal/v2') throw new Error('estimate_current_group_proposal_required');
	const reference = estimateAuthority(proposal, assignment), plan = record(output.executionPlan), items = plan.workItems;
	if (Object.keys(output).some(key => key !== 'executionPlan') || Object.keys(plan).some(key => key !== 'workItems')
		|| !Array.isArray(items) || !items.length) throw new Error('estimate_proposal_patch_invalid');
	const owned = items.map(record), ids = new Set(owned.map(item => text(item.id)));
	if (ids.size !== owned.length || ids.has('') || owned.some(item => !isDeepStrictEqual(item.estimateRef, reference))) {
		throw new Error('estimate_proposal_patch_authority_invalid');
	}
	if (owned.some(item => !estimateSchema.safeParse(item.estimate).success
		|| (item.review === 'required' && !estimateSchema.safeParse(item.reviewEstimate).success))) throw new Error('estimate_proposal_patch_invalid');
	const frozenPlan = record(proposal.executionPlan), frozenItems = Array.isArray(frozenPlan.workItems) ? frozenPlan.workItems.map(record) : [];
	const merged = { ...proposal, executionPlan: { ...frozenPlan,
		workItems: [...frozenItems.filter(item => !ids.has(text(item.id))), ...owned].sort((a, b) => text(a.id).localeCompare(text(b.id))) } };
	if (!validatePortableContentData('proposal', merged).ok) throw new Error('estimate_proposal_patch_invalid');
	return merged;
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
export const verificationCompletionInstructions = 'Describe authorized local source preparation (including git add, git commit and dependency installation) in summary, never in verification.commands. verification.commands contains only exact standalone non-mutating checks you actually ran, with honest outcomes; do not include shell workflows, prose or publication commands. If no check was run, return verification: [].';

export function activityCompletionOutputSchema(frontmatterSchema?: Record<string, unknown>, allowVerification = true,
	outputVariants?: Array<{ model: string; frontmatter: Record<string, unknown> }>, reviewing = false, contentOptional = false) { return {
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
					commands: { type: 'array', description: verificationCompletionInstructions, maxItems: 1, items: { type: 'string', minLength: 1, maxLength: maximumVerificationCommandLength } },
				},
			},
		},
		reviewDisposition: reviewing
			? { type: 'string', enum: ['approved', 'rejected', 'revision-required'] }
			: { type: 'null' },
		// Acting and estimating require their exact governed product. Planning and
		// reporting may instead retain a summary Note through the same commit path.
		contentOutput: outputVariants?.length ? { anyOf: [...(contentOptional ? [{ type: 'null' }] : []), ...outputVariants.map(({ model, frontmatter }) => ({
			type: 'object', additionalProperties: false, required: ['model', 'body', 'frontmatter'],
			properties: { model: { type: 'string', const: model }, body: { type: 'string', minLength: 1 }, frontmatter },
		}))] } : frontmatterSchema ? {
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
