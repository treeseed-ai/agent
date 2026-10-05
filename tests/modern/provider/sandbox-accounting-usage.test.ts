import { describe, expect, it } from 'vitest';
import { sandboxAccountingUsage } from '../../../src/provider/execution/microvm-executor.ts';

describe('sandbox accounting usage', () => {
	it('maps measured native tokens and retains their exact native evidence', () => {
		const native = { activeSeconds: 54.541, elapsedSeconds: 60, input_tokens: 269333,
			cached_input_tokens: 222208, output_tokens: 1779, reasoning_output_tokens: 391 };
		expect(sandboxAccountingUsage(native)).toEqual({ activeSeconds: 54.541, elapsedSeconds: 60,
			inputTokens: 269333, cachedInputTokens: 222208, outputTokens: 1779, reasoningTokens: 391,
			nativeUsage: native });
		expect(native.input_tokens).toBe(269333);
	});
	it('does not invent missing or invalid measurements', () => {
		const result = sandboxAccountingUsage({ activeSeconds: 2, input_tokens: -1 });
		expect(result).not.toHaveProperty('inputTokens');
		expect(result).not.toHaveProperty('outputTokens');
	});
});
