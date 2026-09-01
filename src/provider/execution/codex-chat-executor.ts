import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateContentFrontmatter } from '@treeseed/sdk/content-validation';
import type { AgentExecutionRequest } from './contracts.ts';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const contentText = (value: unknown) => typeof value === 'string' ? value : '';
const contentMetadata = (path: string, content: string) => ({ path, bytes: Buffer.byteLength(content), digest: `sha256:${createHash('sha256').update(content).digest('hex')}` });

export function assertObjectiveContentModel(path: string, file: Record<string, unknown>) {
	if (!/(?:^|\/)objectives\/[^/]+\.(?:md|mdx)$/u.test(path)) return;
	if (file.frontmatterError) throw new Error(`TreeDX objective is not valid Astro content: ${path}: ${String(file.frontmatterError)}`);
	const validation = validateContentFrontmatter('objective', record(file.frontmatter));
	if (!validation.ok) throw new Error(`TreeDX objective does not satisfy the SDK objective content model: ${path}: ${validation.diagnostics.map((item) => `${item.field}: ${item.message}`).join('; ')}`);
}

function command(executable: string, args: string[], cwd?: string) {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(executable, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '', stderr = '';
		child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { stdout += String(chunk); });
		child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });
		child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${executable} exited ${code}: ${stderr.trim()}`)));
	});
}

export function readableCloneUrl(value: string) {
	const github = /^git@github\.com:([^/]+\/.+?)(?:\.git)?$/u.exec(value);
	return github ? `https://github.com/${github[1]}.git` : value;
}

export async function prepareProjectWorkspace(assignment: Record<string, unknown>, workspace: string) {
	const project = record(record(assignment.workspaceContext).project), repository = record(project.repository);
	const cloneUrl = readableCloneUrl(text(repository.cloneUrl)); const branch = text(repository.currentBranch) || text(repository.defaultBranch) || 'staging';
	if (!cloneUrl) throw new Error('Conversation assignment omitted its project source repository checkout authority.');
	await command('git', ['clone', '--depth', '1', '--single-branch', '--branch', branch, cloneUrl, workspace]);
	const revision = await command('git', ['rev-parse', 'HEAD'], workspace);
	const tree = await command('git', ['ls-tree', '-rl', revision], workspace);
	const entries = tree.split('\n').filter(Boolean).map((line) => /^(\d+)\s+(blob|commit)\s+([0-9a-f]+)(?:\s+(\d+))?\t(.+)$/u.exec(line));
	if (entries.some((entry) => !entry || entry[2] !== 'blob' || !['100644', '100755'].includes(entry[1]!))) throw new Error('Project snapshot contains a symbolic link, submodule, or unsupported Git object mode.');
	const files = entries.map((match) => ({ path: match![5]!, bytes: Number(match![4]), gitBlob: match![3]!, mode: match![1]! }));
	return { projectId: text(project.id), projectSlug: text(project.slug), cloneUrl, branch, revision, root: workspace, fileCount: files.length, files };
}

function resultPayload(value: unknown) {
	const envelope = record(value), data = record(envelope.data ?? envelope), result = record(data.result ?? data);
	return record(result.data ?? result);
}

async function retryTreeDx<T>(operation: () => Promise<T>, attempts = 3) {
	let failure: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) try { return await operation(); } catch (error) {
		failure = error;
		if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 150));
	}
	throw failure;
}

