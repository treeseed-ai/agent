import { describe, expect, it } from 'vitest';
import { providerCredentialValues, providerFailureSummary, redactProviderEvents } from '../../../src/sandbox/provider-failure.ts';

describe('provider failure diagnostics', () => {
	it('redacts nested provider tool-output credentials without rewriting raw validation events', () => {
		const secret = 'synthetic-access-token-private';
		const events = [{ type: 'item.completed', item: { type: 'command_execution', command: 'npm run test:contracts',
			aggregated_output: `before ${secret} after`, exit_code: 1, checks: [null, false, 15, { detail: secret }] } }];
		const diagnostic = redactProviderEvents(events, [secret]);
		expect(JSON.stringify(diagnostic)).not.toContain(secret);
		expect(diagnostic).toEqual([{ ...events[0], item: { ...events[0]!.item,
			aggregated_output: 'before [redacted] after', checks: [null, false, 15, { detail: '[redacted]' }] } }]);
		expect(events[0]!.item.aggregated_output).toContain(secret);
	});
	it('preserves clean event evidence, usage and long output without failure-summary truncation', () => {
		const events = [{ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } },
			{ type: 'item.completed', item: { type: 'command_execution', command: 'npm run build', exit_code: 0,
				aggregated_output: 'public evidence\n'.repeat(300), url: 'https://example.test/evidence' } }];
		expect(redactProviderEvents(events, ['synthetic-refresh-token-private'])).toEqual(events);
	});
	it('redacts credential-bearing diagnostic keys and overlapping values longest first', () => {
		const secret = 'synthetic-refresh-token-private';
		const events = [{ [secret]: secret, item: { text: `${secret}: ${secret.slice(0, 20)}` } }];
		expect(redactProviderEvents(events, [secret.slice(0, 20), secret, ''])).toEqual([
			{ '[redacted]': '[redacted]', item: { text: '[redacted]: [redacted]' } },
		]);
	});
	it('removes issued and rotated credentials while retaining failed check disposition', () => {
		const issued = { tokens: { access_token: 'synthetic-issued-access-token', refresh_token: 'synthetic-issued-refresh-token' } };
		const rotated = { tokens: { access_token: 'synthetic-rotated-access-token', refresh_token: 'synthetic-rotated-refresh-token' } };
		const secrets = [...providerCredentialValues(issued), ...providerCredentialValues(rotated)];
		const events = [{ item: { type: 'command_execution', exit_code: 1, aggregated_output: secrets.join('\n') } }];
		const sanitized = redactProviderEvents(events, secrets);
		for (const secret of secrets) expect(JSON.stringify(sanitized)).not.toContain(secret);
		expect(sanitized[0]?.item).toEqual({ type: 'command_execution', exit_code: 1, aggregated_output: secrets.map(() => '[redacted]').join('\n') });
	});
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
