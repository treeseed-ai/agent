import type { AgentTreeDxAdapter } from '../../../agents/runtime/runtime-types.ts';
import { parse as parseYaml } from 'yaml';
import { record, stringValue } from '../../configuration/value-utils.ts';
import { deliverProviderModeRunTelemetry, type AssignmentModeRunRecorder } from '../../reporting/mode-run-telemetry.ts';

function parseFrontmatterDocument(source: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
	if (!match) return { frontmatter: {}, body: source };
	return { frontmatter: record(parseYaml(match[1] ?? '')), body: match[2] ?? '' };
}

function fileText(file: Record<string, unknown>, keys: string[]) {
	for (const key of keys) if (typeof file[key] === 'string') return file[key] as string;
	return '';
}

function fileSlug(filePath: string, agentsRoot: string) {
	const normalizedPath = filePath.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
	const normalizedRoot = agentsRoot.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
	const relative = normalizedPath.startsWith(`${normalizedRoot}/`) ? normalizedPath.slice(normalizedRoot.length + 1) : normalizedPath;
	return relative.replace(/\.(mdx|md)$/iu, '').replace(/^\/+|\/+$/gu, '');
}

export async function loadAssignmentRawAgentSpecs(input: { treeDx: AgentTreeDxAdapter | null; assignmentId: string; agentSlug: string; agentContentPath?: string | null; workspaceId: string | null; contentRoot: string | null; client: AssignmentModeRunRecorder; mode: string; capacityEnvelope: Record<string, unknown>; decisionPayload: Record<string, unknown>; runnerId: string; options?: { enabled?: boolean } }) {
	if (!input.treeDx) return null;
	const startedAt = Date.now();
	const agentsRoot = `${(input.contentRoot ?? 'src/content').replace(/\/+$/u, '')}/agents`;
	const baseMetadata = { source: 'provider_runner_agent_spec_loader', loaderVersion: 'exact-agent-spec-sequential-v2', assignmentId: input.assignmentId, runnerId: input.runnerId, agentSlug: input.agentSlug, agentsRoot };
	let rawSpecs: Array<{ id: string; body: string; frontmatter: Record<string, unknown> }>;
	let metadata: Record<string, unknown>;
	try {
		const attemptedPaths: string[] = [];
		const missingPaths: string[] = [];
		const readResponses: Record<string, unknown>[] = [];
		const candidatePaths = input.agentContentPath
			? [input.agentContentPath]
			: [`${agentsRoot}/${input.agentSlug}.mdx`, `${agentsRoot}/${input.agentSlug}.md`];
		for (const candidatePath of candidatePaths) {
			attemptedPaths.push(candidatePath);
			try {
				if (input.workspaceId) {
					const response = record(await input.treeDx.readWorkspaceFile({ workspaceId: input.workspaceId, path: candidatePath }));
					const file = record(response.file ?? record(response.payload).file ?? response);
					readResponses.push(Object.keys(file).length ? { files: [file] } : response);
				} else {
					readResponses.push(record(await input.treeDx.readRepositoryFiles({ repoId: '', paths: [candidatePath], body: { includeBody: true, includeFrontmatter: true } })));
				}
				break;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes('(404)') || message.includes(', 404')) { missingPaths.push(candidatePath); continue; }
				throw error;
			}
		}
		const files = [
			...readResponses.flatMap((response) => Array.isArray(response.files) ? response.files : []),
			...readResponses.flatMap((response) => Array.isArray(response.results) ? response.results : []),
			...readResponses.flatMap((response) => Array.isArray(record(response.payload).files) ? record(response.payload).files : []),
			...readResponses.flatMap((response) => Array.isArray(record(response.payload).results) ? record(response.payload).results : []),
		].map(record).filter((file) => Object.keys(file).length > 0);
		const pathsToRead = files.map((file) => stringValue(file.path, file.relativePath, file.name)).filter((path): path is string => Boolean(path));
		rawSpecs = files.map((file) => {
			const path = stringValue(file.path, file.relativePath, file.name) ?? '';
			const rawDocument = fileText(file, ['content', 'source', 'text']);
			const parsed = rawDocument ? parseFrontmatterDocument(rawDocument) : { frontmatter: record(file.frontmatter), body: fileText(file, ['body']) };
			return { id: fileSlug(path, agentsRoot), body: parsed.body, frontmatter: parsed.frontmatter };
		}).filter((entry) => input.options?.enabled === true ? entry.frontmatter.enabled !== false : true);
		metadata = { ...baseMetadata, attemptedPathCount: attemptedPaths.length, attemptedPaths, missingPaths, readPathCount: pathsToRead.length, readPaths: pathsToRead, fileCount: files.length, specCount: rawSpecs.length, durationMs: Date.now() - startedAt };
	} catch (error) {
		const metadata = { ...baseMetadata, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt };
		await deliverProviderModeRunTelemetry({
			recorder: input.client,
			assignmentId: input.assignmentId,
			eventId: 'agent-spec-load:failed',
			request: { mode: input.mode, status: 'running', selectedInput: input.decisionPayload, capacityEnvelope: input.capacityEnvelope, outputs: { status: 'agent_spec_load_failed', summary: metadata.error, metadata }, metadata },
		});
		throw error;
	}
	await deliverProviderModeRunTelemetry({
		recorder: input.client,
		assignmentId: input.assignmentId,
		eventId: 'agent-spec-load:succeeded',
		request: { mode: input.mode, status: 'running', selectedInput: input.decisionPayload, capacityEnvelope: input.capacityEnvelope, outputs: { status: 'agent_specs_loaded', summary: `Loaded ${rawSpecs.length} agent spec(s) through the assignment TreeDX proxy.`, metadata }, metadata },
	});
	return rawSpecs;
}
