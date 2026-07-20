import {
	CodexExecutionTimeoutError,
	CodexRequestSafetyError,
	buildCodexPrompt,
	createDefaultCodexClient,
	isChangedPathAllowed,
	mapCodexThreadOptions,
	normalizeChangedPath,
	safetyResult,
	validateCodexExecutionRequest,
	withTimeout,
	type CodexExecutionRequest,
	type CodexExecutionResult,
	type CodexRunResult,
	type RunCodexSubscriptionTaskOptions,
} from './execution-codex-core.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown) {
	return typeof value === 'string' ? value : undefined;
}

function extractCommand(item: Record<string, unknown>) {
	return item.type === 'command_execution' ? stringValue(item.command) : undefined;
}

function extractFileChangePaths(item: Record<string, unknown>) {
	if (item.type !== 'file_change' || !Array.isArray(item.changes)) return [];
	return item.changes
		.map((change) => isRecord(change) ? stringValue(change.path) : undefined)
		.filter((path): path is string => Boolean(path));
}

function commandLooksLikeVerification(command: string) {
	return /\b(test|check|build|verify|lint|vitest|jest)\b|npm\s+(run\s+)?test/u.test(command);
}

function unique(values: string[]) {
	return [...new Set(values)];
}

function failedScopeResult(input: {
	request: CodexExecutionRequest;
	threadId: string;
	finalResponse: string;
	changedPaths: string[];
	proposedCommands: string[];
	verificationHints: string[];
	rawEventRefs: string[];
	wallMs: number;
	violatingPath: string;
}) {
	return {
		provider: 'codex',
		threadId: input.threadId,
		status: 'failed',
		finalResponse: input.finalResponse,
		summary: `${input.violatingPath} is outside the approved Codex mutation scope.`,
		changedPaths: input.changedPaths,
		proposedCommands: input.proposedCommands,
		verificationHints: input.verificationHints,
		rawEventRefs: input.rawEventRefs,
		error: {
			code: 'changed_path_scope_violation',
			message: `${input.violatingPath} is outside the approved Codex mutation scope.`,
			retryable: true,
		},
		usage: {
			subscriptionPlan: String(input.request.metadata?.subscriptionPlan ?? ''),
			wallMs: input.wallMs,
			wallMinutes: input.wallMs / 60_000,
			nativeUnit: 'wall_minute',
			filesChanged: input.changedPaths.length,
		},
		metadata: {
			allowedPaths: input.request.allowedPaths,
			forbiddenPaths: input.request.forbiddenPaths,
			violatingPath: input.violatingPath,
		},
	} satisfies CodexExecutionResult;
}

export function normalizeCodexRunResult(input: {
	request: CodexExecutionRequest;
	result: CodexRunResult;
	threadId: string;
	wallMs: number;
}): CodexExecutionResult {
	const items = input.result.items?.filter(isRecord) ?? [];
	const prompt = buildCodexPrompt(input.request);
	const threadOptions = mapCodexThreadOptions(input.request);
	const rawEventRefs = unique(items.map((item) => stringValue(item.id)).filter((id): id is string => Boolean(id)));
	const proposedCommands = unique(items.map(extractCommand).filter((command): command is string => Boolean(command)));
	const pathRoot = input.request.worktreeRoot ?? input.request.repoRoot;
	const changedPaths = unique(items.flatMap(extractFileChangePaths).map((path) => normalizeChangedPath(path, pathRoot)));
	const verificationHints = unique(proposedCommands.filter(commandLooksLikeVerification));
	const finalResponse = input.result.finalResponse ?? '';
	const summary = finalResponse.split('\n').find((line) => line.trim())?.trim() || 'Codex SDK task completed.';

	if (input.request.sandboxMode === 'workspace_write') {
		const violatingPath = changedPaths.find((path) => !isChangedPathAllowed(
			path,
			input.request.allowedPaths,
			input.request.forbiddenPaths,
		));
		if (violatingPath) {
			return failedScopeResult({
				request: input.request,
				threadId: input.threadId,
				finalResponse,
				changedPaths,
				proposedCommands,
				verificationHints,
				rawEventRefs,
				wallMs: input.wallMs,
				violatingPath,
			});
		}
	}

	return {
		provider: 'codex',
		threadId: input.threadId,
		status: 'completed',
		finalResponse,
		summary,
		changedPaths,
		proposedCommands,
		verificationHints,
		rawEventRefs,
		usage: {
			subscriptionPlan: String(input.request.metadata?.subscriptionPlan ?? ''),
			estimatedCredits: undefined,
			wallMs: input.wallMs,
			wallMinutes: input.wallMs / 60_000,
			nativeUnit: 'wall_minute',
			inputTokens: input.result.usage?.input_tokens ?? null,
			outputTokens: input.result.usage?.output_tokens ?? null,
			cachedInputTokens: input.result.usage?.cached_input_tokens ?? null,
			filesChanged: changedPaths.length,
		},
		metadata: {
			usage: input.result.usage ?? null,
			rawItems: items,
			request: {
				model: input.request.model ?? null,
				reasoningEffort: input.request.reasoningEffort ?? null,
				sandboxMode: input.request.sandboxMode,
				approvalPolicy: input.request.approvalPolicy,
				timeoutMs: input.request.timeoutMs ?? null,
				threadOptions,
				allowedPaths: input.request.allowedPaths,
				forbiddenPaths: input.request.forbiddenPaths,
				toolCount: input.request.tools?.length ?? 0,
				tools: input.request.tools ?? [],
				promptCharacters: prompt.length,
				prompt,
			},
		},
	};
}

