import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ExecutionProviderDescriptor, ExecutionRunSnapshot } from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation, ExecutionProviderToolDescriptor } from '../runtime-types.ts';
import { AgentWorktreeManager, changedPathViolations } from '../../services/agent-worktrees.ts';
import { type AgentToolCallTelemetry, type AgentToolRuntimeOptions } from '../tools/agent-tool-runtime.ts';
import { callAgentToolWithTelemetry } from '../tools/agent-tool-telemetry.ts';
import { treeDxContentReceipts } from '../adapters/execution-codex.ts';
import type { ResearchSourcePolicy } from '@treeseed/sdk/agent-capacity';

export type DeterministicExecutionStep =
	| { kind: 'write-file'; path: string; content: string }
	| { kind: 'tool'; toolId: string; input?: Record<string, unknown> }
	| { kind: 'output'; outputs?: Record<string, unknown>; signals?: Array<{ code: string; severity: 'info' | 'warning' | 'error'; message?: string }>; verification?: Record<string, unknown> };

export interface DeterministicToolProviderOptions {
	repoRoot: string;
	steps(input: ExecutionProviderInvocation): DeterministicExecutionStep[] | Promise<DeterministicExecutionStep[]>;
	prepareWorktree?: (input: { assignmentId: string; agentSlug: string; exactBaseRef: string; repoRoot: string }) => Promise<{ worktreeRoot: string; branchName: string; exactBaseRef: string }>;
	callTool?: typeof callAgentToolWithTelemetry;
	apiBaseUrl?: string;
	providerAccessToken?: string;
	researchSourcePolicy?: ResearchSourcePolicy;
}

function descriptor(): ExecutionProviderDescriptor {
	return {
		id: 'deterministic-tool', kind: 'deterministic_workflow', capabilities: ['planning', 'acting', 'verification', 'repo_read', 'repo_write'],
		capabilityAliases: ['deterministic-tool'], nativeUnit: 'deterministic_step', quotaVisibility: 'exact', maxConcurrentAssignments: 1,
		supportsAsync: false, supportsCancel: false, supportsResume: false, supportsUsage: true, supportsArtifacts: true,
	};
}

function text(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : ''; }
function metadataWithWorktree(descriptor: ExecutionProviderToolDescriptor, worktreeRoot: string) {
	return { ...descriptor, metadata: { ...(descriptor.metadata ?? {}), worktreeRoot } };
}

async function defaultWorktree(input: { assignmentId: string; agentSlug: string; exactBaseRef: string; repoRoot: string }) {
	return new AgentWorktreeManager(input.repoRoot).createOrResumeWorktree(
		`agent/${input.agentSlug}/${input.assignmentId}`, input.assignmentId, input.exactBaseRef,
	);
}

function scopedPath(root: string, path: string, allowedPaths: string[], forbiddenPaths: string[]) {
	if (!path || isAbsolute(path)) throw new Error(`Deterministic source path must be relative: ${path}`);
	const target = resolve(root, path);
	const fromRoot = relative(root, target).replace(/\\/gu, '/');
	if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot)) throw new Error(`Deterministic source path escapes the assignment worktree: ${path}`);
	const violations = changedPathViolations({ changedPaths: [fromRoot], allowedPaths, forbiddenPaths });
	if (violations.length) throw new Error(`Deterministic source path is outside assignment authority: ${path}`);
	return { target, path: fromRoot };
}

export class DeterministicToolExecutionProviderAdapter implements ExecutionProviderAdapter {
	private readonly assignmentWorktrees = new Map<string, string>();
	constructor(private readonly options: DeterministicToolProviderOptions) {}
	describe() { return Promise.resolve(descriptor()); }
	observe() { return Promise.resolve({ descriptor: descriptor(), available: true, activeAssignmentCount: 0 }); }

