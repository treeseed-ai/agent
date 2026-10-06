// Disposable subprocess input for the ORIGINAL guest process runner. Not a
// model/provider, alternate runner, fabricated usage or acceptance receipt.
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2], outputPath = process.argv[3];
process.stdout.write(`started:${process.pid}\n`);
if (mode === 'descendant-leaf') {
	if (!outputPath) throw new Error('Allocated descendant output path required');
	process.on('SIGINT', () => { /* Deliberately refuses graceful interruption. */ });
	setInterval(() => {}, 100);
	setTimeout(() => writeFileSync(outputPath, 'forbidden surviving descendant output\n'), 10_000);
	if (!process.send) throw new Error('Original allocated child IPC required');
	process.send(process.pid);
} else if (['descendant-hard', 'descendant-closeout', 'descendant-failed'].includes(mode ?? '')) {
	if (!outputPath) throw new Error('Allocated descendant output path required');
	const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'descendant-leaf', outputPath], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
	child.once('error', error => { throw error; });
	child.once('spawn', () => {
		if (!child.pid) throw new Error('Actual allocated descendant PID required');
		process.stdout.write(`descendant:${child.pid}\n`);
	});
	child.once('message', value => {
		if (value !== child.pid) throw new Error('Original allocated descendant readiness PID disagrees');
		process.stdout.write(`descendant-ready:${child.pid}\n`);
		if (mode === 'descendant-failed') { process.stderr.write('original parent failure with owned descendant\n'); process.exit(23); }
	});
	setInterval(() => process.stdout.write('owned descendant still bounded\n'), 30);
	if (mode === 'descendant-closeout') process.on('SIGINT', () => { process.stdout.write('parent closeout received\n'); process.exit(0); });
} else if (mode === 'failed') {
	process.stdout.write('actual failed-command output\n');
	process.stderr.write('actual failed-command cause\n');
	process.exitCode = 23;
} else if (mode === 'reply') {
	process.stdout.write('same-window reply\n');
} else if (mode === 'closeout') {
	const active = setInterval(() => {}, 100);
	process.on('SIGINT', () => { clearInterval(active); process.stdout.write('closeout received\n'); });
} else if (mode === 'progress') {
	setInterval(() => process.stdout.write('ongoing\n'), 30);
	setTimeout(() => {
		if (!outputPath) throw new Error('Disposable late-output path required');
		writeFileSync(outputPath, 'late candidate must not appear');
	}, 10_000);
} else {
	throw new Error('Unknown disposable subprocess mode');
}
