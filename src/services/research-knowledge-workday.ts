import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type { AgentTriggerInvocation } from '../agents/runtime-types.ts';
import type { KnowledgeDraft, OptimizationReport } from '../agents/contracts/knowledge.ts';
import type { ResearchNote } from '../agents/contracts/research.ts';
import type { KnowledgePipelineQuestion } from '../agents/knowledge/pipeline.ts';

export const RESEARCH_KNOWLEDGE_TASK_KINDS = [
	'research_question',
	'generate_knowledge_draft',
	'optimize_knowledge_draft',
	'promote_knowledge_draft_request',
	'promote_knowledge_to_staging',
	'apply_approved_docs_mutation',
	'create_repair_task',
	'release_staged_knowledge_request',
] as const;

export type ResearchKnowledgeTaskKind = typeof RESEARCH_KNOWLEDGE_TASK_KINDS[number];

export interface GeneratedAgentArtifactSummary {
	artifactKind: 'codebase_inventory' | 'research_note' | 'knowledge_draft' | 'optimization_report' | 'promotion_request' | 'docs_mutation_result' | 'release_request';
	id: string;
	title?: string;
	taskId?: string;
	questionId?: string;
	researchNoteId?: string;
	draftId?: string;
	reportId?: string;
	targetPath?: string;
	sourceRefs?: string[];
	sourceResearchIds?: string[];
	recommendation?: string;
	totalScore?: number;
	approvalKind?: string;
	stagingBranch?: string;
	featureBranch?: string;
	changedPaths?: string[];
	releaseDecision?: string;
	confidence?: string;
	issueCount?: number;
	criticalIssueCount?: number;
	verificationStatus?: string;
	mergedToStaging?: boolean;
	repairTaskId?: string;
}

export interface ResearchKnowledgeTaskOutputEnvelope {
	artifactKind: GeneratedAgentArtifactSummary['artifactKind'];
	codebaseInventory?: CodebaseInventoryArtifact;
	researchNote?: ResearchNote;
	knowledgeDraft?: KnowledgeDraft;
	optimizationReport?: OptimizationReport;
	promotionRequest?: Record<string, unknown>;
	docsMutationResult?: Record<string, unknown>;
	promotionToStaging?: Record<string, unknown>;
	implementationResult?: Record<string, unknown>;
	releaseRequest?: Record<string, unknown>;
	changedPaths?: string[];
	verification?: Record<string, unknown>;
	snapshots?: Record<string, unknown>[];
	repairTask?: Record<string, unknown>;
	mergedToStaging?: boolean;
	generatedArtifacts: GeneratedAgentArtifactSummary[];
	nextTaskId?: string | null;
	summary: {
		status: 'completed' | 'waiting' | 'failed';
		summary: string;
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecords(value: unknown) {
	return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)) : [];
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return '';
}

function parseOutputRecord(value: unknown) {
	const record = asRecord(value);
	const raw = typeof record.outputJson === 'string' ? record.outputJson : typeof record.output_json === 'string' ? record.output_json : record.output;
	if (raw && typeof raw === 'object') return asRecord(raw);
	if (typeof raw !== 'string' || !raw.trim()) return {};
	try {
		return asRecord(JSON.parse(raw));
	} catch {
		return {};
	}
}

export function isResearchKnowledgeTaskKind(value: unknown): value is ResearchKnowledgeTaskKind {
	return typeof value === 'string' && (RESEARCH_KNOWLEDGE_TASK_KINDS as readonly string[]).includes(value);
}

export function researchQuestionTaskIdempotencyKey(workDayId: string, questionId: string) {
	return `${workDayId}:research_question:${questionId}`;
}

function summarizeCodebaseInventoryArtifact(inventory: Record<string, unknown>, taskIdValue?: string): GeneratedAgentArtifactSummary {
	const packages = Array.isArray(inventory.packages) ? inventory.packages.length : undefined;
	const modules = Array.isArray(inventory.modules) ? inventory.modules.length : undefined;
	const warnings = Array.isArray(inventory.warnings) ? inventory.warnings.length : undefined;
	return {
		artifactKind: 'codebase_inventory',
		id: readString(inventory, 'id') || 'codebase-inventory',
		taskId: taskIdValue,
		title: readString(inventory, 'title') || 'Codebase inventory',
		issueCount: warnings,
		recommendation: [
			packages === undefined ? null : `${packages} packages`,
			modules === undefined ? null : `${modules} modules`,
		].filter(Boolean).join(', ') || undefined,
	};
}

