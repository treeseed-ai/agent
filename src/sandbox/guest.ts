import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sandboxAssignmentSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import { run } from './process-runner.ts';
import { executeWorkload } from './workload.ts';

const inputRoot = '/run/treeseed-assignment', outputRoot = '/run/treeseed-output';
// Application payload fields are opaque. Only the existing environment contract is consumed here.
const environmentSchema = sandboxAssignmentSchema.pick({ inputs: true, resources: true }).passthrough();
const progress = (stage: string) => writeFile(resolve(outputRoot, 'progress.json'),
	`${JSON.stringify({ stage, occurredAt: new Date().toISOString() })}\n`, { mode: 0o600 });

export async function prepareGuestEnvironment() {
	const started = performance.now();
	const envelope = environmentSchema.parse(JSON.parse(await readFile(resolve(inputRoot, 'assignment.json'), 'utf8')));
	const remaining = () => Math.floor(envelope.resources.durationSeconds * 1000 - (performance.now() - started));
	for (const descriptor of envelope.inputs) {
		const source = resolve(inputRoot, `input-${descriptor.id}`), information = await stat(source);
		if (information.size !== descriptor.bytes) throw new Error('workload_input_size_mismatch');
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(source)) hash.update(chunk as Buffer);
		if (`sha256:${hash.digest('hex')}` !== descriptor.digest) throw new Error('workload_input_digest_mismatch');
		const target = resolve(descriptor.targetPath);
		if (!target.startsWith('/workspace/')) throw new Error('workload_input_path_invalid');
		await progress(`input.${descriptor.id}.copy`);
		await mkdir(descriptor.mediaType.endsWith('+tar') ? target : dirname(target), { recursive: true, mode: 0o700 });
		if (descriptor.mediaType === 'application/vnd.treeseed.directory+tar') {
			await run('/bin/tar', ['--extract', '--file', source, '--directory', target, '--no-same-owner', '--no-same-permissions'], { timeoutMs: Math.min(10_000, remaining()) });
		} else await writeFile(target, await readFile(source), { mode: descriptor.disposition === 'read-only' ? 0o400 : 0o600 });
		if (descriptor.disposition === 'read-only') {
			await run('/bin/chmod', ['-R', 'a-w', target], { timeoutMs: Math.min(10_000, remaining()) });
			await chmod(target, 0o500);
		}
		await progress(`input.${descriptor.id}.ready`);
	}
	return { envelope, remaining };
}

export async function runSandboxGuest() {
	await mkdir(outputRoot, { recursive: true });
	const { envelope, remaining } = await prepareGuestEnvironment();
	const descriptor = envelope.inputs.find(input => input.id === 'workload');
	if (!descriptor) throw new Error('prepared_workload_required');
	const workload: unknown = JSON.parse(await readFile(descriptor.targetPath, 'utf8'));
	await progress('workload.starting');
	await executeWorkload(workload, { timeoutMs: remaining(), outputBytes: envelope.resources.outputBytes });
	await progress('workload.completed');
}

if (process.argv[1]?.endsWith('/sandbox/guest.js')) runSandboxGuest().catch(async error => {
	await mkdir(outputRoot, { recursive: true });
	await writeFile(resolve(outputRoot, 'failure.json'), `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
});
