import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveWorkspaceReportPath } from '../../services/report-paths.ts';

export interface MessageChainStep {
	agent: string;
	inputMessageType: string;
	outputMessageTypes: string[];
}

export interface MessageChainResult {
	id: string;
	ok: boolean;
	steps: MessageChainStep[];
	messagesEmitted: string[];
	artifactsCreated: string[];
	approvalsCreated: string[];
	mutationsAttempted: string[];
	assertions: string[];
	store: {
		tasks: Array<Record<string, unknown>>;
		messages: Array<Record<string, unknown>>;
		artifacts: Array<Record<string, unknown>>;
		approvals: Array<Record<string, unknown>>;
		mutations: Array<Record<string, unknown>>;
	};
}

export function runInMemoryMessageChain(input: {
	id: string;
	initialMessageType: string;
	steps: MessageChainStep[];
	artifactsCreated?: string[];
	approvalsCreated?: string[];
	mutationsAttempted?: string[];
	requireApprovalBeforeMutation?: boolean;
}): MessageChainResult {
	const store = {
		tasks: [] as Array<Record<string, unknown>>,
		messages: [{
			id: `${input.id}:message:0`,
			type: input.initialMessageType,
			status: 'completed',
			payloadJson: JSON.stringify({ chainId: input.id }),
		}],
		artifacts: [] as Array<Record<string, unknown>>,
		approvals: [] as Array<Record<string, unknown>>,
		mutations: [] as Array<Record<string, unknown>>,
	};
	for (const [index, step] of input.steps.entries()) {
		store.tasks.push({
			id: `${input.id}:task:${index + 1}`,
			agentSlug: step.agent,
			inputMessageType: step.inputMessageType,
			status: 'completed',
		});
		for (const type of step.outputMessageTypes) {
			store.messages.push({
				id: `${input.id}:message:${store.messages.length}`,
				type,
				status: 'pending',
				payloadJson: JSON.stringify({
					chainId: input.id,
					sourceMessageType: step.inputMessageType,
					sourceTaskId: `${input.id}:task:${index + 1}`,
				}),
			});
		}
	}
	for (const kind of input.artifactsCreated ?? []) {
		store.artifacts.push({ id: `${input.id}:artifact:${kind}`, kind, sourceMessageId: store.messages.at(-1)?.id ?? null });
	}
	for (const kind of input.approvalsCreated ?? []) {
		store.approvals.push({ id: `${input.id}:approval:${kind}`, kind, status: kind.includes('release') ? 'pending' : 'approved' });
	}
	for (const path of input.mutationsAttempted ?? []) {
		store.mutations.push({
			id: `${input.id}:mutation:${store.mutations.length + 1}`,
			path,
			approvalId: store.approvals[0]?.id ?? null,
			verified: true,
		});
	}
	const messagesEmitted = store.messages.slice(1).map((message) => String(message.type));
	const assertions = [
		input.steps.every((step, index) => index === 0 || input.steps[index - 1]?.outputMessageTypes.includes(step.inputMessageType))
			? 'message order matches declared chain'
			: 'message order does not match declared chain',
		store.artifacts.every((artifact) => artifact.sourceMessageId)
			? 'artifacts retain source references'
			: 'artifact source references missing',
		input.requireApprovalBeforeMutation
			? (store.mutations.every((mutation) => mutation.approvalId) ? 'mutation approval gate satisfied' : 'mutation approval gate missing')
			: 'no mutation approval required',
	];
	return {
		id: input.id,
		ok: assertions.every((entry) => !entry.includes('does not') && !entry.includes('missing')),
		steps: input.steps,
		messagesEmitted,
		artifactsCreated: store.artifacts.map((artifact) => String(artifact.kind)),
		approvalsCreated: store.approvals.map((approval) => String(approval.kind)),
		mutationsAttempted: store.mutations.map((mutation) => String(mutation.path)),
		assertions,
		store,
	};
}

export function researchToKnowledgeNoMutationChain() {
	return runInMemoryMessageChain({
		id: 'research-to-knowledge-no-mutation',
		initialMessageType: 'knowledge_gap_detected',
		steps: [
			{ agent: 'architect', inputMessageType: 'knowledge_gap_detected', outputMessageTypes: ['research_task_requested'] },
			{ agent: 'researcher', inputMessageType: 'research_task_requested', outputMessageTypes: ['research_note_created'] },
			{ agent: 'technical-writer', inputMessageType: 'research_note_created', outputMessageTypes: ['knowledge_draft_created'] },
			{ agent: 'reviewer', inputMessageType: 'knowledge_draft_created', outputMessageTypes: ['knowledge_optimization_completed', 'promotion_request_created'] },
			{ agent: 'treeseed-governance-steward', inputMessageType: 'promotion_request_created', outputMessageTypes: ['approval_request_created'] },
		],
		artifactsCreated: ['research_note', 'knowledge_draft', 'optimization_report'],
		approvalsCreated: ['promotion_request'],
		mutationsAttempted: [],
	});
}

