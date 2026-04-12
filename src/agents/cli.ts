import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TreeseedAgentCliCommandName =
	| 'doctor'
	| 'run-agent'
	| 'drain-messages'
	| 'release-leases'
	| 'replay-message'
	| 'start';

export type TreeseedAgentCliCommandSpec = {
	name: TreeseedAgentCliCommandName;
	usage: string;
	summary: string;
};

export type TreeseedAgentCliContext = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	write?: (output: string, stream?: 'stdout' | 'stderr') => void;
	outputFormat?: 'human' | 'json';
};

const AGENT_COMMAND_SPECS: TreeseedAgentCliCommandSpec[] = [
	{ name: 'doctor', usage: 'doctor', summary: 'Inspect agent runtime readiness for the current tenant.' },
	{ name: 'run-agent', usage: 'run-agent <slug>', summary: 'Run one registered agent handler by slug.' },
	{ name: 'drain-messages', usage: 'drain-messages', summary: 'Drain queued agent messages through the local kernel.' },
	{ name: 'release-leases', usage: 'release-leases', summary: 'Release active task leases held by the local kernel.' },
	{ name: 'replay-message', usage: 'replay-message <id>', summary: 'Replay one message by numeric id.' },
	{ name: 'start', usage: 'start', summary: 'Start the local agent kernel loop.' },
] as const;

function parseArgs(argv: string[]) {
	const [command = 'doctor', ...rest] = argv;
	return {
		command,
		args: rest,
	};
}

export function listTreeseedAgentCommands() {
	return [...AGENT_COMMAND_SPECS];
}

export function renderTreeseedAgentHelp() {
	return [
		'treeseed agents <command>',
		'',
		'Commands:',
		...AGENT_COMMAND_SPECS.map((command) => `  ${command.usage.padEnd(24)}${command.summary}`),
	].join('\n');
}

function defaultWrite(output: string, stream: 'stdout' | 'stderr' = 'stdout') {
	if (!output) return;
	(stream === 'stderr' ? process.stderr : process.stdout).write(`${output}\n`);
}

function resolveExecutablePath(path: string) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export async function runTreeseedAgentCli(argv: string[], context: TreeseedAgentCliContext = {}) {
	const { command, args } = parseArgs(argv);
	const write = context.write ?? defaultWrite;
	if (command === '--help' || command === '-h' || command === 'help') {
		write(renderTreeseedAgentHelp(), 'stdout');
		return 0;
	}

	const [{ AgentKernel }, { AgentSdk }] = await Promise.all([
		import('./kernel/agent-kernel.ts'),
		import('@treeseed/sdk/sdk'),
	]);

	const repoRoot = context.cwd ?? process.cwd();
	const env = { ...process.env, ...(context.env ?? {}) };
	const sdk = AgentSdk.createLocal({
		repoRoot,
		databaseName: env.TREESEED_AGENT_D1_DATABASE ?? 'karyon-docs-site-data',
		persistTo: env.TREESEED_AGENT_D1_PERSIST_TO ?? undefined,
	});
	const kernel = new AgentKernel(sdk, repoRoot);

	const emitPayload = async (payload: Promise<unknown> | unknown) => {
		write(JSON.stringify(await payload, null, 2), 'stdout');
		return 0;
	};

	if (command === 'doctor') {
		return emitPayload({ ok: true, command, ...(await kernel.doctor()) });
	}
	if (command === 'run-agent') {
		return emitPayload({ ok: true, command, slug: args[0], result: await kernel.runAgent(args[0]) });
	}
	if (command === 'drain-messages') {
		return emitPayload({ ok: true, command, results: await kernel.drainMessages() });
	}
	if (command === 'release-leases') {
		return emitPayload({ ok: true, command, result: await kernel.releaseLeases() });
	}
	if (command === 'replay-message') {
		return emitPayload({ ok: true, command, result: await kernel.replayMessage(Number(args[0])) });
	}
	if (command === 'start') {
		write(JSON.stringify({ ok: true, command, status: 'starting' }, null, 2), 'stdout');
		await kernel.start();
		return 0;
	}

	throw new Error(`Unknown Treeseed command "${command}".`);
}

const currentFile = resolveExecutablePath(fileURLToPath(import.meta.url));
const entryFile = resolveExecutablePath(process.argv[1] ?? '');

if (entryFile === currentFile) {
	runTreeseedAgentCli(process.argv.slice(2)).catch((error) => {
		defaultWrite(
			JSON.stringify(
				{
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				},
				null,
				2,
			),
			'stderr',
		);
		process.exit(1);
	});
}
