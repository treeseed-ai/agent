import { describe, expect, it, vi } from 'vitest';
import { fetchGovernedResearchSource, searchGovernedResearchSources } from '../../src/agents/tools/governed-research-tools.ts';

describe('governed research tools', () => {
	it('denies private and non-HTTPS research egress by default', async () => {
		await expect(fetchGovernedResearchSource({ url: 'https://127.0.0.1/source' }, { env: { TREESEED_RESEARCH_ALLOWED_DOMAINS: '127.0.0.1' }, fetchImpl: vi.fn() as never })).rejects.toThrow(/private, loopback, or link-local/u);
		await expect(fetchGovernedResearchSource({ url: 'http://example.com/source' }, { env: { TREESEED_RESEARCH_ALLOWED_DOMAINS: 'example.com' }, fetchImpl: vi.fn() as never })).rejects.toThrow(/HTTPS/u);
	});

	it('requires an explicit source allowlist', async () => {
		await expect(fetchGovernedResearchSource({ url: 'https://example.com/source' }, { env: {}, fetchImpl: vi.fn() as never })).rejects.toThrow(/research_source_policy_domains_invalid/u);
	});

	it('uses the schema-backed runtime policy instead of ambient domain configuration', async () => {
		const fetchImpl = vi.fn(async () => new Response('governed', {
			status: 200,
			headers: { 'content-type': 'text/plain' },
		}));
		const options = {
			env: { TREESEED_RESEARCH_ALLOW_PRIVATE_EGRESS: 'true', TREESEED_RESEARCH_ALLOWED_DOMAINS: 'ambient.example' },
			fetchImpl: fetchImpl as never,
			policy: {
				schemaVersion: 1 as const,
				allowedDomains: ['127.0.0.1'],
				requestTimeoutMs: 10_000,
				maxResponseBytes: 10_000,
				maxRedirects: 0,
				allowedContentTypes: ['text/plain'],
			},
		};
		await expect(fetchGovernedResearchSource({ url: 'https://127.0.0.1/source' }, { ...options, allowedDomains: ['127.0.0.1'] })).resolves.toMatchObject({ ok: true });
		await expect(fetchGovernedResearchSource({ url: 'https://ambient.example/source' }, options)).rejects.toThrow(/not allowed by policy/u);
		await expect(fetchGovernedResearchSource({ url: 'https://127.0.0.1/source' }, { ...options, allowedDomains: ['project-only.example'] })).rejects.toThrow(/research_source_policy_domains_invalid/u);
	});

	it('returns bounded citation metadata and a deterministic content hash', async () => {
		const fetchImpl = vi.fn(async () => new Response('Primary source body.', {
			status: 200,
			headers: { 'content-type': 'text/plain', 'content-length': '20' },
		}));
		const result = await fetchGovernedResearchSource({ url: 'https://127.0.0.1/source', maxBytes: 1024 }, {
			env: { TREESEED_RESEARCH_ALLOW_PRIVATE_EGRESS: 'true', TREESEED_RESEARCH_ALLOWED_DOMAINS: '127.0.0.1' },
			fetchImpl: fetchImpl as never,
		});
		expect(result.payload).toMatchObject({
			url: 'https://127.0.0.1/source',
			mediaType: 'text/plain',
			content: 'Primary source body.',
		});
		expect(result.payload.contentSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
	});

	it('normalizes configured search adapter results without exposing its credential', async () => {
		const fetchImpl = vi.fn(async (_url, init) => {
			expect((init?.headers as Record<string, string>).authorization).toBe('Bearer adapter-secret');
			return new Response(JSON.stringify({ results: [{ url: 'https://source.example/paper', title: 'Paper', snippet: 'Evidence.' }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		const result = await searchGovernedResearchSources({ query: 'capacity governance', maxResults: 5 }, {
			env: {
				TREESEED_RESEARCH_ALLOW_PRIVATE_EGRESS: 'true',
				TREESEED_RESEARCH_ALLOWED_DOMAINS: '127.0.0.1,source.example',
				TREESEED_RESEARCH_SEARCH_ENDPOINT: 'https://127.0.0.1/search',
				TREESEED_RESEARCH_SEARCH_TOKEN: 'adapter-secret',
			},
			fetchImpl: fetchImpl as never,
		});
		expect(result.payload.items).toEqual([{ url: 'https://source.example/paper', title: 'Paper', publisher: '', publishedAt: null, summary: 'Evidence.' }]);
		expect(JSON.stringify(result)).not.toContain('adapter-secret');
	});
});
