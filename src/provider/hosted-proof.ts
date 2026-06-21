export interface HostedAgentPlatformProofInput {
	environment?: 'local' | 'staging';
	teamId: string;
	projectId: string;
	capacityProviderId: string;
	agentClassId: string;
	apiBaseUrl: string;
	adminToken: string;
	providerApiKey: string;
	fetchImpl?: typeof fetch;
}

export interface HostedAgentPlatformProofResult {
	ok: boolean;
	code?: string;
	blocking?: boolean;
	missing?: string[];
	environment: 'local' | 'staging';
	runId: string;
	teamId: string;
	projectId: string;
	capacityProviderId: string;
	assignmentId: string;
	modeRunIds: string[];
	treeDxAuditIds: string[];
	ledgerEntryIds: string[];
	fallbackOutputIds: string[];
	externalRefs: Array<{
		provider: string;
		ref: string;
		url?: string | null;
	}>;
	adminEvidence: {
		runtimeUrl: string;
		assignmentVisible: boolean;
		explanationVisible: boolean;
		modeRunVisible: boolean;
		treeDxAuditVisible: boolean;
		ledgerVisible: boolean;
	};
	checks: Array<{
		id: string;
		ok: boolean;
		summary: string;
		details?: Record<string, unknown>;
	}>;
}

const REQUIRED_ENV = {
	teamId: 'TREESEED_CAPACITY_ACCEPTANCE_TEAM_ID',
	projectId: 'TREESEED_CAPACITY_ACCEPTANCE_PROJECT_ID',
	capacityProviderId: 'TREESEED_CAPACITY_ACCEPTANCE_PROVIDER_ID',
	agentClassId: 'TREESEED_CAPACITY_ACCEPTANCE_AGENT_CLASS_ID',
	apiBaseUrl: 'TREESEED_CAPACITY_ACCEPTANCE_API_URL',
	adminToken: 'TREESEED_CAPACITY_ACCEPTANCE_ADMIN_TOKEN',
	providerApiKey: 'TREESEED_CAPACITY_PROVIDER_API_KEY',
} as const;

function environmentFromEnv(env: Record<string, string | undefined>) {
	const value = String(env.TREESEED_CAPACITY_ACCEPTANCE_ENVIRONMENT ?? env.TREESEED_PROVIDER_ENVIRONMENT ?? env.TREESEED_ENVIRONMENT ?? 'local').trim();
	return value === 'staging' ? 'staging' : 'local';
}

export function hostedAgentPlatformProofInputFromEnv(env: Record<string, string | undefined> = process.env): HostedAgentPlatformProofInput | { missing: string[] } {
	const environment = environmentFromEnv(env);
	const localDefaults = environment === 'local'
		? {
			TREESEED_CAPACITY_ACCEPTANCE_API_URL: env.TREESEED_CAPACITY_ACCEPTANCE_API_URL ?? env.TREESEED_MARKET_URL ?? env.TREESEED_MANAGEMENT_API_URL ?? env.TREESEED_API_BASE_URL ?? 'http://127.0.0.1:3000',
			TREESEED_CAPACITY_ACCEPTANCE_TEAM_ID: env.TREESEED_CAPACITY_ACCEPTANCE_TEAM_ID ?? 'treeseed',
			TREESEED_CAPACITY_ACCEPTANCE_PROJECT_ID: env.TREESEED_CAPACITY_ACCEPTANCE_PROJECT_ID ?? 'market',
			TREESEED_CAPACITY_ACCEPTANCE_PROVIDER_ID: env.TREESEED_CAPACITY_ACCEPTANCE_PROVIDER_ID ?? env.TREESEED_CAPACITY_PROVIDER_ID ?? 'treeseed-local-dev',
			TREESEED_CAPACITY_ACCEPTANCE_AGENT_CLASS_ID: env.TREESEED_CAPACITY_ACCEPTANCE_AGENT_CLASS_ID ?? 'planning',
			TREESEED_CAPACITY_PROVIDER_API_KEY: env.TREESEED_CAPACITY_PROVIDER_API_KEY ?? 'tsp_local_treeseed_demo_capacity_provider',
		}
		: {};
	const resolvedEnv = {
		...env,
		...localDefaults,
		TREESEED_CAPACITY_ACCEPTANCE_ADMIN_TOKEN: env.TREESEED_CAPACITY_ACCEPTANCE_ADMIN_TOKEN
			?? env.TREESEED_TEAM_API_KEY
			?? localDefaults.TREESEED_CAPACITY_PROVIDER_API_KEY,
	};
	const missing = Object.values(REQUIRED_ENV).filter((name) => !resolvedEnv[name]);
	if (missing.length) return { missing };
	return {
		environment,
		teamId: resolvedEnv.TREESEED_CAPACITY_ACCEPTANCE_TEAM_ID!,
		projectId: resolvedEnv.TREESEED_CAPACITY_ACCEPTANCE_PROJECT_ID!,
		capacityProviderId: resolvedEnv.TREESEED_CAPACITY_ACCEPTANCE_PROVIDER_ID!,
		agentClassId: resolvedEnv.TREESEED_CAPACITY_ACCEPTANCE_AGENT_CLASS_ID!,
		apiBaseUrl: resolvedEnv.TREESEED_CAPACITY_ACCEPTANCE_API_URL!,
		adminToken: resolvedEnv.TREESEED_CAPACITY_ACCEPTANCE_ADMIN_TOKEN!,
		providerApiKey: resolvedEnv.TREESEED_CAPACITY_PROVIDER_API_KEY!,
	};
}