export function invocationForResearchKnowledgeTask(
	kind: ResearchKnowledgeTaskKind,
	payload: Record<string, unknown>,
): AgentTriggerInvocation {
	return {
		kind: 'message',
		source: kind,
		trigger: { type: 'message', messageTypes: [kind] },
		message: {
			id: 0,
			type: kind,
			status: 'claimed',
			payloadJson: JSON.stringify(payload),
			relatedModel: null,
			relatedId: null,
			priority: 100,
			availableAt: '',
			claimedBy: null,
			claimedAt: null,
			leaseExpiresAt: null,
			attempts: 0,
			maxAttempts: 1,
			createdAt: '',
			updatedAt: '',
		},
	};
}

export function agentSpecForResearchKnowledgeHandler(kind: 'research' | 'knowledge_draft' | 'knowledge_optimization'): AgentRuntimeSpec {
	const handler = kind === 'research' ? 'research' : 'report';
	const projectAgentClassId = kind === 'research' ? 'research' : 'knowledge';
	return {
		slug: `${kind}-agent`,
		handler,
		projectAgentClassId,
		projectAgentClassSlug: projectAgentClassId,
		handlerConfig: { domain: kind },
		enabled: true,
		systemPrompt: `Deterministic ${kind} handler.`,
		persona: kind,
		cli: {},
		triggers: [{ type: 'message', messageTypes: [kind] }],
		permissions: [
			{ model: 'knowledge', operations: ['search', 'follow'] },
			{ model: 'question', operations: ['search', 'follow'] },
			{ model: 'message', operations: ['create', 'update', 'pick'] },
		],
		execution: {
			maxConcurrency: 1,
			timeoutSeconds: 900,
			cooldownSeconds: 0,
			leaseSeconds: 300,
			retryLimit: 0,
			branchPrefix: 'agent/research-knowledge',
				providerProfile: {
					requiredCapabilities: kind === 'research' ? ['treedx.read', 'research.synthesize'] : ['treedx.read', 'report.render'],
					preferredLanes: [],
					acceptableFallbacks: [],
					fallbackPolicy: 'allow_substitution',
				},
		},
		outputs: { messageTypes: [], modelMutations: [] },
		context: {
			queries: [{
				id: 'research-knowledge-workday',
				purpose: kind,
				query: kind,
				scope: '/',
				codeScopes: ['packages/agent/src/services', 'packages/agent/src/agents'],
			}],
		},
	};
}

export function summarizeResearchNoteArtifact(note: ResearchNote, taskIdValue?: string): GeneratedAgentArtifactSummary {
	return {
		artifactKind: 'research_note',
		id: note.id,
		taskId: taskIdValue,
		questionId: note.questionId,
		sourceRefs: note.sourceRefs.map((source) => source.ref),
	};
}

export function summarizeKnowledgeDraftArtifact(draft: KnowledgeDraft, taskIdValue?: string): GeneratedAgentArtifactSummary {
	return {
		artifactKind: 'knowledge_draft',
		id: draft.id,
		taskId: taskIdValue,
		title: draft.title,
		questionId: draft.sourceQuestionId,
		draftId: draft.id,
		targetPath: draft.targetPath,
		sourceResearchIds: draft.sourceResearchIds,
		confidence: draft.frontmatter.confidence,
	};
}

export function summarizeOptimizationReportArtifact(report: OptimizationReport, taskIdValue?: string): GeneratedAgentArtifactSummary {
	return {
		artifactKind: 'optimization_report',
		id: report.id,
		taskId: taskIdValue,
		draftId: report.draftId,
		reportId: report.id,
		recommendation: report.recommendation,
		totalScore: report.totalScore,
		issueCount: report.remainingIssues.length,
		criticalIssueCount: report.criticalIssues.length,
	};
}

export function summarizePromotionRequestArtifact(request: Record<string, unknown>, taskIdValue?: string): GeneratedAgentArtifactSummary {
	return {
		artifactKind: 'promotion_request',
		id: readString(request, 'id') || readString(request, 'draftId') || 'promotion-request',
		taskId: taskIdValue,
		approvalKind: readString(request, 'approvalKind') || 'promote_knowledge_draft',
		draftId: readString(request, 'draftId') || undefined,
		targetPath: readString(request, 'targetPath') || undefined,
		recommendation: readString(request, 'recommendation') || undefined,
		totalScore: Number.isFinite(Number(request.totalScore)) ? Number(request.totalScore) : undefined,
		sourceResearchIds: Array.isArray(request.sourceResearchIds) ? request.sourceResearchIds.filter((entry): entry is string => typeof entry === 'string') : undefined,
	};
}

