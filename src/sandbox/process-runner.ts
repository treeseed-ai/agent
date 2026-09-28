import { spawn } from 'node:child_process';

/** Run a guest subprocess; an idle interruption never extends its hard deadline. */
export function run(executable: string, args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; captureStdout?: boolean; maxStdoutBytes?: number; timeoutMs?: number; idleTimeoutMs?: number; closeoutTimeoutMs?: number; canInterrupt?: () => boolean } = {}) {
	return new Promise<{ stderr: string; stdout: string }>((accept, reject) => {
		const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); let pending = '', stderr = '', stdout = '', timedOut = false, interrupted = false;
		if (!child.stdout || !child.stderr) { reject(new Error(`Could not capture ${executable} output.`)); return; }
		const childStdout = child.stdout, childStderr = child.stderr;
		const timeout = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs) : null;
		let idleTimeout: ReturnType<typeof setTimeout> | null = null, closeoutTimeout: ReturnType<typeof setTimeout> | null = null,
			interruptTimeout: ReturnType<typeof setTimeout> | null = null;
		const interrupt = () => {
			if (interrupted || options.canInterrupt?.() === false) return false;
			interrupted = true;
			child.kill('SIGINT');
			interruptTimeout = setTimeout(() => child.kill('SIGKILL'), 3_000);
			return true;
		};
		const resetIdle = () => {
			if (idleTimeout) clearTimeout(idleTimeout);
			if (!options.idleTimeoutMs || interrupted) return;
			idleTimeout = setTimeout(() => {
				if (!interrupt()) resetIdle();
			}, options.idleTimeoutMs);
		};
		resetIdle();
		const tryCloseout = () => {
			if (!interrupt()) closeoutTimeout = setTimeout(tryCloseout, 1_000);
		};
		if (options.closeoutTimeoutMs) closeoutTimeout = setTimeout(tryCloseout, options.closeoutTimeoutMs);
		const clearTimers = () => { if (timeout) clearTimeout(timeout); if (idleTimeout) clearTimeout(idleTimeout);
			if (closeoutTimeout) clearTimeout(closeoutTimeout); if (interruptTimeout) clearTimeout(interruptTimeout); };
		childStdout.setEncoding('utf8'); childStdout.on('data', (chunk) => {
			const value = String(chunk);
			if (options.captureStdout) { stdout += value; if (Buffer.byteLength(stdout) > (options.maxStdoutBytes ?? 8_388_608)) child.kill('SIGKILL'); }
			pending += value; const lines = pending.split('\n'); pending = lines.pop() ?? ''; for (const line of lines) if (line.trim()) { resetIdle(); options.onLine?.(line); }
		});
		childStderr.setEncoding('utf8'); childStderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_768); });
		child.once('error', (error) => { clearTimers(); reject(error); }); child.once('exit', (code, signal) => { clearTimers(); if (pending.trim()) options.onLine?.(pending); interrupted ? reject(new Error('codex_closeout_interrupted')) : code === 0 ? accept({ stderr, stdout }) : reject(new Error(timedOut ? `${executable} exceeded its interactive execution deadline.` : `${executable} exited ${code ?? signal}: ${stderr}`)); });
		child.stdin?.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error); });
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}
