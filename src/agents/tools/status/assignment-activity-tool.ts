import { agentActivityPageSchema,agentActivityQuerySchema } from '@treeseed/sdk/agent-capacity';

type RuntimeOptions = {
	apiBaseUrl: string;
	providerAccessToken: string;
	assignmentId: string;
	fetchImpl?: typeof fetch;
};

export async function readAssignmentActivity(options: RuntimeOptions, input: Record<string, unknown>) {
	const query = agentActivityQuerySchema.parse(input);
	const parameters = new URLSearchParams({ after: String(query.after), limit: String(query.limit) });
	for (const key of ['type', 'severity'] as const) {
		const value = query[key];
		if (Array.isArray(value)) parameters.set(key, value.join(','));
		else if (value) parameters.set(key, value);
	}
	const response = await (options.fetchImpl ?? fetch)(
		`${options.apiBaseUrl.replace(/\/+$/u, '')}/v1/provider/assignments/${encodeURIComponent(options.assignmentId)}/activity?${parameters}`,
		{ headers: { authorization: `Bearer ${options.providerAccessToken}`, accept: 'application/json' } },
	);
	const envelope = await response.json().catch(() => null) as { payload?: unknown; error?: string } | null;
	if (!response.ok) throw new Error(envelope?.error ?? `Assignment activity request failed with HTTP ${response.status}.`);
	return { ok: true, payload: agentActivityPageSchema.parse(envelope?.payload) };
}
