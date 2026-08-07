import { describe, expect, it } from 'vitest';
import {
	AssignmentExecutionProviderSelectionError,
	buildExecutionProviderRuntimeConfiguration,
	resolveAssignmentExecutionProvider,
} from '../../../../../src/provider/capacity/providers/execution-provider-selection.ts';

const providers = [
	{ id: 'codex-primary', adapter: 'codex', nativeLimits: { maxConcurrentRunners: 2 } },
	{ id: 'research-workflow', adapter: 'workflow', nativeLimits: { maxConcurrentRunners: 1 } },
];

describe('assignment execution-provider selection', () => {
	it('resolves an arbitrary provider-global id to its manifest adapter', () => {
		expect(resolveAssignmentExecutionProvider({
			assignment: { executionProviderId: 'codex-primary' },
			executionProviders: providers,
		})).toEqual(providers[0]);
	});

	it('uses the sole configured provider only when the assignment is unambiguous', () => {
		expect(resolveAssignmentExecutionProvider({
			assignment: {},
			executionProviders: [providers[1]!],
		})).toEqual(providers[1]);
	});

	it('fails closed for an unknown provider id', () => {
		expect(() => resolveAssignmentExecutionProvider({
			assignment: { executionProviderId: 'codex-missing' },
			executionProviders: providers,
		})).toThrowError(expect.objectContaining<Partial<AssignmentExecutionProviderSelectionError>>({
			code: 'assignment_execution_provider_not_configured',
		}));
	});

	it('fails closed when multiple providers exist without an assignment id', () => {
		expect(() => resolveAssignmentExecutionProvider({
			assignment: {},
			executionProviders: providers,
		})).toThrowError(expect.objectContaining<Partial<AssignmentExecutionProviderSelectionError>>({
			code: 'assignment_execution_provider_id_required',
		}));
	});

	it('wires the TreeSeed Codex profile to the private appliance gateway', () => {
		const runtime = buildExecutionProviderRuntimeConfiguration({
			executionProvider: {
				id: 'codex-treeseed', adapter: 'codex', profile: 'treeseed', protocol: 'responses',
				model: { baseUrl: 'http://host.docker.internal:4771/v1', model: 'treeseed-qwen3.5-4b' },
				nativeLimits: { maxConcurrentRunners: 1 },
			},
			accessToken: 'provider-token', apiBaseUrl: 'https://api.treeseed.dev',
			env: { TREESEED_AI_GATEWAY_TOKEN: 'inference-token' },
		});
		expect(runtime.env).toMatchObject({
			TREESEED_CODEX_MODEL_PROVIDER: 'treeseed',
			TREESEED_CODEX_BASE_URL: 'http://host.docker.internal:4771/v1',
			TREESEED_CODEX_DEFAULT_MODEL: 'treeseed-qwen3.5-4b',
			OPENAI_API_KEY: 'inference-token',
		});
	});

	it('builds TreeSeed model configuration for Copilot and OpenCode profiles', () => {
		const provider = {
			id: 'ghcopilot-treeseed', adapter: 'copilot', profile: 'treeseed', protocol: 'responses',
			model: { baseUrl: 'http://gateway/v1', model: 'treeseed-qwen3.5-4b' },
			nativeLimits: { maxConcurrentRunners: 1 },
		};
		const runtime = buildExecutionProviderRuntimeConfiguration({ executionProvider: provider, accessToken: 'provider', apiBaseUrl: 'https://api.treeseed.dev', env: { TREESEED_AI_GATEWAY_TOKEN: 'inference' } });
		expect(runtime).toMatchObject({ model: 'treeseed-qwen3.5-4b', openCodeProviderId: 'treeseed', copilotProvider: { type: 'openai', baseUrl: 'http://gateway/v1', apiKey: 'inference', wireApi: 'responses' } });
	});
});