export function summarizeReleaseRequestArtifact(request: Record<string, unknown>, taskIdValue?: string): GeneratedAgentArtifactSummary {
	return {
		artifactKind: 'release_request',
		id: readString(request, 'id') || readString(request, 'draftId') || 'release-request',
		taskId: taskIdValue,
		approvalKind: readString(request, 'approvalKind') || 'release_staged_knowledge',
		draftId: readString(request, 'draftId') || undefined,
		targetPath: readString(request, 'targetPath') || undefined,
		recommendation: readString(request, 'recommendation') || undefined,
		stagingBranch: readString(request, 'stagingBranch') || undefined,
		featureBranch: readString(request, 'featureBranch') || undefined,
		changedPaths: Array.isArray(request.changedPaths) ? request.changedPaths.filter((entry): entry is string => typeof entry === 'string') : undefined,
		sourceResearchIds: Array.isArray(request.sourceResearchIds) ? request.sourceResearchIds.filter((entry): entry is string => typeof entry === 'string') : undefined,
	};
}

export function summarizeDocsMutationResultArtifact(result: Record<string, unknown>, taskIdValue?: string): GeneratedAgentArtifactSummary {
	const repairTask = asRecord(result.repairTask);
	const verification = asRecord(result.verification);
	return {
		artifactKind: 'docs_mutation_result',
		id: readString(result, 'taskId') || taskIdValue || readString(result, 'draftId') || 'docs-mutation-result',
		taskId: taskIdValue || readString(result, 'taskId') || undefined,
		draftId: readString(result, 'draftId') || undefined,
		targetPath: readString(result, 'targetPath') || undefined,
		stagingBranch: readString(result, 'stagingBranch') || undefined,
		featureBranch: readString(result, 'featureBranch') || undefined,
		changedPaths: Array.isArray(result.changedPaths) ? result.changedPaths.filter((entry): entry is string => typeof entry === 'string') : undefined,
		verificationStatus: readString(verification, 'status') || (verification.ok === true ? 'completed' : verification.ok === false ? 'failed' : undefined),
		mergedToStaging: typeof result.mergedToStaging === 'boolean' ? result.mergedToStaging : undefined,
		repairTaskId: readString(repairTask, 'id') || readString(repairTask, 'taskId') || undefined,
	};
}

export function extractGeneratedArtifactsFromTaskOutputs(outputs: unknown[]): GeneratedAgentArtifactSummary[] {
	const artifacts: GeneratedAgentArtifactSummary[] = [];
	for (const output of outputs) {
		const record = asRecord(output);
		const outputTaskId = readString(record, 'taskId');
		const explicit = Array.isArray(record.generatedArtifacts) ? record.generatedArtifacts : [];
		for (const artifact of explicit) {
			const artifactRecord = asRecord(artifact);
			if (artifactRecord.artifactKind && artifactRecord.id) {
				artifacts.push(artifactRecord as unknown as GeneratedAgentArtifactSummary);
			}
		}
		if (asRecord(record.researchNote).kind === 'research_note') {
			artifacts.push(summarizeResearchNoteArtifact(asRecord(record.researchNote) as unknown as ResearchNote, outputTaskId || undefined));
		}
		if (asRecord(record.codebaseInventory).kind === 'codebase_inventory') {
			artifacts.push(summarizeCodebaseInventoryArtifact(asRecord(record.codebaseInventory), outputTaskId || undefined));
		}
		if (asRecord(record.knowledgeDraft).kind === 'knowledge_draft') {
			artifacts.push(summarizeKnowledgeDraftArtifact(asRecord(record.knowledgeDraft) as unknown as KnowledgeDraft, outputTaskId || undefined));
		}
		if (asRecord(record.optimizationReport).kind === 'knowledge_optimization_report') {
			artifacts.push(summarizeOptimizationReportArtifact(asRecord(record.optimizationReport) as unknown as OptimizationReport, outputTaskId || undefined));
		}
		if (record.promotionRequest) {
			artifacts.push(summarizePromotionRequestArtifact(asRecord(record.promotionRequest), outputTaskId || undefined));
		}
		const docsMutationResult = asRecord(record.docsMutationResult);
		const promotionToStaging = asRecord(record.promotionToStaging);
		const implementationResult = asRecord(record.implementationResult);
		if (Object.keys(docsMutationResult).length > 0) {
			artifacts.push(summarizeDocsMutationResultArtifact(docsMutationResult, outputTaskId || undefined));
		}
		if (Object.keys(promotionToStaging).length > 0) {
			artifacts.push(summarizeDocsMutationResultArtifact(promotionToStaging, outputTaskId || undefined));
		}
		if (Object.keys(implementationResult).length > 0) {
			artifacts.push(summarizeDocsMutationResultArtifact(implementationResult, outputTaskId || undefined));
		}
		if (record.releaseRequest) {
			artifacts.push(summarizeReleaseRequestArtifact(asRecord(record.releaseRequest), outputTaskId || undefined));
		}
	}
	const seen = new Set<string>();
	return artifacts.filter((artifact) => {
		const key = `${artifact.artifactKind}:${artifact.id}:${artifact.taskId ?? ''}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}