function notConfigured(missing: string[], environment: 'local' | 'staging' = 'staging'): HostedAgentPlatformProofResult {
	return {
		ok: false,
		code: 'capacity_hosted_proof_not_configured',
		blocking: true,
		missing,
		environment,
		runId: `hosted-proof-${Date.now()}`,
		teamId: '',
		projectId: '',
		capacityProviderId: '',
		assignmentId: '',
		modeRunIds: [],
		treeDxAuditIds: [],
		ledgerEntryIds: [],
		fallbackOutputIds: [],
		externalRefs: [],
		adminEvidence: {
			runtimeUrl: '',
			assignmentVisible: false,
			explanationVisible: false,
			modeRunVisible: false,
			treeDxAuditVisible: false,
			ledgerVisible: false,
		},
		checks: missing.map((name) => ({
			id: `missing_${name.toLowerCase()}`,
			ok: false,
			summary: `${name} is required for hosted agent platform proof.`,
		})),
	};
}

async function getJson(fetchImpl: typeof fetch, baseUrl: string, token: string, path: string) {
	const response = await fetchImpl(`${baseUrl.replace(/\/$/u, '')}${path}`, {
		headers: {
			accept: 'application/json',
			authorization: `Bearer ${token}`,
		},
	});
	const text = await response.text();
	if (!response.ok) throw new Error(text || `Request failed with ${response.status}.`);
	return text ? JSON.parse(text) : {};
}

