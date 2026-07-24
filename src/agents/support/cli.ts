import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type AgentCliCommandName = 'doctor';

export type AgentCliCommandSpec = {
	name: AgentCliCommandName;
	usage: string;
	summary: string;
};

export type AgentCliContext = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	write?: (output: string, stream?: 'stdout' | 'stderr') => void;
	outputFormat?: 'human' | 'json';
};

const AGENT_COMMAND_SPECS: AgentCliCommandSpec[] = [
	{ name: 'doctor', usage: 'doctor', summary: 'Inspect agent runtime readiness for the current tenant.' },
] as const;

function parseArgs(argv: string[]) {
	const [command = 'doctor', ...rest] = argv;
	return {
		command,
		args: rest,
	};
}

export function listAgentCommands() {
	return [...AGENT_COMMAND_SPECS];
}

export function renderAgentHelp() {
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

export async function runAgentCli(argv: string[], context: AgentCliContext = {}) {
	const { command } = parseArgs(argv);
	const write = context.write ?? defaultWrite;
	if (command === '--help' || command === '-h' || command === 'help') {
		write(renderAgentHelp(), 'stdout');
		return 0;
	}

	const [{ AgentKernel }, { AgentSdk }] = await Promise.all([
		import('../kernel/agents/agent-kernel.ts'),
		import('@treeseed/sdk/sdk'),
	]);

	const repoRoot = context.cwd ?? process.cwd();
	const env = { ...process.env, ...(context.env ?? {}) };
	const sdk = AgentSdk.createLocal({
		repoRoot,
		databaseName: env.TREESEED_AGENT_D1_DATABASE ?? 'docs-site-data',
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
	throw new Error(`Unknown Treeseed command "${command}".`);
}

const currentFile = resolveExecutablePath(fileURLToPath(import.meta.url));
const entryFile = resolveExecutablePath(process.argv[1] ?? '');

if (entryFile === currentFile) {
	runAgentCli(process.argv.slice(2)).catch((error) => {
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
