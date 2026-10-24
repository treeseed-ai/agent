import { estimateProposalOutputSchema, assignmentProposalSource, maximumVerificationCommands, maximumVerificationCommandLength, type ActivityCompletionReport } from '../../activity-completion.ts';
import { describeContentFrontmatterJsonSchema, isPortableContentModel } from '@treeseed/sdk/content-validation';

export const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function providerToolName(event: Record<string, unknown>) {
	if (event.type !== 'item.started' && event.type !== 'item.completed') return null;
	const item = record(event.item);
	if (item.type === 'mcp_tool_call') return `${text(item.server)}:${text(item.tool)}`;
	if (['command_execution', 'file_change', 'web_search'].includes(text(item.type))) return text(item.type);
	return null;
}

/** Codex JSON item counters restart for each exec/resume process. Keep native IDs unchanged. */
export function providerItemIdentity(event: Record<string, unknown>): string {
	const invocation = event.providerInvocation === undefined ? 0 : event.providerInvocation;
	if (!Number.isSafeInteger(invocation) || Number(invocation) < 0) throw new Error('provider_invocation_identity_invalid');
	return `${invocation}:${String(record(event.item).id)}`;
}
export function scopeProviderEvent(event: Record<string, unknown>, invocation: number): Record<string, unknown> {
	if (!Number.isSafeInteger(invocation) || invocation < 0) throw new Error('provider_invocation_identity_invalid');
	const { providerInvocation: _untrusted, ...original } = event;
	return invocation === 0 ? original : { ...original, providerInvocation: invocation };
}

export function codexToolInFlight(events: Record<string, unknown>[]) {
	const active = new Set<string>();
	for (const event of events) {
		const tool = providerToolName(event);
		if (!tool) continue;
		const key = providerItemIdentity(event);
		if (event.type === 'item.started') active.add(key);
		else active.delete(key);
	}
	return active.size > 0;
}

export function codexIdleTimeoutMs(durationSeconds: number) {
	// A short assignment must not spend half its active window silent before its
	// one safe continuation. Longer assignments retain the existing 90s ceiling.
	return durationSeconds >= 120 ? Math.min(90_000, Math.floor(durationSeconds * 250)) : undefined;
}

export function codexCloseoutTimeoutMs(durationSeconds: number, activity: string) {
	if (!['planning', 'estimating', 'acting', 'reviewing', 'reporting', 'chat'].includes(activity)) return undefined;
	// The same allocator-issued window must still contain the final clock check,
	// response and custody closeout for every canonical activity. An estimate has a structured proposal patch
	// to return, so reserve up to 90s after bounded inspection. This guard does
	// not extend the allocator-issued duration or change provider accounting.
	if (durationSeconds < 35) return undefined;
	if (durationSeconds < 90) {
		// Short chat/review turns need the same bounded completion opportunity.
		// Reserve at least 30s inside the issued window: the existing 5s hard
		// margin and 3s process drainage still leave the unchanged 20s resume gate.
		return (durationSeconds - Math.max(30, durationSeconds / 2)) * 1_000;
	}
	const reserveSeconds = activity === 'estimating'
		? Math.min(90, Math.max(45, durationSeconds - 90)) : 45;
	return (durationSeconds - reserveSeconds) * 1_000;
}

export function codexResumeIdleTimeoutMs(remainingMs: number) {
	// A silent first continuation can consume the whole assignment. Leave at
	// least 30s for one final response without extending the original deadline.
	return remainingMs >= 70_000 ? Math.min(40_000, remainingMs - 30_000) : undefined;
}

export function completionFrontmatterSchema(context: Record<string, unknown>) {
	const assignment = record(record(context.canonicalAssignmentContext).assignment), profile = record(assignment.effectiveProfile);
	if (text(profile.activity) === 'estimating') {
		const proposal = assignmentProposalSource(record(context.canonicalAssignmentContext));
		return estimateProposalOutputSchema(proposal, assignment);
	}
	if (text(profile.activity) !== 'acting' || text(record(assignment.workspace).mode) !== 'treedx') return undefined;
	const grants = record(assignment.grant).contentWrite;
	const models = [...new Set((Array.isArray(grants) ? grants : []).map(reference => text(record(reference).model)))];
	return models.length ? { anyOf: models.map(model => {
		if (!isPortableContentModel(model)) throw new Error('writer_content_model_invalid');
		return describeContentFrontmatterJsonSchema(model);
	}) } : undefined;
}

