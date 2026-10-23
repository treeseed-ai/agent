import { isAbsolute } from 'node:path';
import { run } from './process-runner.ts';

/** Runtime input, not an agent/task/profile contract. Signed input custody owns its bytes. */
export interface Workload {
	executable: string;
	arguments: string[];
	workingDirectory: string;
	environment?: Record<string, string>;
}

export function parseWorkload(input: unknown): Workload {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('workload_manifest_invalid');
	const value = input as Record<string, unknown>;
	if (Object.keys(value).some(key => !['executable', 'arguments', 'workingDirectory', 'environment'].includes(key))
		|| typeof value.executable !== 'string' || !isAbsolute(value.executable) || value.executable.includes('\0')
		|| !Array.isArray(value.arguments) || value.arguments.some(argument => typeof argument !== 'string' || argument.includes('\0'))
		|| typeof value.workingDirectory !== 'string' || !isAbsolute(value.workingDirectory) || value.workingDirectory.includes('\0')) {
		throw new Error('workload_manifest_invalid');
	}
	if (value.environment !== undefined && (!value.environment || typeof value.environment !== 'object' || Array.isArray(value.environment)
		|| Object.entries(value.environment).some(([key, entry]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof entry !== 'string' || entry.includes('\0')))) {
		throw new Error('workload_environment_invalid');
	}
	return { executable: value.executable, arguments: [...value.arguments] as string[], workingDirectory: value.workingDirectory,
		...(value.environment === undefined ? {} : { environment: { ...value.environment as Record<string, string> } }) };
}

/** The original bounded process runner executes opaque programs without interpreting their outputs. */
export function executeWorkload(input: unknown, limits: { timeoutMs: number; outputBytes: number }) {
	const workload = parseWorkload(input);
	return run(workload.executable, workload.arguments, { cwd: workload.workingDirectory,
		env: { ...process.env, ...workload.environment }, timeoutMs: limits.timeoutMs,
		captureStdout: true, maxStdoutBytes: limits.outputBytes });
}
