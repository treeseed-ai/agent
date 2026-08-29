import { lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encryptedEnvelopeSchema } from '@treeseed/sdk/security';
import { rewrapProviderCredential } from './credential-vault.ts';

async function candidates(root: string, relative = ''): Promise<string[]> {
	const directory = resolve(root, relative), result: string[] = [];
	for (const name of await readdir(directory)) {
		const child = relative ? `${relative}/${name}` : name, path = resolve(root, child), information = await lstat(path);
		if (information.isSymbolicLink()) throw new Error(`Credential vault contains an unsupported symbolic link: ${child}`);
		if (information.isDirectory()) result.push(...await candidates(root, child)); else if (information.isFile() && information.size <= 1_048_576) result.push(path);
	}
	return result;
}

export async function rewrapProviderCredentialVault(root: string) {
	let scanned = 0, rewrapped = 0;
	for (const path of await candidates(resolve(root))) {
		scanned += 1; const serialized = await readFile(path, 'utf8'); let parsed;
		try { parsed = encryptedEnvelopeSchema.safeParse(JSON.parse(serialized)); } catch { continue; }
		if (!parsed.success || parsed.data.aad.purpose !== 'provider-credential') continue;
		const updated = await rewrapProviderCredential(serialized); if (updated === serialized) continue;
		const temporary = `${path}.${process.pid}.rewrap`; await writeFile(temporary, updated, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); rewrapped += 1;
	}
	return { scanned, rewrapped };
}

if (process.argv[1]?.endsWith('/rewrap-vault.js')) {
	const root = process.argv[2]; if (!root) throw new Error('Provider credential vault root is required.');
	process.stdout.write(`${JSON.stringify(await rewrapProviderCredentialVault(root))}\n`);
}