export async function runHostedAgentPlatformProof(inputOrEnv?: HostedAgentPlatformProofInput | Record<string, string | undefined>): Promise<HostedAgentPlatformProofResult> {
	const resolved = inputOrEnv && 'apiBaseUrl' in inputOrEnv
		? inputOrEnv
		: hostedAgentPlatformProofInputFromEnv(inputOrEnv as Record<string, string | undefined> | undefined);
	if ('missing' in resolved) {
		const env = inputOrEnv && !('apiBaseUrl' in inputOrEnv) ? inputOrEnv as Record<string, string | undefined> : process.env;
		return notConfigured(resolved.missing, environmentFromEnv(env));
	}
	const input = resolved;
	const fetchImpl = input.fetchImpl ?? fetch;
	const runId = `hosted-proof-${Date.now()}`;
	const checks: HostedAgentPlatformProofResult['checks'] = [];
	const diagnostics = await getJson(
		fetchImpl,
		input.apiBaseUrl,
		input.adminToken,
		`/v1/projects/${encodeURIComponent(input.projectId)}/capacity-runtime-diagnostics?teamId=${encodeURIComponent(input.teamId)}`,
	).then((body) => body.payload ?? body);
	const assignments = Array.isArray(diagnostics.assignments) ? diagnostics.assignments : [];
	const modeRuns = Array.isArray(diagnostics.modeRuns) ? diagnostics.modeRuns : [];
	const treeDxProxyAudit = Array.isArray(diagnostics.treeDxProxyAudit) ? diagnostics.treeDxProxyAudit : [];
	const ledgerEntries = Array.isArray(diagnostics.ledgerEntries) ? diagnostics.ledgerEntries : [];
	const fallbackOutputs = Array.isArray(diagnostics.fallbackOutputs) ? diagnostics.fallbackOutputs : [];
	const assignment = assignments.find((candidate: Record<string, unknown>) => candidate.capacityProviderId === input.capacityProviderId)
		?? assignments[0]
		?? null;
	checks.push({
		id: 'diagnostics_projection',
		ok: true,
		summary: 'Capacity runtime diagnostics projection is reachable.',
		details: { assignmentCount: assignments.length, modeRunCount: modeRuns.length },
	});
	checks.push({
		id: 'assignment_visible',
		ok: Boolean(assignment),
		summary: assignment ? 'At least one assignment is visible in Admin/API diagnostics.' : 'No assignment is visible for proof scope.',
	});
	checks.push({
		id: 'mode_run_visible',
		ok: modeRuns.length > 0,
		summary: modeRuns.length ? 'Mode-run evidence is visible.' : 'No mode-run evidence is visible.',
	});
	checks.push({
		id: 'treedx_audit_visible',
		ok: treeDxProxyAudit.length > 0,
		summary: treeDxProxyAudit.length ? 'TreeDX proxy audit evidence is visible.' : 'No TreeDX proxy audit evidence is visible.',
	});
	checks.push({
		id: 'ledger_visible',
		ok: ledgerEntries.length > 0,
		summary: ledgerEntries.length ? 'Capacity ledger evidence is visible.' : 'No capacity ledger evidence is visible.',
	});
	const ok = checks.every((check) => check.ok);
	return {
		ok,
		environment: input.environment ?? 'staging',
		runId,
		teamId: input.teamId,
		projectId: input.projectId,
		capacityProviderId: input.capacityProviderId,
		assignmentId: String(assignment?.id ?? ''),
		modeRunIds: modeRuns.map((run: Record<string, unknown>) => String(run.id ?? '')).filter(Boolean),
		treeDxAuditIds: treeDxProxyAudit.map((audit: Record<string, unknown>) => String(audit.id ?? '')).filter(Boolean),
		ledgerEntryIds: ledgerEntries.map((entry: Record<string, unknown>) => String(entry.id ?? '')).filter(Boolean),
		fallbackOutputIds: fallbackOutputs.map((output: Record<string, unknown>) => String(output.id ?? '')).filter(Boolean),
		externalRefs: modeRuns.flatMap((run: Record<string, unknown>) => {
			const traceRefs = run.traceRefs && typeof run.traceRefs === 'object' ? run.traceRefs as Record<string, unknown> : {};
			const ref = traceRefs.externalRef ?? traceRefs.threadId ?? null;
			return ref ? [{ provider: String(run.executionProviderId ?? 'execution_provider'), ref: String(ref), url: typeof traceRefs.externalUrl === 'string' ? traceRefs.externalUrl : null }] : [];
		}),
		adminEvidence: {
			runtimeUrl: `/app/capacity/runtime?projectId=${encodeURIComponent(input.projectId)}`,
			assignmentVisible: Boolean(assignment),
			explanationVisible: Array.isArray(diagnostics.explanations) && diagnostics.explanations.length > 0,
			modeRunVisible: modeRuns.length > 0,
			treeDxAuditVisible: treeDxProxyAudit.length > 0,
			ledgerVisible: ledgerEntries.length > 0,
		},
		checks,
	};
}
