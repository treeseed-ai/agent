import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export type Row = Record<string, unknown>;
export const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

export function read(args: string[], team: string, library = false, timeoutMs = 120_000): Row {
	let output: string;
	try {
		output = execFileSync('trsd', [...args, ...(library ? [] : ['--server', 'local', '--team', team]), '--json'], {
			encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
		});
	} catch (failure) {
		const failed = row(failure);
		let code = failed.code;
		const output = typeof failed.stdout === 'string' ? failed.stdout : Buffer.isBuffer(failed.stdout) ? failed.stdout.toString('utf8') : '';
		try {
			const start = output.search(/^\{/mu);
			if (start >= 0) code = row(row(JSON.parse(output.slice(start))).error).code ?? code;
		} catch { /* Preserve only the safe error class; never surface command output. */ }
		const safeCode = typeof code === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/u.test(code) ? code : 'COMMAND_FAILED';
		throw new Error(`ACCEPTANCE_CLI_COMMAND: ${args.slice(0, 2).join('.')} ${safeCode}`);
	}
	const start = output.search(/^\{/mu);
	assert.ok(start >= 0, 'CLI omitted its JSON result envelope');
	const envelope = row(JSON.parse(output.slice(start)));
	assert.equal(envelope.ok, true, 'ACCEPTANCE_CLI_RESPONSE: Supported command failed; inspect its protected receipt');
	return row(envelope.result);
}
