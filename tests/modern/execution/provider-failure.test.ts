import { describe, expect, it } from 'vitest';
import { providerCredentialValues, providerFailureSummary } from '../../../src/sandbox/provider-failure.ts';

describe('provider failure diagnostics', () => {
	it('retains completed error items while excluding adjacent successful response content', () => {
		expect(providerFailureSummary([
			{ type: 'item.completed', item: { type: 'error', message: 'MCP catalog failed: sensitive-token' } },
			{ type: 'item.completed', item: { type: 'agent_message', text: 'private response' } },
		], ['sensitive-token'])).toBe('MCP catalog failed: [redacted]');
	});
	it('retains structured errors when stderr was empty', () => {
		expect(providerFailureSummary([{ type: 'turn.failed', error: { message: 'Required MCP server failed to start.' } }])).toBe('Required MCP server failed to start.');
	});
	it('excludes ordinary prompt, tool and response events', () => {
		expect(providerFailureSummary([{ type: 'item.completed', message: 'private prompt' }, { type: 'error', message: 'Authentication failed.' }])).toBe('Authentication failed.');
	});
	it('redacts nested credentials, authorization and provider URLs', () => {
		const secrets = providerCredentialValues({ tokens: { access_token: 'sensitive-access', refresh_token: 'sensitive-refresh' } });
		const result = providerFailureSummary([{ type: 'error', message: 'sensitive-access sensitive-refresh Bearer something https://user:password@provider.test/path?token=secret sk-secretvalue' }], secrets);
		for (const secret of ['sensitive-access', 'sensitive-refresh', 'something', 'password', 'token=secret', 'sk-secretvalue']) expect(result).not.toContain(secret);
	});
	it('bounds summaries and ignores malformed errors', () => {
		expect(providerFailureSummary([{ type: 'error', message: 'a'.repeat(10_000) }])).toHaveLength(1_024);
		expect(providerFailureSummary([{ type: 'error', error: null }])).toBe('');
	});
});
