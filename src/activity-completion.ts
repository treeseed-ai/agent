type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
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
		reviewDisposition: { enum: ['approved', 'rejected', 'revision-required', null] },
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
