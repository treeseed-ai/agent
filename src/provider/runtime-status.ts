import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface ProviderRuntimeStatus {
	schemaVersion: 1;
	role: 'manager' | 'runner';
	pid: number;
	updatedAt: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

export async function writeProviderRuntimeStatus(dataDirectory: string, status: Omit<ProviderRuntimeStatus, 'schemaVersion' | 'pid' | 'updatedAt'>) {
	const path = resolve(dataDirectory, 'runtime', `${status.role}.json`);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const payload: ProviderRuntimeStatus = {
		schemaVersion: 1,
		pid: process.pid,
		updatedAt: new Date().toISOString(),
		...status,
	};
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, path);
	return payload;
}