function focusedContextSelections(assignment: Record<string, unknown>) {
	const metadata = record(assignment.metadata); const checks = Array.isArray(metadata.contextQueryChecks) ? metadata.contextQueryChecks.map(record) : [];
	const references = Array.isArray(metadata.contextQueryRefs) ? metadata.contextQueryRefs.map(record) : [];
	const layers = new Map(references.map((reference) => [`${text(reference.kind)}:${text(reference.id)}@${Number(reference.revision)}`, text(reference.layer)]));
	const selected = new Map<string, {projectId:string|null;layers:Set<'agent'|'activity'>}>();
	for (const check of checks) {
		const definition=record(check.definition),key=`${text(definition.kind)}:${text(definition.id)}@${Number(definition.revision)}`;
		const layer=layers.get(key); if(layer!=='agent'&&layer!=='activity') throw new Error(`Verified context query ${key} has no agent or activity layer.`);
		const stats=record(check.stats),attributed=Array.isArray(stats.sources)?stats.sources.map(record):[];
		const sources=attributed.length?attributed:[{projectId:null,paths:Array.isArray(stats.paths)?stats.paths:[]}];
		for(const source of sources)for(const path of (Array.isArray(source.paths)?source.paths.map(String):[])) if(path&&!path.startsWith('/')&&!path.includes('\\')&&!path.includes('..')) {
			const key=`${text(source.projectId)||'current'}:${path}`,existing=selected.get(key)??{projectId:text(source.projectId)||null,layers:new Set<'agent'|'activity'>()}; existing.layers.add(layer); selected.set(key,existing);
		}
	}
	return [...selected.entries()].sort((left,right)=>{
		const leftLayer=left[1].layers.has('agent')?0:1,rightLayer=right[1].layers.has('agent')?0:1; return leftLayer-rightLayer||left[0].localeCompare(right[0]);
	}).slice(0,100).map(([key,value])=>({projectId:value.projectId,path:key.slice(key.indexOf(':')+1),layers:[...value.layers].sort((left)=>left==='agent'?-1:1)}));
}

/** Materialize only the files selected by verified agent/activity context queries. */
export async function readFocusedTreeDxContext(request: AgentExecutionRequest) {
	if (!request.treeDx.repositoryId || !request.treeDx.baseRef) throw new Error('Conversation assignment omitted its TreeDX repository or immutable ref.');
	const selections = focusedContextSelections(request.assignment), paths=selections.map((entry)=>entry.path); if (!paths.length) return { sources: [], queryLayers: record(record(request.assignment.metadata).contextQueryLayers) };
	const files: Record<string, unknown>[] = [];
	const groups=new Map<string,{projectId:string|null;repositoryId:string;baseRef:string;paths:string[]}>();
	for(const selection of selections){const grant=selection.projectId&&selection.projectId!==request.treeDx.projectId?request.treeDx.readRepositories?.find((entry)=>entry.projectId===selection.projectId):null;
		if(selection.projectId&&selection.projectId!==request.treeDx.projectId&&!grant)throw new Error(`Verified context selected unauthorized project ${selection.projectId}.`);
		const repositoryId=grant?.repositoryId??request.treeDx.repositoryId,key=`${selection.projectId??request.treeDx.projectId}:${repositoryId}`,group=groups.get(key)??{projectId:selection.projectId,repositoryId:repositoryId!,baseRef:grant?.baseRef??request.treeDx.baseRef!,paths:[]};group.paths.push(selection.path);groups.set(key,group);}
	for(const group of groups.values())for(let index=0;index<group.paths.length;index+=10){const selected=group.paths.slice(index,index+10);const payload=resultPayload(await retryTreeDx(()=>request.treeDx.invoke('treedx.repositories.files.read',{
		path:{projectId:group.projectId??request.treeDx.projectId,repoId:group.repositoryId},body:{paths:selected,encoding:'utf8',parseFrontmatter:true,allowProtected:true}})));
		files.push(...(Array.isArray(payload.files)?payload.files.map((file)=>({...record(file),contextProjectId:group.projectId??request.treeDx.projectId,contextBaseRef:group.baseRef})):[]));
	}
	const returned=new Set(files.flatMap((file)=>[text(file.requestedPath),text(file.logicalPath),text(file.path),text(file.sourcePath)].filter(Boolean).map((path)=>`${text(file.contextProjectId)}:${path}`)));
	const missing=selections.filter((selection)=>!returned.has(`${selection.projectId??request.treeDx.projectId}:${selection.path}`)).map((selection)=>`${selection.projectId??request.treeDx.projectId}:${selection.path}`);
	if(missing.length) throw new Error(`TreeDX omitted required verified context-query results at ${request.treeDx.baseRef}: ${missing.join(', ')}`);
	const memberships=new Map(selections.map((entry)=>[`${entry.projectId??request.treeDx.projectId}:${entry.path}`,entry.layers]));
	const sources = files.map((file) => {
		const path = text(file.path), content = contentText(file.content) || contentText(file.body); assertObjectiveContentModel(path, file);
		const projectId=text(file.contextProjectId)||request.treeDx.projectId,layers=memberships.get(`${projectId}:${path}`)??[]; return { kind: 'context-query-result', projectId, layer:layers[0], layers, source: 'treedx', disposition: 'prompt-injected', immutableRef: text(file.contextBaseRef)||request.treeDx.baseRef, ...contentMetadata(path, content), content };
	}).sort((left,right)=>(left.layer==='agent'?0:1)-(right.layer==='agent'?0:1)||left.path.localeCompare(right.path));
	const totalBytes = sources.reduce((total, source) => total + source.bytes, 0);
	if (totalBytes > 1_048_576) throw new Error('Focused TreeDX context exceeds the one MiB assignment limit; narrow the configured context queries.');
	return { sources, queryLayers: record(record(request.assignment.metadata).contextQueryLayers) };
}

