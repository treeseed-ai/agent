// Allocated PID-namespace input for the original runner, never an assignment.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { run } from '../../../../src/sandbox/process-runner.ts';

const mode = process.argv[2];
if (!['descendant-failed', 'descendant-hard', 'descendant-closeout'].includes(mode ?? '')) throw new Error('Unknown native init case');
const fixture = fileURLToPath(new URL('./budget-process.ts', import.meta.url));
const lines: string[] = [];
let failure: unknown;
try {
	await run(process.execPath, ['--import', 'tsx', fixture, mode!, '/tmp/forbidden-late-output'], {
		timeoutMs: 5_000, captureStdout: true, onLine: line => { lines.push(line); },
		...(mode === 'descendant-closeout' ? { closeoutTimeoutMs: 1_500, canInterrupt: () => true } : {}),
	});
} catch (error) { failure = error; }
const absent = (prefix: string) => {
	const found = lines.filter(line => line.startsWith(prefix));
	if (found.length !== 1) return false;
	const pid = Number(found[0]!.slice(prefix.length));
	if (!Number.isSafeInteger(pid) || pid <= 1) return false;
	try { process.kill(pid, 0); return false; }
	catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true; throw error; }
};
const error = failure instanceof Error ? failure : null;
let lateOutputAbsent = false;
try { await readFile('/tmp/forbidden-late-output'); }
catch (value) { if (value instanceof Error && 'code' in value && value.code === 'ENOENT') lateOutputAbsent = true; else throw value; }
console.log(JSON.stringify({ mode, supervisorPid: process.pid,
	message: error?.message ?? null, cause: error?.cause instanceof Error ? error.cause.message : null,
	exitCode: error && 'exitCode' in error ? error.exitCode : null,
	parentAbsent: absent('started:'), descendantAbsent: absent('descendant:'), lateOutputAbsent }));