export function governedMutationApprovalChain() {
	return runInMemoryMessageChain({
		id: 'governed-mutation-approval',
		initialMessageType: 'approval_request_approved',
		steps: [
			{ agent: 'engineer', inputMessageType: 'approval_request_approved', outputMessageTypes: ['docs_mutation_completed'] },
			{ agent: 'reviewer', inputMessageType: 'docs_mutation_completed', outputMessageTypes: ['review_passed'] },
			{ agent: 'reporter', inputMessageType: 'review_passed', outputMessageTypes: ['workday_report_created'] },
			{ agent: 'releaser', inputMessageType: 'workday_report_created', outputMessageTypes: ['release_waiting_for_approval'] },
		],
		artifactsCreated: ['docs_mutation_snapshot', 'workday_report', 'release_readiness_summary'],
		approvalsCreated: ['release_approval_request'],
		mutationsAttempted: ['docs/**'],
		requireApprovalBeforeMutation: true,
	});
}

export function forbiddenPathFailureChain() {
	return runInMemoryMessageChain({
		id: 'forbidden-path-failure',
		initialMessageType: 'approval_request_approved',
		steps: [
			{ agent: 'engineer', inputMessageType: 'approval_request_approved', outputMessageTypes: ['docs_mutation_failed'] },
			{ agent: 'reporter', inputMessageType: 'docs_mutation_failed', outputMessageTypes: ['workday_report_created'] },
		],
		artifactsCreated: ['verification_failure_snapshot'],
		approvalsCreated: ['docs_mutation_approval'],
		mutationsAttempted: ['package.json'],
		requireApprovalBeforeMutation: true,
	});
}

function renderMessageChainReport(result: {
	ok: boolean;
	generatedAt: string;
	chains: MessageChainResult[];
}) {
	const lines = [
		'# Message Chain Report',
		'',
		`Generated: ${result.generatedAt}`,
		`Status: ${result.ok ? 'PASS' : 'FAIL'}`,
		'',
	];
	for (const chain of result.chains) {
		lines.push(
			`## ${chain.id}`,
			'',
			`Status: ${chain.ok ? 'PASS' : 'FAIL'}`,
			`Messages: ${chain.messagesEmitted.join(', ') || 'none'}`,
			`Artifacts: ${chain.artifactsCreated.join(', ') || 'none'}`,
			`Approvals: ${chain.approvalsCreated.join(', ') || 'none'}`,
			`Mutations attempted: ${chain.mutationsAttempted.join(', ') || 'none'}`,
			`Assertions: ${chain.assertions.join('; ') || 'none'}`,
			'',
		);
		for (const step of chain.steps) {
			lines.push(`- ${step.inputMessageType} -> ${step.agent} -> ${step.outputMessageTypes.join(', ')}`);
		}
		lines.push('');
	}
	return `${lines.join('\n')}\n`;
}

export async function runMessageChainSuite(input: {
	chains?: MessageChainResult[];
	reportPath?: string;
	now?: Date;
} = {}) {
	const chains = input.chains ?? [
		researchToKnowledgeNoMutationChain(),
		governedMutationApprovalChain(),
		forbiddenPathFailureChain(),
	];
	const resultWithoutPaths = {
		ok: chains.every((chain) => chain.ok)
			&& chains[0]?.mutationsAttempted.length === 0
			&& chains[1]?.mutationsAttempted.every((path) => path.startsWith('docs/'))
			&& chains[2]?.messagesEmitted.includes('docs_mutation_failed'),
		generatedAt: (input.now ?? new Date()).toISOString(),
		chains,
	};
	const reportPath = resolveWorkspaceReportPath(input.reportPath ?? '.treeseed/test-reports/message-chains.md');
	const jsonPath = resolveWorkspaceReportPath(reportPath.replace(/\.md$/u, '.json'));
	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(reportPath, renderMessageChainReport(resultWithoutPaths), 'utf8');
	await writeFile(jsonPath, `${JSON.stringify(resultWithoutPaths, null, 2)}\n`, 'utf8');
	return {
		...resultWithoutPaths,
		reportPath,
		jsonPath,
	};
}
