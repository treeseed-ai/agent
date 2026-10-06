import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { assignmentAttemptSchema, type AssignmentContext, type AssignmentResult } from '@treeseed/sdk/agent-capacity';
import { WriterHandler } from '../../../src/kernel/handlers/model-handler.ts';
import { commitTreeDxContent, prepareTreeDxContent } from '../../../src/kernel/treedx-content-commit.ts';
import type { AgentRuntime } from '../../../src/kernel/contracts.ts';
import type { AssignmentTreeDxFacade } from '../../../src/provider/execution/contracts.ts';

const input = process.argv[2], mode = process.argv[3];
if (!input || !mode) throw new Error('planning_native_fixture_input_required');
const root = dirname(input), assignment = assignmentAttemptSchema.parse(parse(readFileSync(input, 'utf8')));
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
	...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_AUTHOR_NAME: 'Planning Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
	GIT_COMMITTER_NAME: 'Planning Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
} }).trim();
const unexpected = async (): Promise<never> => { throw new Error('unexpected_external_operation'); };

async function main(): Promise<void> {
	// Real isolated content serialization, native Git and owning publication/readback.
	// The operation facade is controlled; this is NOT a TreeDX server or live model.
	git('init', '-q', '-b', 'codex/planning-fixture');
	const predecessors: AssignmentResult[] = [];
	for (let index = 0; index < 8; index++) {
		const id = `previous-${index}`, path = `notes/${id}.mdx`, body = `Controlled responsibility ${index} evidence.`;
		const target = { store: 'treedx' as const, model: 'note', id, repository: 'fixture-library', path, commit: 'a'.repeat(40) };
		const prepared = prepareTreeDxContent(target, { body, frontmatter: { schemaVersion: 'treeseed.note/v1', id,
			projectId: assignment.projectId, classification: 'general', subjectRefs: [assignment.sourceRef], createdAt: new Date().toISOString() } });
		mkdirSync(dirname(resolve(root, path)), { recursive: true }); writeFileSync(resolve(root, path), prepared.content);
		predecessors.push({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${id}`, assignmentId: id, status: 'completed',
			summary: body, references: [], verification: [], diagnostics: [], usage: { elapsedSeconds: 0 }, completedAt: new Date().toISOString() });
	}
	git('add', 'assignment.yaml', 'notes'); git('commit', '-qm', 'Exact eight predecessor publications');
	const base = git('rev-parse', 'HEAD'), path = 'notes/synthesis.mdx';
	const target = { store: 'treedx' as const, model: 'note', id: 'synthesis', repository: 'fixture-library', path, commit: base };
	assignment.workspace = { mode: 'treedx', repository: target.repository, workspaceId: 'fixture-workspace', baseCommit: base, writablePaths: [path] };
	assignment.grant = { contentRead: [], contentWrite: mode === 'denied' ? [] : [target], sourceRead: [], sourceWrite: [], tools: [] };
	assignment.contextRefs = []; assignment.predecessorResultIds = predecessors.map(value => value.id);
	for (const value of predecessors) value.references = [{ kind: 'treedx', projectId: assignment.projectId, repository: target.repository,
		commit: base, path: `notes/${value.assignmentId}.mdx` }];
	const context: AssignmentContext = { assignment, context: predecessors.map(value => {
		const reference = { store: 'treedx' as const, model: 'note', id: value.assignmentId, repository: target.repository,
			commit: base, path: `notes/${value.assignmentId}.mdx` };
		const bytes = readFileSync(resolve(root, reference.path), 'utf8');
		const frontmatter = parse(bytes.match(/^---\n([\s\S]*?)---\n/u)![1]!);
		return { ref: reference, mediaType: 'text/markdown', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
			value: { frontmatter, body: value.summary } };
	}), predecessorResults: predecessors };
	assignment.contextRefs = context.context.map(value => value.ref);
	assignment.grant.contentRead = context.context.map(value => value.ref);
	const before = JSON.stringify(context);
	const lines = predecessors.map(value => `- ${value.id}: Incorporated ${value.summary}`);
	const summary = mode === 'omitted' ? lines.slice(1).join('\n') : mode === 'empty-material' ? predecessors.map(value => `- ${value.id}:`).join('\n')
		: mode === 'foreign' ? lines.map((line, index) => index ? line : '- unrelated-result: Invented contribution.').join('\n')
		: [...lines, 'My scoped synthesis preserves the unchanged recommendation.'].join('\n');
	let publications = 0, modelCalls = 0, suppliedPredecessors = 0;
	const treeDx: AssignmentTreeDxFacade = { projectId: assignment.projectId, handleId: 'fixture-handle', repositoryId: target.repository,
		workspaceId: 'fixture-workspace', invoke: async (operation, parameters) => {
			const body = record(record(parameters).body);
			if (operation === 'treedx.workspaces.files.batch') {
				for (const entry of Array.isArray(body.files) ? body.files : []) {
					const file = record(entry); if (file.path !== path || typeof file.content !== 'string') throw new Error('unassigned_native_write');
					writeFileSync(resolve(root, path), file.content);
				}
				return {};
			}
			if (operation === 'treedx.workspaces.commit') {
				publications++; git('add', path); git('commit', '-qm', 'Publish exact planning contribution');
				return { commitSha: git('rev-parse', 'HEAD') };
			}
			if (operation === 'treedx.repositories.files.read') return { files: [{ path, content: git('show', `${String(body.ref)}:${path}`) + '\n' }] };
			throw new Error(`unexpected_native_operation:${operation}`);
		} };
	const runtime: AgentRuntime = { now: () => new Date().toISOString(), readContext: unexpected, runVerification: unexpected,
		commitSource: unexpected, commitTreeDx: request => commitTreeDxContent({ attempt: assignment, treeDx, writes: request.writes }),
		invokeModel: async request => {
			suppliedPredecessors = request.context.length;
			modelCalls++; if (mode === 'provider-error') throw new Error('controlled_model_failure');
			return { text: summary, activityCompletion: { summary, contentOutput: null, reviewDisposition: null },
				// Controlled transport response, not actual model timing/usage evidence.
				timingAwareness: { schemaVersion: 'treeseed.assignment-timing-awareness/v1', requiredChecks: 2, completedChecks: 2,
					firstTool: 'treedx:treeseed_time_status', firstToolSucceeded: true, firstToolCompliant: true,
					lastTool: 'treedx:treeseed_time_status', lastToolSucceeded: true, finalToolCompliant: true },
				usage: { elapsedSeconds: 0 } };
		} };
	let result: AssignmentResult | undefined, error: string | undefined;
	try { result = await new WriterHandler().run(context, runtime); } catch (failure) { error = String(failure); }
	const head = git('rev-parse', 'HEAD'), exists = existsSync(resolve(root, path));
	process.stdout.write(JSON.stringify({ result, error, publications, modelCalls, suppliedPredecessors, base, head, exists,
		inputUnchanged: JSON.stringify(context) === before, expectedSummary: summary,
		published: exists ? readFileSync(resolve(root, path), 'utf8') : null, status: git('status', '--porcelain') }));
}
void main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
