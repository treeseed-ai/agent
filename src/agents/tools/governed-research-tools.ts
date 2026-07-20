import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { assertResearchSourcePolicy, type ResearchSourcePolicy } from '@treeseed/sdk/agent-capacity';

const MAX_SOURCE_BYTES = 1_000_000;
const DEFAULT_ALLOWED_CONTENT_TYPES = ['text/*', 'application/json', 'application/xml', 'application/xhtml+xml'];

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function privateIpv4(address: string) {
	const parts = address.split('.').map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
	return parts[0] === 10
		|| parts[0] === 127
		|| (parts[0] === 169 && parts[1] === 254)
		|| (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
		|| (parts[0] === 192 && parts[1] === 168)
		|| parts[0] === 0;
}

function privateIp(address: string) {
	if (isIP(address) === 4) return privateIpv4(address);
	const normalized = address.toLowerCase();
	return normalized === '::1'
		|| normalized === '::'
		|| normalized.startsWith('fc')
		|| normalized.startsWith('fd')
		|| normalized.startsWith('fe8')
		|| normalized.startsWith('fe9')
		|| normalized.startsWith('fea')
		|| normalized.startsWith('feb')
		|| normalized.startsWith('::ffff:127.')
		|| normalized.startsWith('::ffff:10.')
		|| normalized.startsWith('::ffff:192.168.');
}

function sourcePolicy(env: NodeJS.ProcessEnv, configured?: ResearchSourcePolicy, allowedDomains?: string[]): ResearchSourcePolicy {
	const providerPolicy = configured ? assertResearchSourcePolicy(configured) : assertResearchSourcePolicy({
		schemaVersion: 1,
		allowedDomains: String(env.TREESEED_RESEARCH_ALLOWED_DOMAINS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
		requestTimeoutMs: Number(env.TREESEED_RESEARCH_REQUEST_TIMEOUT_MS ?? 20_000),
		maxResponseBytes: Number(env.TREESEED_RESEARCH_MAX_RESPONSE_BYTES ?? MAX_SOURCE_BYTES),
		maxRedirects: Number(env.TREESEED_RESEARCH_MAX_REDIRECTS ?? 3),
		allowedContentTypes: String(env.TREESEED_RESEARCH_ALLOWED_CONTENT_TYPES ?? DEFAULT_ALLOWED_CONTENT_TYPES.join(',')).split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
	});
	if (!allowedDomains) return providerPolicy;
	const projectDomains = allowedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean);
	return assertResearchSourcePolicy({
		...providerPolicy,
		allowedDomains: providerPolicy.allowedDomains.filter((domain) => projectDomains.some((projectDomain) => domain === projectDomain || domain.endsWith(`.${projectDomain}`) || projectDomain.endsWith(`.${domain}`))),
	});
}

function domainAllowed(hostname: string, policy: ResearchSourcePolicy) {
	const candidate = hostname.toLowerCase().replace(/\.$/u, '');
	return policy.allowedDomains.some((allowed) => candidate === allowed || candidate.endsWith(`.${allowed}`));
}

async function governedUrl(value: unknown, env: NodeJS.ProcessEnv, policy: ResearchSourcePolicy) {
	let url: URL;
	try { url = new URL(String(value ?? '')); } catch { throw new Error('Research source URL is invalid.'); }
	if (url.protocol !== 'https:') throw new Error('Research egress permits HTTPS URLs only.');
	if (url.username || url.password) throw new Error('Research source URLs cannot contain credentials.');
	if (url.port && url.port !== '443') throw new Error('Research source URLs must use the standard HTTPS port.');
	if (!domainAllowed(url.hostname, policy)) throw new Error(`Research source domain ${url.hostname} is not allowed by policy.`);
	const addresses = await lookup(url.hostname, { all: true, verbatim: true });
	if (!addresses.length) throw new Error('Research source hostname did not resolve.');
	if (env.TREESEED_RESEARCH_ALLOW_PRIVATE_EGRESS !== 'true' && addresses.some((entry) => privateIp(entry.address))) {
		throw new Error('Research egress denied a private, loopback, or link-local destination.');
	}
	return url;
}

async function boundedBody(response: Response, maxBytes: number) {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Research source exceeds the ${maxBytes}-byte response limit.`);
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const item = await reader.read();
		if (item.done) break;
		length += item.value.byteLength;
		if (length > maxBytes) {
			await reader.cancel();
			throw new Error(`Research source exceeds the ${maxBytes}-byte response limit.`);
		}
		chunks.push(item.value);
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
	return result;
}

async function fetchGoverned(url: URL, env: NodeJS.ProcessEnv, policy: ResearchSourcePolicy, fetchImpl: typeof fetch, headers: Record<string, string> = {}) {
	let current = url;
	for (let redirects = 0; redirects <= policy.maxRedirects; redirects += 1) {
		current = await governedUrl(current.toString(), env, policy);
		const response = await fetchImpl(current, {
			headers: { accept: 'text/html, text/plain, application/json, application/xml;q=0.8', 'user-agent': 'TreeseedResearch/1.0', ...headers },
			redirect: 'manual',
			signal: AbortSignal.timeout(policy.requestTimeoutMs),
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (!location || redirects === policy.maxRedirects) throw new Error('Research source redirect limit was exceeded.');
			current = new URL(location, current);
			continue;
		}
		return { response, url: current };
	}
	throw new Error('Research source redirect limit was exceeded.');
}

export async function fetchGovernedResearchSource(input: Record<string, unknown>, options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; policy?: ResearchSourcePolicy; allowedDomains?: string[] } = {}) {
	const env = options.env ?? process.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const policy = sourcePolicy(env, options.policy, options.allowedDomains);
	const requested = await governedUrl(input.url, env, policy);
	const maxBytes = Math.max(1_024, Math.min(Number(input.maxBytes ?? policy.maxResponseBytes), policy.maxResponseBytes));
	const { response, url } = await fetchGoverned(requested, env, policy, fetchImpl);
	if (!response.ok) throw new Error(`Research source returned HTTP ${response.status}.`);
	const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? 'application/octet-stream';
	if (!policy.allowedContentTypes.some((allowed) => allowed === mediaType || (allowed.endsWith('/*') && mediaType.startsWith(allowed.slice(0, -1))))) {
		throw new Error(`Research source media type ${mediaType} is not supported.`);
	}
	const bytes = await boundedBody(response, maxBytes);
	const text = new TextDecoder().decode(bytes);
	return {
		ok: true,
		payload: {
			url: url.toString(),
			retrievedAt: new Date().toISOString(),
			mediaType,
			contentLength: bytes.byteLength,
			contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
			content: text,
		},
	};
}

export async function searchGovernedResearchSources(input: Record<string, unknown>, options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; policy?: ResearchSourcePolicy; allowedDomains?: string[] } = {}) {
	const env = options.env ?? process.env;
	const policy = sourcePolicy(env, options.policy, options.allowedDomains);
	const endpoint = env.TREESEED_RESEARCH_SEARCH_ENDPOINT?.trim();
	if (!endpoint) throw new Error('TREESEED_RESEARCH_SEARCH_ENDPOINT is required for governed source discovery.');
	const url = await governedUrl(endpoint, env, policy);
	url.searchParams.set('q', String(input.query ?? ''));
	url.searchParams.set('limit', String(Math.max(1, Math.min(Number(input.maxResults ?? 10), 20))));
	const headers: Record<string, string> = env.TREESEED_RESEARCH_SEARCH_TOKEN ? { authorization: `Bearer ${env.TREESEED_RESEARCH_SEARCH_TOKEN}` } : {};
	const { response, url: finalUrl } = await fetchGoverned(url, env, policy, options.fetchImpl ?? fetch, headers);
	if (!response.ok) throw new Error(`Research search adapter returned HTTP ${response.status}.`);
	const bytes = await boundedBody(response, policy.maxResponseBytes);
	const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	const root = record(parsed);
	const candidates = [root.items, root.results, root.sources].find(Array.isArray) ?? [];
	const items = (candidates as unknown[]).slice(0, 20).map((entry) => {
		const source = record(entry);
		return {
			url: String(source.url ?? source.link ?? ''),
			title: String(source.title ?? ''),
			publisher: String(source.publisher ?? source.siteName ?? ''),
			publishedAt: source.publishedAt ?? source.published_at ?? null,
			summary: String(source.summary ?? source.snippet ?? '').slice(0, 2_000),
		};
	}).filter((entry) => {
		try { return entry.url.startsWith('https://') && domainAllowed(new URL(entry.url).hostname, policy); } catch { return false; }
	});
	return { ok: true, payload: { query: String(input.query ?? ''), adapter: finalUrl.origin, retrievedAt: new Date().toISOString(), items } };
}