export function completionOutputTargetVariants(context: Record<string, unknown>) {
	const assignment = record(record(context.canonicalAssignmentContext).assignment), profile = record(assignment.effectiveProfile);
	if (text(profile.activity) === 'estimating') {
		const proposal = assignmentProposalSource(record(context.canonicalAssignmentContext));
		return [{ model: 'proposal', frontmatter: estimateProposalOutputSchema(proposal, assignment) }];
	}
	if (text(profile.activity) !== 'acting' || text(record(assignment.workspace).mode) !== 'treedx') return [];
	const grants = record(assignment.grant).contentWrite;
	return (Array.isArray(grants) ? grants : []).map(record)
		.filter((target) => text(target.id))
		.map((target) => {
			const model = text(target.model), id = text(target.id);
			if (!isPortableContentModel(model)) throw new Error('writer_content_model_invalid');
			const schema = describeContentFrontmatterJsonSchema(model);
			const properties: Record<string, unknown> = { ...record(schema.properties), id: { type: 'string', const: id } };
			if (model === 'knowledge') {
				const path = text(target.path), book = (Array.isArray(assignment.contextRefs) ? assignment.contextRefs : [])
					.map(record).find((reference) => text(reference.store) === 'treedx' && text(reference.model) === 'book'
						&& text(reference.repository) === text(target.repository) && text(reference.commit) && text(reference.path)
						&& Number.isInteger(reference.revision) && /^sha256:[a-f0-9]{64}$/u.test(text(reference.digest)));
				if (!book || !path.endsWith(`/${id}.md`)) throw new Error('writer_knowledge_target_invalid');
				properties.slug = { type: 'string', const: id };
				properties.bookRef = { type: 'object', additionalProperties: false,
					properties: Object.fromEntries(Object.entries(book).map(([name, value]) => {
						if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error('writer_book_reference_schema_invalid');
						return [name, { type: typeof value, const: value }];
					})), required: Object.keys(book) };
			}
			return { model, frontmatter: { ...schema, properties } };
		});
}

export function isReleaseReview(assignment: Record<string, unknown>, workItem?: Record<string, unknown>) {
	const capabilities = Array.isArray(workItem?.requiredCapabilities) ? workItem.requiredCapabilities : assignment.requiredCapabilities;
	return text(record(assignment.effectiveProfile).activity) === 'reviewing'
		&& Array.isArray(capabilities) && capabilities.some(capability => text(capability) === 'treeseed.engineering.release');
}

export function validateModelContext(context: Record<string, unknown>) {
 const canonical = record(context.canonicalAssignmentContext);
 if (!Object.keys(canonical).length) throw new Error('legacy_workday_assignment_not_supported');
 const assignment = record(canonical.assignment), profile = record(assignment.effectiveProfile);
 if (profile.activity === 'reviewing' && !(Array.isArray(assignment.authorityRefs) && assignment.authorityRefs.some(ref => record(ref).model === 'decision'))) {
  throw new Error('work_review_requires_accepted_decision');
 }
 const workItemId = text(assignment.workItemId);
 if (record(assignment.sourceRef).model === 'proposal' && workItemId) {
  const items = record(assignmentProposalSource(canonical).executionPlan).workItems;
  if (!Array.isArray(items) || !items.some(item => record(item).id === workItemId)) throw new Error('assignment_work_item_context_required');
 }
 return canonical;
}

export function promptFromContext(context: Record<string, unknown>, reasoningEffort?: string, executionSeconds?: number,
 verification?: import('../contracts.ts').VerificationResult[]) {
 const canonical = record(context.canonicalAssignmentContext);
 if (!Object.keys(canonical).length) throw new Error('legacy_workday_assignment_not_supported');
 const assignment = record(canonical.assignment);
 const profile = record(assignment.effectiveProfile), configured = record(profile.prompt);
 if (typeof configured.system !== 'string' || !configured.system.trim()) throw new Error('configured_model_prompt_required');
 const instructions = Array.isArray(configured.instructions) ? configured.instructions.map(text).filter(Boolean) : [];
 // Instructions appear once. Assignment data retains class and activity as facts, never dispatch policy.
 const { prompt: _configuredPrompt, ...profileData } = profile;
 const promptContext = { ...canonical, assignment: { ...assignment, effectiveProfile: profileData } };
 return [configured.system, ...instructions, JSON.stringify({ canonicalAssignmentContext: promptContext,
  ...(context.projectManifest === undefined ? {} : { projectManifest: context.projectManifest }),
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  ...(executionSeconds === undefined ? {} : { executionSeconds }),
  ...(verification === undefined ? {} : { verification }) })].join('\n\n');
}

