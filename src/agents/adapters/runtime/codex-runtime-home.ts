import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCodexAuthFile } from '../accounts/codex-auth.ts';

export interface CodexRuntimeHome {
	codexHome: string;
	authFile: string;
	cleanup(): Promise<void>;
}

export async function createIsolatedCodexRuntimeHome(options: {
	sourceAuthFile?: string;
	serviceTier?: 'fast';
	model?: string;
} = {}): Promise<CodexRuntimeHome> {
	const sourceAuthFile = options.sourceAuthFile ?? resolveCodexAuthFile();
	if (!existsSync(sourceAuthFile)) {
		throw new Error(`Codex auth file was not found at ${sourceAuthFile}. Run Codex login or set TREESEED_CODEX_AUTH_FILE.`);
	}
	const codexHome = await mkdtemp(join(tmpdir(), 'treeseed-live-codex-'));
	const authFile = join(codexHome, 'auth.json');
	await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
	await copyFile(sourceAuthFile, authFile);
	const serviceTier = options.serviceTier === 'fast' ? 'fast' : null;
	const model = options.model ?? (process.env.TREESEED_CODEX_DEFAULT_MODEL?.trim() || 'gpt-5.5');
	const configLines = [
		'approval_policy = "never"',
		'sandbox_mode = "workspace-write"',
		`model = ${JSON.stringify(model)}`,
		serviceTier ? `service_tier = ${JSON.stringify(serviceTier)}` : null,
		'',
		'[sandbox_workspace_write]',
		'network_access = true',
		'',
	].filter((line): line is string => line !== null);
	await writeFile(join(codexHome, 'config.toml'), configLines.join('\n'), { encoding: 'utf8', mode: 0o600 });
	return {
		codexHome,
		authFile,
		cleanup: () => rm(codexHome, { recursive: true, force: true }),
	};
}
