import { describe, expect, it } from 'vitest';
import { sandboxAccountingUsage } from '../../../src/provider/execution/microvm-executor.ts';
import { aggregateExecutionUsage } from '../../../src/kernel/provider-kernel-executor.ts';

describe('sandbox accounting usage', () => {
	it('keeps original provenance outside numeric native usage and preserves every measured unit without laundering invalid observations', () => {
		for (const provenance of ['execution-provider', 'unavailable']) {
			const measured = { activeSeconds: 0.125, elapsedSeconds: 0.25, input_tokens: 7, output_tokens: 0,
				cached_input_tokens: 3, reasoning_output_tokens: 0, cpuUserMicros: 19, peakRssBytes: 4096 };
			const raw = { ...measured, provenance }, before = structuredClone(raw), normalized = sandboxAccountingUsage(raw);
			expect(normalized).toEqual({ activeSeconds: 0.125, elapsedSeconds: 0.25, inputTokens: 7, outputTokens: 0,
				cachedInputTokens: 3, reasoningTokens: 0, cpuUserMicros: 19, peakRssBytes: 4096, provenance, nativeUsage: measured });
			expect(aggregateExecutionUsage([normalized])).toEqual(normalized); expect(raw).toEqual(before);
		}
		for (const value of [-1, NaN, Infinity, '7', null]) {
			const raw = { elapsedSeconds: 0.25, provenance: 'execution-provider', input_tokens: value }, before = structuredClone(raw);
			const normalized = sandboxAccountingUsage(raw);
			expect(normalized).not.toHaveProperty('inputTokens'); expect(normalized.nativeUsage).toEqual({ elapsedSeconds: 0.25, input_tokens: value });
			expect(() => aggregateExecutionUsage([normalized])).toThrow('model_native_usage_invalid'); expect(raw).toEqual(before);
		}
	});
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