	async start(input: ExecutionProviderInvocation): Promise<ExecutionRunSnapshot> {
		const exactBaseRef = text(input.metadata?.exactBaseRef);
		const workspaceWrite = input.agent.execution.sandboxMode === 'workspace_write';
		if (workspaceWrite && !exactBaseRef) throw new Error('Deterministic workspace-write execution requires exactBaseRef.');
		const worktree = workspaceWrite
			? await (this.options.prepareWorktree ?? defaultWorktree)({ assignmentId: input.assignment.id, agentSlug: input.agent.slug, exactBaseRef, repoRoot: this.options.repoRoot })
			: { worktreeRoot: this.options.repoRoot, branchName: '', exactBaseRef: '' };
		if (workspaceWrite && exactBaseRef && !worktree.exactBaseRef.toLowerCase().startsWith(exactBaseRef.toLowerCase())) {
			throw new Error(`Deterministic worktree base ref mismatch: requested ${exactBaseRef}, observed ${worktree.exactBaseRef}.`);
		}
		if (workspaceWrite) this.assignmentWorktrees.set(input.assignment.id, worktree.worktreeRoot);
		const allowedPaths = input.agent.execution.allowedPaths ?? [];
		const forbiddenPaths = input.agent.execution.forbiddenPaths ?? [];
		const tools = (input.tools ?? []).map((tool) => metadataWithWorktree(tool, worktree.worktreeRoot));
		const telemetry: AgentToolCallTelemetry[] = [];
		const changedPaths: string[] = [];
		const outputs: Record<string, unknown> = {};
		const runtime: AgentToolRuntimeOptions = {
			apiBaseUrl: this.options.apiBaseUrl ?? '', providerAccessToken: this.options.providerAccessToken ?? '',
			assignmentId: input.assignment.id, leaseToken: input.leaseToken, descriptors: tools,
			repoRoot: worktree.worktreeRoot, onTelemetry: (entry) => { telemetry.push(entry); },
			researchSourcePolicy: this.options.researchSourcePolicy,
		};
		const steps = await this.options.steps(input);
		if (!workspaceWrite && steps.some((step) => step.kind === 'write-file')) {
			throw new Error('Deterministic source mutation requires a workspace-write assignment.');
		}
		for (const step of steps) {
			if (step.kind === 'write-file') {
				const scoped = scopedPath(worktree.worktreeRoot, step.path, allowedPaths, forbiddenPaths);
				await mkdir(dirname(scoped.target), { recursive: true });
				await writeFile(scoped.target, step.content, 'utf8');
				changedPaths.push(scoped.path);
			} else if (step.kind === 'tool') {
				const result = await (this.options.callTool ?? callAgentToolWithTelemetry)(runtime, step.toolId, step.input ?? {});
				if ((result as Record<string, unknown>).ok === false) throw new Error(`Deterministic tool ${step.toolId} failed: ${String((result as Record<string, unknown>).message ?? 'unknown error')} (${JSON.stringify((result as Record<string, unknown>).metadata ?? {})})`);
			} else {
				if (step.outputs) Object.assign(outputs, step.outputs);
				if (step.signals) outputs.signals = step.signals;
				if (step.verification) outputs.verification = step.verification;
			}
		}
		const telemetryRecords = telemetry as unknown as Record<string, unknown>[];
		return {
			status: 'completed', runId: `${input.assignment.id}:deterministic-tool`, summary: 'Deterministic governed execution completed.',
			outputs: { ...outputs, toolTelemetry: telemetry },
			usage: [{ kind: 'deterministic_steps', unit: 'step', amount: steps.length, source: 'deterministic-tool' }],
			artifacts: [
				...treeDxContentReceipts(telemetryRecords),
				...changedPaths.map((path) => ({ kind: 'changed_path', name: path, uri: `repo://${path}` })),
			],
			metadata: { executionProviderMode: 'deterministic-tool', worktreeRoot: worktree.worktreeRoot, worktreeBranch: worktree.branchName, baseRef: worktree.exactBaseRef, toolTelemetry: telemetry },
		};
	}

	async releaseAssignmentResources(input: { assignmentId: string; outcome: 'completed' | 'returned' | 'failed' | 'expired' }) {
		const worktreeRoot = this.assignmentWorktrees.get(input.assignmentId);
		if (!worktreeRoot || input.outcome !== 'completed') return;
		await new AgentWorktreeManager(this.options.repoRoot).releaseWorktree(worktreeRoot);
		this.assignmentWorktrees.delete(input.assignmentId);
	}
}