export function assertArchitectSourceCitation(completion: ActivityCompletionReport | null, exactSourceCommit: string | null, _agentClass: string, activity: string) {
	if (activity !== 'acting' || !exactSourceCommit || completion?.contentOutput?.model !== 'knowledge') return;
	const body = text(record(completion?.contentOutput).body);
	if (!body.includes(exactSourceCommit)) throw new Error(`project_source_commit_citation_missing:${exactSourceCommit}`);
	const assertedSourceCommits = [...body.matchAll(/\b(?:SDK|project)\s+(?:(?:Git|source)\s+){0,2}commit\s+`?([a-f0-9]{40})/giu)]
		.map((match) => match[1]);
	if (assertedSourceCommits.some((commit) => commit !== exactSourceCommit)) {
		throw new Error(`project_source_commit_citation_mismatch:${exactSourceCommit}`);
	}
}

export function assertTesterFailureEvidence(completion: ActivityCompletionReport | null, _agentClass: string, activity: string, acceptanceCriteria: unknown) {
	if (activity !== 'acting') return;
	const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria.map(text).join(' ') : '';
	if (!/report failing test names and paths/iu.test(criteria)) return;
	const summary = completion?.summary ?? '';
	if (!summary.includes('Frozen-base failing tests:') || !/tests\/[^\s]+\.test\.ts\b/u.test(summary)) {
		throw new Error('test_first_failure_evidence_missing');
	}
}

export function attachObservedTesterFailures(completion: ActivityCompletionReport | null, events: Array<Record<string, unknown>>,
	agentClass: string, activity: string, acceptanceCriteria: unknown): ActivityCompletionReport | null {
	if (!completion || activity !== 'acting') return completion;
	const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria.map(text).join(' ') : '';
	if (!/report failing test names and paths/iu.test(criteria) || completion.summary.includes('Frozen-base failing tests:')) return completion;
	for (const event of [...events].reverse()) {
		const item = record(event.item), command = text(item.command), exitCode = Number(item.exit_code);
		if (text(event.type) !== 'item.completed' || text(item.type) !== 'command_execution'
			|| !/\b(?:vitest|npm\s+(?:run\s+)?test)\b/iu.test(command) || !Number.isInteger(exitCode) || exitCode === 0) continue;
		const output = text(item.aggregated_output).replace(/\u001b\[[0-9;]*m/gu, '');
		const path = (command.match(/tests\/[^\s'";]+\.test\.ts\b/u) ?? output.match(/tests\/[^\s'";]+\.test\.ts\b/u))?.[0];
		const failures = output.split(/\r?\n/u).map((line) => line.trim())
			.filter((line) => /^(?:FAIL\s|❯\s|×\s|✗\s|✕\s)/u.test(line)).slice(0, 30);
		if (!path || failures.length === 0) continue;
		return { ...completion, summary: `${completion.summary.trim()}\n\nFrozen-base failing tests:\n${failures.map((line) => `- ${path}: ${line.slice(0, 300)}`).join('\n')}\nObserved command: ${command} (exit ${exitCode}).` };
	}
	return completion;
}

export function isTestFirstVerification(activity: string, acceptanceCriteria: unknown, command?: string): boolean {
	const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria.map(text).join(' ') : '';
	return ['acting', 'reviewing'].includes(activity)
		&& /report failing test names and paths|failing-on-base|tests?[^.]*fail on (?:the )?frozen base/iu.test(criteria)
		&& (command === undefined || /\b(?:vitest|npm\s+(?:run\s+)?test)\b/iu.test(command));
}

export function correctObservedTestFirstRedVerification(completion: ActivityCompletionReport, events: Array<Record<string, unknown>>,
	agentClass: string, activity: string, acceptanceCriteria: unknown): ActivityCompletionReport {
	if (!isTestFirstVerification(activity, acceptanceCriteria)) return completion;
	const failedCommands = new Map<string, number>();
	for (const event of events) {
		const item = record(event.item), command = text(item.command), exitCode = Number(item.exit_code);
		if (text(event.type) === 'item.completed' && text(item.type) === 'command_execution'
			&& Number.isInteger(exitCode)) {
			if (exitCode === 0) failedCommands.delete(command.trim());
			else failedCommands.set(command.trim(), exitCode);
		}
	}
	return { ...completion, verification: completion.verification.map((entry) => {
		if (entry.status !== 'passed' || entry.commands.length !== 1) return entry;
		const command = entry.commands[0].trim(), exitCode = failedCommands.get(command);
		if (exitCode === undefined || !isTestFirstVerification(activity, acceptanceCriteria, command)) return entry;
		return { ...entry, status: 'failed' as const, summary: `${entry.summary} Runner-observed frozen-base exit ${exitCode}; intentional red test is not a passing check.` };
	}) };
}

/** Discard unsupported claims; never turn a shell workflow into invented passing checks. */
export function omitUnreplayableVerification(completion: ActivityCompletionReport): ActivityCompletionReport {
	let omitted = 0;
	const verification = completion.verification.filter((entry) => {
		if (entry.status !== 'passed') return true;
		try { for (const command of entry.commands) assertReplayableVerificationCommand(command); return true; }
		catch { omitted += 1; return false; }
	});
	return omitted ? { ...completion, verification,
		summary: `${completion.summary}\n\n${omitted} claimed passing verification item(s) were omitted because their commands were not standalone/replayable; those gates remain unproven.` } : completion;
}

export function codexReasoningArguments(reasoningEffort: string | undefined) {
	return reasoningEffort && ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)
		? ['-c', `model_reasoning_effort=${reasoningEffort}`] : [];
}

export function codexProjectInstructionArguments() {
	// Repository AGENTS.md files describe trusted host workspaces and may require
	// tools such as trsd that intentionally do not exist inside an assignment VM.
	// The canonical assignment prompt is the only guest execution instruction.
	return ['-c', 'project_doc_max_bytes=0'];
}

export function codexInteractiveTimeoutMs(durationSeconds: number) {
	return Math.max(1_000, durationSeconds * 1_000 - 5_000);
}

export function codexInvocationTimerOptions(remainingMs: number, activity: string) {
	if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs)) throw new Error('assignment_execution_clock_invalid');
	if (remainingMs <= 0) throw new Error('assignment_execution_budget_exhausted');
	const remainingSeconds = remainingMs / 1_000;
	const idleTimeoutMs = activity === 'estimating' ? codexIdleTimeoutMs(remainingSeconds) : undefined;
	const closeoutTimeoutMs = codexCloseoutTimeoutMs(remainingSeconds, activity);
	return {
		timeoutMs: codexInteractiveTimeoutMs(remainingSeconds),
		...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
		...(closeoutTimeoutMs === undefined ? {} : { closeoutTimeoutMs }),
	};
}

export function requiresActivityCompletion(sourceMode: unknown) {
	return sourceMode === 'work';
}

export function reportedVerificationCommands(report: ActivityCompletionReport, includeFailed = false) {
	const commands = [...new Set(report.verification.filter((entry) => entry.status === 'passed' || includeFailed && entry.status === 'failed').flatMap((entry) => entry.commands))];
	const longest = Math.max(0, ...commands.map(command => command.length));
	if (commands.length > maximumVerificationCommands || longest > maximumVerificationCommandLength || commands.some(command => command.includes('\0'))) {
		throw new Error(`Activity completion verification exceeds bounded policy: ${commands.length}/${maximumVerificationCommands} commands, longest ${longest}/${maximumVerificationCommandLength} characters; NUL bytes are prohibited.`);
	}
	for (const command of commands) assertReplayableVerificationCommand(command);
	return commands;
}

export function assertReplayableVerificationCommand(command: string) {
	const normalized = command.trim();
	if (!normalized || hasUnsafeShellControl(normalized)) {
		throw new Error(`Activity completion verification must be one standalone command: ${command}`);
	}
	if (/\b(?:sudo|su|doas|rm|mv|cp|install|chmod|chown|truncate|tee)\b/u.test(normalized)
		|| /\bgit\s+(?:add|commit|push|reset|checkout|switch|clean|merge|rebase|tag|branch|restore)(?=\s|$)/u.test(normalized)
		|| /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add|remove|uninstall|update|upgrade)\b/u.test(normalized)
		|| /\b(?:sh|bash|zsh|dash)\s+-c\b/u.test(normalized)) {
		throw new Error(`Activity completion verification may not mutate or prepare the workspace: ${command}`);
	}
	return normalized;
}

function hasUnsafeShellControl(command: string) {
	let quote: "'" | '"' | null = null, escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		if (escaped) { escaped = false; continue; }
		if (character === '\\' && quote !== "'") { escaped = true; continue; }
		if (quote) {
			if (character === quote) quote = null;
			else if (quote === '"' && (character === '`' || (character === '$' && command[index + 1] === '('))) return true;
			continue;
		}
		if (character === "'" || character === '"') { quote = character; continue; }
		if ('\r\n;&<>`'.includes(character) || (character === '|' && command[index + 1] === '|')
			|| (character === '$' && command[index + 1] === '(')) return true;
	}
	return quote !== null || escaped;
}
/** The same permission controls output verification and eager dependency restoration. */
export function activityAllowsVerification(activity: string, _agentClass: string, _workspaceMode: string, acceptanceCriteria?: unknown): boolean {
	return !['planning', 'estimating', 'chat'].includes(activity)
		&& !(Array.isArray(acceptanceCriteria) && acceptanceCriteria.some(criterion =>
			typeof criterion === 'string' && /(?:do not|must not|not to) (?:claim|report) test verification/iu.test(criterion)));
}
