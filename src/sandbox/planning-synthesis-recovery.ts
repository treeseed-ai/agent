import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { validateActivityCompletion } from '../activity-completion.ts';
import { codexProjectInstructionArguments, codexReasoningArguments, record } from './guest-contract.ts';
import { assertPredecessorSynthesis, missingPredecessorCitations, planningSynthesisCorrectionPrompt } from '../kernel/handlers/planning-synthesis.ts';
import { run } from './process-runner.ts';

type Event = Record<string, unknown>;

/** Correct the full contribution contract in the original session and active-time budget. */
export async function recoverPlanningSynthesis(input: {
	context: Event;
	activity: string;
	threadId: string | null;
	responsePath: string;
	schemaPath: string;
	allowVerification: boolean;
	remainingMs(): number;
	execute: typeof run;
	model: string;
	reasoningEffort?: string;
	providerEnvironment: Record<string, string>;
	onEvent(event: Event): void;
	verifyClock(events: Event[]): void;
	progress(stage: string): Promise<void>;
}): Promise<boolean> {
	if (input.activity !== 'planning' || !input.threadId) return false;
	const firstResponse = (await readFile(input.responsePath, 'utf8').catch(error => {
		if (error?.code === 'ENOENT') return '';
		throw error;
	})).trim();
	if (!firstResponse) return false;
	const first = validateActivityCompletion(JSON.parse(firstResponse), input.allowVerification);
	const missing = missingPredecessorCitations(input.context, first);
	try { assertPredecessorSynthesis(input.context, first); return false; }
	catch (error) {
		if (!(error instanceof Error) || !/^predecessor_result_citation_(?:missing|order_invalid)/u.test(error.message)) throw error;
	}
	const remainingMs = input.remainingMs();
	if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs) || remainingMs < 30_000) return false;
	const predecessors = record(input.context.canonicalAssignmentContext).predecessorResults;
	const evidence = Array.isArray(predecessors) ? predecessors : [];
	const prompt = planningSynthesisCorrectionPrompt(missing.length ? missing : evidence.map(item => String(record(item).id)), first, evidence);
	await input.progress('provider.planning-synthesis-recovery.starting');
	const currentRemaining = input.remainingMs();
	if (typeof currentRemaining !== 'number' || !Number.isFinite(currentRemaining) || currentRemaining < 30_000) return false;
	// The captured completion is already in the prompt. A zero-exit subprocess must produce a fresh response,
	// not silently leave the initial file looking like an observed correction.
	await unlink(input.responsePath);
	// Removal is asynchronous work inside the same original authority. Never
	// launch from the earlier measurement after that boundary consumed time.
	const launchRemaining = input.remainingMs();
	if (typeof launchRemaining !== 'number' || !Number.isFinite(launchRemaining) || launchRemaining < 30_000)
		throw new Error('planning_synthesis_correction_budget_exhausted');
	const events: Event[] = [];
	await input.execute('/usr/local/bin/codex', ['exec', 'resume', input.threadId, '--json', '--dangerously-bypass-approvals-and-sandbox',
		'--model', input.model, ...codexReasoningArguments(input.reasoningEffort), ...codexProjectInstructionArguments(),
		'--output-schema', input.schemaPath, '--output-last-message', input.responsePath, '-'], {
		cwd: '/workspace/project', env: input.providerEnvironment,
		input: prompt, timeoutMs: Math.floor(Math.min(remainingMs, currentRemaining, launchRemaining)),
		onLine(line) {
			let event: Event;
			try { event = record(JSON.parse(line)); }
			catch { event = { type: 'provider.event.invalid', digest: createHash('sha256').update(line).digest('hex') }; }
			events.push(event); input.onEvent(event);
		},
	});
	input.verifyClock(events);
	const response = await readFile(input.responsePath, 'utf8').catch(error => {
		if (error?.code === 'ENOENT') throw new Error('planning_synthesis_correction_output_missing');
		throw error;
	});
	if (!response.trim()) throw new Error('planning_synthesis_correction_output_missing');
	let decoded: unknown;
	try { decoded = JSON.parse(response); }
	catch { throw new Error('planning_synthesis_correction_output_invalid_json'); }
	const corrected = validateActivityCompletion(decoded, input.allowVerification);
	try { assertPredecessorSynthesis(input.context, corrected); }
	catch (error) {
		if (!(error instanceof Error) || !/^predecessor_result_citation_/u.test(error.message)) throw error;
		throw new Error(`${error.message}; correctionChanged=${corrected.summary !== first.summary}`);
	}
	await input.progress('provider.planning-synthesis-recovery.completed');
	return true;
}
