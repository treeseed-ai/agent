import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EncryptedEnvelopeCodec, StaticEnvelopeKeyProvider, encryptedEnvelopeSchema } from '@treeseed/sdk/security';

function keyMaterial() {
	const path = process.env.TREESEED_PROVIDER_CREDENTIAL_KEK_FILE ?? '/run/credentials/application-credential-kek';
	return readFile(path).then((value) => value).catch((error: NodeJS.ErrnoException) => {
		const environment = process.env.TREESEED_PROVIDER_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? 'development';
		if (!['local', 'test', 'development'].includes(environment)) throw new Error(`Provider credential KEK is unavailable: ${error.code ?? 'read_failed'}`);
		return Buffer.from(process.env.TREESEED_PROVIDER_CREDENTIAL_KEK ?? 'treeseed-development-provider-credential-kek');
	});
}

async function codec() {
	const material = await keyMaterial(), key = createHash('sha256').update(material).digest(); material.fill(0);
	const historical = await Promise.all(String(process.env.TREESEED_PROVIDER_CREDENTIAL_HISTORICAL_KEY_FILES ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).map(async (entry) => {
		const match = /^(\d+):(.+)$/u.exec(entry); if (!match) throw new Error('Historical provider credential keys must use VERSION:/absolute/path entries.');
		const value = await readFile(match[2]!); try { return { id: 'provider-credentials', version: Number(match[1]), key: createHash('sha256').update(value).digest() }; } finally { value.fill(0); }
	}));
	const provider = new StaticEnvelopeKeyProvider('systemd-credential', { id: 'provider-credentials', version: Number(process.env.TREESEED_PROVIDER_CREDENTIAL_KEY_VERSION ?? 1), key }, historical);
	return new EncryptedEnvelopeCodec(provider);
}

const aad = (resourceId: string) => ({ purpose: 'provider-credential', teamId: 'provider-local', resourceType: 'provider-secret', resourceId, schemaVersion: 'treeseed.encrypted-envelope/v1' });

export async function encryptProviderCredential(resourceId: string, plaintext: string) {
	const value = (await codec()).encrypt(Buffer.from(plaintext), aad(resourceId));
	return `${JSON.stringify(value)}\n`;
}

export async function decryptProviderCredential(resourceId: string, serialized: string) {
	const parsed = encryptedEnvelopeSchema.safeParse(JSON.parse(serialized));
	if (!parsed.success) throw new Error('Provider credential envelope is invalid.');
	const plaintext = (await codec()).decrypt(parsed.data);
	try { return plaintext.toString('utf8'); } finally { plaintext.fill(0); }
}

export async function rewrapProviderCredential(serialized: string) {
	const parsed = encryptedEnvelopeSchema.parse(JSON.parse(serialized)); return `${JSON.stringify((await codec()).rewrap(parsed))}\n`;
}

export function isProviderCredentialEnvelope(serialized: string) {
	try { return encryptedEnvelopeSchema.safeParse(JSON.parse(serialized)).success; } catch { return false; }
}