export function discussionMessageSourcePaths(assignment: Record<string, unknown>) {
	return Array.isArray(assignment.sourceMessageRefs)
		? assignment.sourceMessageRefs.map(String).map((value) => value.replaceAll('\\', '/').replace(/^\.\//, ''))
			.filter((value) => value.startsWith('discussion-messages/') || value.includes('/discussion-messages/')) : [];
}

export async function readDiscussionSourceMessage(request: AgentExecutionRequest) {
	return (await readDiscussionSourceContext(request)).content;
}

export async function readDiscussionSourceContext(request: AgentExecutionRequest) {
	const repoId = request.treeDx.repositoryId; const paths = discussionMessageSourcePaths(request.assignment);
	if (!repoId || !paths.length) throw new Error('Communication assignment omitted its TreeDX source message reference.');
	const envelope = record(await request.treeDx.invoke('treedx.repositories.files.read', {
		path: { repoId }, body: { paths: paths.slice(0,25), encoding: 'utf8', parseFrontmatter: true, allowProtected: true },
	}));
	const data = record(envelope.data ?? envelope); const result = record(data.result ?? data);
	const payload = record(result.data ?? result); const files = Array.isArray(payload.files) ? payload.files.map(record) : [];
	const byPath=new Map(files.flatMap((file)=>{const content=contentText(file.content)||contentText(file.body);return [text(file.requestedPath),text(file.path),text(file.logicalPath),text(file.sourcePath)].filter(Boolean).map((path)=>[path,{file,content}] as const);}));
	const addressed=byPath.get(paths[0]!)??(files[0]?{file:files[0],content:contentText(files[0].content)||contentText(files[0].body)}:undefined);const content=addressed?.content??'';
	if (!content) throw new Error('TreeDX did not return the assignment source message.');
	const history=paths.slice(1).flatMap((path)=>{const value=byPath.get(path);return value?.content?[{kind:'discussion-history',source:'treedx',disposition:'prompt-injected',immutableRef:request.treeDx.baseRef,...contentMetadata(path,value.content),content:value.content}]:[];});
	return { kind: 'discussion-message', source: 'treedx', disposition: 'prompt-injected', immutableRef: request.treeDx.baseRef, ...contentMetadata(paths[0], content), content,history };
}

export async function readIdentityContext(request: AgentExecutionRequest, availablePaths?: ReadonlySet<string>) {
	const metadata = record(request.assignment.metadata); const manifest = record(metadata.identityManifest);
	const profile = record(manifest.agentProfile); const objective = record(manifest.coreObjective); const readme = record(manifest.projectReadme);
	const profilePath = text(profile.path); const objectiveLogicalPath = text(objective.path);
	const readmePaths = [...new Set([text(readme.path), ...(Array.isArray(readme.paths) ? readme.paths.map(String) : [])].filter(Boolean))];
	const templates = Array.isArray(manifest.instructionTemplates) ? manifest.instructionTemplates.map(record) : [];
	const templatePaths = templates.map((entry) => text(entry.path)).filter(Boolean);
	if (!request.treeDx.repositoryId || !text(manifest.agentHandle) || !profilePath || !objectiveLogicalPath) throw new Error('Conversation assignment omitted its immutable agent identity manifest.');
	if (text(manifest.repositoryId) !== request.treeDx.repositoryId || !request.treeDx.baseRef || text(manifest.immutableRef) !== request.treeDx.baseRef)
		throw new Error('Conversation assignment identity does not match its assignment-scoped TreeDX repository and immutable ref.');
	const expectedRevisions = [text(profile.expectedRevision), text(objective.expectedRevision), text(readme.expectedRevision), ...templates.map((entry) => text(entry.expectedRevision))].filter(Boolean);
	if (expectedRevisions.some((revision) => revision !== request.treeDx.baseRef)) throw new Error('Conversation assignment identity source revision is stale or mismatched.');
	const objectiveReadPath = availablePaths
		? [...availablePaths].find((path) => path.replace(/\.(?:mdx|md|markdown|json|ya?ml|toml)$/u, '') === objectiveLogicalPath) ?? objectiveLogicalPath
		: objectiveLogicalPath;
	const paths = [...new Set([profilePath, objectiveReadPath, ...readmePaths, ...templatePaths].filter(Boolean))];
	const envelope = record(await request.treeDx.invoke('treedx.repositories.files.read', { path: { repoId: request.treeDx.repositoryId }, body: {
		paths, encoding: 'utf8', parseFrontmatter: true, allowProtected: true,
	} }));
	const data = record(envelope.data ?? envelope); const result = record(data.result ?? data); const payload = record(result.data ?? result);
	const files = (Array.isArray(payload.files) ? payload.files : []).map(record);
	const fileKey = (file: Record<string, unknown>) => text(file.requestedPath) || text(file.path);
	const byPath = new Map(files.flatMap((file) => {
		const content = contentText(file.content) || contentText(file.body);
		return [...new Set([fileKey(file), text(file.logicalPath), text(file.path), text(file.sourcePath)].filter(Boolean))].map((path) => [path, content] as const);
	}));
	const profileContent = byPath.get(profilePath) ?? '';
	const objectiveFile = files.find((file) => text(file.logicalPath) === objectiveLogicalPath || fileKey(file) === objectiveReadPath);
	const objectiveSourcePath = text(objectiveFile?.sourcePath) || text(objectiveFile?.path) || objectiveReadPath;
	const objectiveContent = objectiveFile ? contentText(objectiveFile.content) || contentText(objectiveFile.body) : '';
	const readmeSources = readmePaths.map((path) => ({ kind: 'project-readme', path, content: byPath.get(path) ?? '' }));
	const templateSources = templatePaths.map((path) => ({ kind: 'instruction-template', path, content: byPath.get(path) ?? '' }));
	if (!profileContent || !objectiveContent || readmeSources.some((source) => !source.content) || templateSources.some((source) => !source.content)) throw new Error('TreeDX identity verification requires the exact agent profile, logical objectives/core content, configured project README, and instruction templates.');
	assertObjectiveContentModel(objectiveSourcePath, objectiveFile ?? {});
	const sources = [{ kind: 'agent-profile', path: profilePath, content: profileContent }, { kind: 'core-objective', logicalPath: objectiveLogicalPath, path: objectiveSourcePath, content: objectiveContent }, ...readmeSources, ...templateSources]
		.map((source) => ({ ...source, source: 'treedx', disposition: 'prompt-injected', immutableRef: text(manifest.immutableRef), ...contentMetadata(source.path, source.content) }));
	const expectedDigests = new Map<string, string>();
	if (text(profile.digest)) expectedDigests.set(profilePath, text(profile.digest));
	for (const entry of templates) if (text(entry.path) && text(entry.digest)) expectedDigests.set(text(entry.path), text(entry.digest));
	for (const source of sources) if (expectedDigests.has(source.path) && expectedDigests.get(source.path) !== source.digest) throw new Error(`TreeDX identity source digest mismatch: ${source.path}`);
	const verifiedManifest: Record<string, unknown> = { ...manifest, sources: sources.map(({ content: _content, ...source }) => source) };
	return { manifest: verifiedManifest, sources };
}
