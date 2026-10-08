import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { activeSandboxAttempt } from '../../../src/provider/execution/source-workspace.ts';
import { request } from '../kernel/provider-kernel-fixture.ts';

describe('canonical source attempt identity', () => {
  it.each([1, 2, 3, 101])('keeps admitted canonical attempt %i unchanged', ordinal => {
    const attempt = { ...assignmentAttemptSchema.parse(request().assignment.assignmentAttempt), attempt: ordinal }, held = structuredClone(attempt);
    expect(activeSandboxAttempt(attempt)).toBe(ordinal); expect(attempt).toEqual(held);
  });
  it.each([undefined, null, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects malformed counters without defaulting', counter => {
    expect(() => activeSandboxAttempt(counter)).toThrow();
  });
});
