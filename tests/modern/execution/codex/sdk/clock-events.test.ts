import type { McpToolCallItem } from '@openai/codex-sdk';
import { expect, it } from 'vitest';
import { clockReading } from '../../../../../src/kernel/handlers/model-workload.ts';

it('validates the SDK native structured_content clock against its original text without rewriting either representation', () => {
	const clock = { startedAt: '2026-10-01T00:00:00.000Z', deadlineAt: '2026-10-01T00:01:00.000Z',
		observedAt: '2026-10-01T00:00:10.000Z', remainingSeconds: 50 };
	const result: NonNullable<McpToolCallItem['result']> = { content: [{ type: 'text', text: JSON.stringify(clock) }], structured_content: clock };
	const original = structuredClone(result);
	expect(clockReading(result)).toEqual(clock);
	result.structured_content = { ...clock, remainingSeconds: 49 };
	expect(clockReading(result)).toBeUndefined();
	expect(result.content).toEqual(original.content);
	expect(result.structured_content).toEqual({ ...clock, remainingSeconds: 49 });
});