export async function runCodexSubscriptionTask(
	request: CodexExecutionRequest,
	options: RunCodexSubscriptionTaskOptions = {},
): Promise<CodexExecutionResult> {
	const startedAt = options.now?.() ?? Date.now();
	try {
		validateCodexExecutionRequest(request);
	} catch (error) {
		if (error instanceof CodexRequestSafetyError) {
			return safetyResult(request, error);
		}
		throw error;
	}

	try {
		const createCodexClient = options.createCodexClient ?? createDefaultCodexClient;
		const client = await createCodexClient(request);
		const threadOptions = mapCodexThreadOptions(request);
		const thread = request.threadId
			? client.resumeThread(request.threadId, threadOptions)
			: client.startThread(threadOptions);
		const prompt = buildCodexPrompt(request);
		const runPromise = thread.run(prompt);
		runPromise.catch(() => null);
		const result = await withTimeout(runPromise, request.timeoutMs ?? 900_000);
		const wallMs = (options.now?.() ?? Date.now()) - startedAt;
		return normalizeCodexRunResult({
			request,
			result,
			threadId: thread.id ?? request.threadId ?? '',
			wallMs,
		});
	} catch (error) {
		if (error instanceof CodexExecutionTimeoutError) {
			const wallMs = (options.now?.() ?? Date.now()) - startedAt;
			const prompt = buildCodexPrompt(request);
			return {
				provider: 'codex',
				threadId: request.threadId ?? '',
				status: 'failed',
				summary: error.message,
				changedPaths: [],
				proposedCommands: [],
				verificationHints: [],
				error: {
					code: 'codex_execution_timeout',
					message: error.message,
					retryable: true,
				},
				usage: {
					subscriptionPlan: String(request.metadata?.subscriptionPlan ?? ''),
					wallMs,
					wallMinutes: wallMs / 60_000,
					nativeUnit: 'wall_minute',
					inputTokens: null,
					outputTokens: null,
					cachedInputTokens: null,
					filesChanged: 0,
				},
				metadata: {
					timeoutMs: error.timeoutMs,
					request: {
						model: request.model ?? null,
						reasoningEffort: request.reasoningEffort ?? null,
						sandboxMode: request.sandboxMode,
						approvalPolicy: request.approvalPolicy,
						timeoutMs: request.timeoutMs ?? null,
						threadOptions: mapCodexThreadOptions(request),
						allowedPaths: request.allowedPaths,
						forbiddenPaths: request.forbiddenPaths,
						toolCount: request.tools?.length ?? 0,
						tools: request.tools ?? [],
						promptCharacters: prompt.length,
						prompt,
					},
				},
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		const prompt = buildCodexPrompt(request);
		return {
			provider: 'codex',
			threadId: request.threadId ?? '',
			status: 'failed',
			summary: `Codex SDK boundary could not be initialized: ${message}`,
			changedPaths: [],
			proposedCommands: [],
			verificationHints: [],
			error: {
				code: 'codex_sdk_initialization_failed',
				message,
				retryable: true,
			},
			metadata: {
				request: {
					model: request.model ?? null,
					reasoningEffort: request.reasoningEffort ?? null,
					sandboxMode: request.sandboxMode,
					approvalPolicy: request.approvalPolicy,
					timeoutMs: request.timeoutMs ?? null,
					threadOptions: mapCodexThreadOptions(request),
					allowedPaths: request.allowedPaths,
					forbiddenPaths: request.forbiddenPaths,
					toolCount: request.tools?.length ?? 0,
					tools: request.tools ?? [],
					promptCharacters: prompt.length,
					prompt,
				},
			},
		};
	}
}

