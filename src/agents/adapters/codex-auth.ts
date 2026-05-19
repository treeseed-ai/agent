import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function envValue(env: NodeJS.ProcessEnv, name: string) {
	return env[name]?.trim() || '';
}

export function resolveCodexAuthFile(env: NodeJS.ProcessEnv = process.env) {
	const explicit = envValue(env, 'TREESEED_CODEX_AUTH_FILE') || envValue(env, 'CODEX_AUTH_FILE');
	if (explicit) return explicit;
	const codexHome = envValue(env, 'TREESEED_CODEX_HOME') || envValue(env, 'CODEX_HOME');
	if (codexHome) return join(codexHome, 'auth.json');
	const defaultHome = envValue(env, 'TREESEED_PROCESSING_PARITY')
		? join(envValue(env, 'TREESEED_DATA_DIR') || '/data', 'codex')
		: join(envValue(env, 'HOME') || homedir(), '.codex');
	return join(defaultHome, 'auth.json');
}

export function codexClientEnvironment(env: NodeJS.ProcessEnv = process.env) {
	const authFile = resolveCodexAuthFile(env);
	return {
		...env,
		TREESEED_CODEX_AUTH_FILE: authFile,
		CODEX_HOME: dirname(authFile),
	};
}

function readSecret(env: NodeJS.ProcessEnv) {
	const raw = envValue(env, 'TREESEED_CODEX_AUTH_JSON');
	if (raw) return raw;
	const encoded = envValue(env, 'TREESEED_CODEX_AUTH_JSON_B64');
	if (!encoded) return null;
	return Buffer.from(encoded, 'base64').toString('utf8');
}

export async function materializeCodexAuthFromEnv(env: NodeJS.ProcessEnv = process.env) {
	const secret = readSecret(env);
	const authFile = resolveCodexAuthFile(env);
	const overwrite = ['1', 'true', 'yes', 'on'].includes(envValue(env, 'TREESEED_CODEX_AUTH_OVERWRITE').toLowerCase());
	if (!secret) {
		return { materialized: false, reason: 'no_secret', authFile };
	}
	if (existsSync(authFile) && !overwrite) {
		env.TREESEED_CODEX_AUTH_FILE = authFile;
		env.CODEX_HOME = dirname(authFile);
		return { materialized: false, reason: 'exists', authFile };
	}
	try {
		JSON.parse(secret);
	} catch {
		throw new Error('TREESEED_CODEX_AUTH_JSON_B64/TREESEED_CODEX_AUTH_JSON must decode to a valid Codex auth JSON object.');
	}
	await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
	await writeFile(authFile, secret.endsWith('\n') ? secret : `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
	await chmod(dirname(authFile), 0o700).catch(() => undefined);
	await chmod(authFile, 0o600).catch(() => undefined);
	env.TREESEED_CODEX_AUTH_FILE = authFile;
	env.CODEX_HOME = dirname(authFile);
	return { materialized: true, reason: overwrite ? 'overwritten' : 'created', authFile };
}
