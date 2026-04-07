function parseArgs(argv: string[]) {
	const [, , command = 'doctor', ...rest] = argv;
	return {
		command,
		args: rest,
	};
}

function renderHelp() {
	return [
		'treeseed-agents <command>',
		'',
		'Commands:',
		'  doctor',
		'  run-agent <slug>',
		'  drain-messages',
		'  release-leases',
		'  replay-message <id>',
		'  start',
	].join('\n');
}

async function main() {
	const { command, args } = parseArgs(process.argv);
	if (command === '--help' || command === '-h' || command === 'help') {
		console.log(renderHelp());
		return;
	}

	const [{ AgentKernel }, { AgentSdk }] = await Promise.all([
		import('./kernel/agent-kernel.ts'),
		import('./sdk.ts'),
	]);

	const repoRoot = process.cwd();
	const sdk = AgentSdk.createLocal({
		repoRoot,
		databaseName: process.env.TREESEED_AGENT_D1_DATABASE ?? 'karyon-docs-site-data',
		persistTo: process.env.TREESEED_AGENT_D1_PERSIST_TO ?? undefined,
	});
	const kernel = new AgentKernel(sdk, repoRoot);

	if (command === 'doctor') {
		console.log(JSON.stringify({ ok: true, command, ...(await kernel.doctor()) }, null, 2));
		return;
	}
	if (command === 'run-agent') {
		console.log(JSON.stringify({ ok: true, command, slug: args[0], result: await kernel.runAgent(args[0]) }, null, 2));
		return;
	}
	if (command === 'drain-messages') {
		console.log(JSON.stringify({ ok: true, command, results: await kernel.drainMessages() }, null, 2));
		return;
	}
	if (command === 'release-leases') {
		console.log(JSON.stringify({ ok: true, command, result: await kernel.releaseLeases() }, null, 2));
		return;
	}
	if (command === 'replay-message') {
		console.log(JSON.stringify({ ok: true, command, result: await kernel.replayMessage(Number(args[0])) }, null, 2));
		return;
	}
	if (command === 'start') {
		console.log(JSON.stringify({ ok: true, command, status: 'starting' }, null, 2));
		await kernel.start();
		return;
	}

	throw new Error(`Unknown Treeseed command "${command}".`);
}

main().catch((error) => {
	console.error(
		JSON.stringify(
			{
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			},
			null,
			2,
		),
	);
	process.exit(1);
});
