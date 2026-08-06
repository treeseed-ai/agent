import { describe, expect, it, vi } from 'vitest';
import { OpenCodeExecutionProviderAdapter } from '../../../../src/agents/adapters/opencode/execution-opencode.ts';

describe('OpenCode execution provider', () => {
	it('uses headless sessions, records authoritative token/cost classes, and aborts without serializing brokered credentials', async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(url), init });
			if (String(url).endsWith('/global/health')) return Response.json({ healthy: true });
			if (String(url).endsWith('/session') && init?.method === 'POST') return Response.json({ id: 'session-1' });
			if (String(url).endsWith('/message')) return Response.json({ parts: [{ type: 'text', text: 'Complete.' }], info: { tokens: { input: 120, output: 30, reasoning: 10, cache: { read: 20 } }, cost: 0.004 } });
			if (String(url).endsWith('/abort')) return Response.json({ ok: true });
			return Response.json({ files: [] });
		}) as typeof fetch;
		const adapter = new OpenCodeExecutionProviderAdapter({ fetchImpl, env: { OPENROUTER_API_KEY: 'brokered-secret', TREESEED_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096' } });
		const result = await adapter.start({ assignment: { id: 'assignment-1' }, agent: { systemPrompt: 'System', cli: {}, execution: {} }, workPackage: { instructions: 'Do the work.' }, capacityEnvelope: { budget: { deadline: '2026-08-06T12:00:00Z' } } } as never);
		expect(result).toMatchObject({ status: 'completed', runId: 'session-1', summary: 'Complete.' });
		expect(result.usage).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: 'input_tokens', amount: 120 }),
			expect.objectContaining({ kind: 'reasoning_tokens', amount: 10 }),
			expect.objectContaining({ kind: 'provider_cost', amount: 0.004 }),
		]));
		await adapter.cancel({ assignmentId: 'assignment-1', runId: 'session-1', reason: 'deadline' });
		expect(requests.some((request) => request.url.endsWith('/session/session-1/abort'))).toBe(true);
		expect(JSON.stringify(requests)).not.toContain('brokered-secret');
	});
});
